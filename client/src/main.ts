/**
 * Точка входу: завантаження ресурсів → лобі → гра. Увесь «сценарій» — один async-ланцюжок.
 */
import { ArenaSchema, type ServerMessageOf } from "@dogfight/shared/protocol.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import {
  AssetError,
  type LoadAllResult,
  loadAll,
  loadJson,
  type Manifest,
  ManifestSchema,
  withRetry,
} from "./assets/loader.ts";
import { getAudioContext, registerBuffers, unlockOnGesture } from "./audio.ts";
import { type ExperimentConfig, readExperiment } from "./experiments.ts";
import { type LocalGame, startGame } from "./game.ts";
import { type JoinIntent, Lobby } from "./lobby/lobby.ts";
import { mountLobbyView } from "./lobby/view.ts";
import { mountRoomUi } from "./net/chat-view.ts";
import { Connection } from "./net/connection.ts";
import { type OnlineGame, startOnlineGame } from "./online.ts";
import { type PerfSummary, perfSummary } from "./perf.ts";
import { setupCanvas } from "./render/canvas.ts";
import { setSprites } from "./render/draw.ts";
import { type Choice, createLoadingScreen, type LoadingScreen } from "./render/loading.ts";
import { createSprites } from "./render/sprites.ts";

/** Ручки для DevTools, Playwright і заміряв у README. */
interface LabHandle {
  config: ExperimentConfig;
  loadMs?: number;
  failures?: string[];
  lobby?: Lobby;
  conn?: Connection;
  welcome?: ServerMessageOf<"welcome">;
  playerId?: number;
  game?: LocalGame | OnlineGame;
  perf?: (reset?: boolean) => PerfSummary;
}

declare global {
  interface Window {
    __lab: LabHandle;
  }
}

const config = readExperiment();
const params = new URLSearchParams(location.search);
const canvas = document.getElementById("game");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#game canvas is missing");
const view = setupCanvas(canvas, createArena());
window.__lab = { config, perf: perfSummary };

/** Навмисні збої для «галереї відмов» (README, Лаба 3). */
function injectFailures(manifest: Manifest, mode: string | null): Manifest {
  const items = manifest.items.map((i) => {
    if (mode === "404" && i.id === "sheet")
      return { ...i, url: "/assets/sprites/missing-sheet.png" };
    if (mode === "json" && i.id === "atlas") return { ...i, url: "/__test/corrupt.json" };
    return i;
  });
  if (mode === "timeout") items.push({ id: "map.hang", type: "json", url: "/__test/hang" });
  return { ...manifest, items };
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : "Error");
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function loadAssets(screen: LoadingScreen): Promise<LoadAllResult> {
  const audioCtx = getAudioContext();
  let manifest = await withRetry(() => loadJson("/assets/manifest.json", ManifestSchema), {
    attempts: 3,
  });
  manifest = injectFailures(manifest, params.get("fail"));

  for (;;) {
    const controller = new AbortController();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") controller.abort(new DOMException("user pressed Esc", "AbortError"));
    };
    window.addEventListener("keydown", onKey);
    const autoAbort =
      params.get("fail") === "abort"
        ? setTimeout(() => controller.abort(new DOMException("test abort", "AbortError")), 400)
        : undefined;

    Object.assign(screen.state, { done: 0, total: manifest.items.length, error: null });
    const t0 = performance.now();
    try {
      const result = await loadAll(manifest, {
        audioCtx,
        signal: controller.signal,
        timeoutMs: params.get("fail") === "timeout" ? 1500 : 8000,
        sequential: params.has("seq"),
        onProgress: ({ done, total, item, ok, error }) => {
          Object.assign(screen.state, { done, total, current: item.id });
          if (!ok) {
            const skipped = item.optional && errorName(error) !== "AbortError";
            screen.log(
              `✘ ${item.id}: ${errorMessage(error)}${skipped ? " (необов'язковий — пропускаю)" : ""}`,
            );
          }
        },
        onRetry: ({ item, attempt, delay, error }) =>
          screen.log(
            `↻ ${item.id}: спроба ${attempt} невдала (${errorName(error)}), повтор через ${Math.round(delay)} мс`,
          ),
      });
      const ms = performance.now() - t0;
      window.__lab.loadMs = ms;
      screen.log(
        `✔ ${manifest.items.length} ресурсів за ${ms.toFixed(0)} мс (${params.has("seq") ? "послідовно" : "Promise.all"})`,
      );
      return result;
    } catch (err: unknown) {
      const aborted = controller.signal.aborted;
      const assetId = err instanceof AssetError ? err.assetId : "manifest";
      const message =
        err instanceof AssetError && err.cause instanceof Error && err.cause.name === "TimeoutError"
          ? "таймаут"
          : errorMessage(err);
      screen.state.error = aborted
        ? "Завантаження скасовано"
        : `Не вдалося завантажити «${assetId}»: ${message}`;
      screen.log(screen.state.error);
      const choices: Choice<"retry" | "skip">[] = [
        { id: "retry", label: aborted ? "Почати знову" : "Повторити" },
      ];
      if (!aborted) choices.push({ id: "skip", label: "Продовжити без нього" });
      const choice = await screen.ask(choices);
      if (choice === "skip") {
        manifest = {
          ...manifest,
          items: manifest.items.map((i) => (i.id === assetId ? { ...i, optional: true } : i)),
        };
      }
    } finally {
      window.removeEventListener("keydown", onKey);
      clearTimeout(autoAbort);
    }
  }
}

/** welcome або фатальне закриття (кімната повна, немає кімнати) — що станеться першим. */
function waitForWelcome(conn: Connection): Promise<ServerMessageOf<"welcome">> {
  return new Promise((resolve, reject) => {
    const offWelcome = conn.on("welcome", (msg) => {
      cleanup();
      resolve(msg);
    });
    const offClose = conn.on("close", (info) => {
      if (info.willRetry) return;
      cleanup();
      reject(new Error(`сервер закрив з'єднання: ${info.reason || info.code}`));
    });
    const cleanup = (): void => {
      offWelcome();
      offClose();
    };
  });
}

type Join =
  | (JoinIntent & { online: true })
  | { online: false; arena: JoinIntent["arena"]; name: string };

async function chooseRoom(lobby: Lobby): Promise<Join> {
  if (params.has("offline")) {
    const arena = await loadJson(
      `/assets/arenas/${params.get("arena") ?? "classic"}.json`,
      ArenaSchema,
    );
    return { online: false, arena, name: params.get("name") ?? "you" };
  }
  const roomId = params.get("room");
  if (roomId) {
    const joined = lobby.waitForJoin();
    await lobby.refresh();
    await lobby.join(roomId, params.get("name") ?? "pilot");
    return { ...(await joined), online: true };
  }
  mountLobbyView(lobby);
  lobby.start();
  return { ...(await lobby.waitForJoin()), online: true };
}

async function boot(): Promise<void> {
  unlockOnGesture();
  const screen = createLoadingScreen(view);
  screen.start();
  const { assets, failures } = await loadAssets(screen);
  window.__lab.failures = failures.map((f) => `${f.id}: ${errorMessage(f.error)}`);
  registerBuffers(assets);
  setSprites(createSprites(assets.get("sheet"), assets.get("atlas")));
  if (!params.has("fast")) await new Promise((r) => setTimeout(r, 600));
  screen.stop();

  const lobby = new Lobby({ roomsUrl: "/api/rooms" });
  window.__lab.lobby = lobby;
  const join = await chooseRoom(lobby);

  if (!join.online) {
    window.__lab.game = startGame({ view, arenaConfig: join.arena, name: join.name, config });
    canvas?.focus();
    return;
  }

  const conn = new Connection(Connection.defaultUrl());
  window.__lab.conn = conn;
  const codec = params.get("codec") === "json" ? "json" : "binary";
  // join на КОЖНЕ відкриття — і після автоматичного перепідключення
  conn.on("open", () => conn.send({ type: "join", room: join.room.id, name: join.name, codec }));
  const ui = mountRoomUi(conn, { roomName: join.room.name, myId: null });
  conn.on("welcome", (w) => ui.setMyId(w.playerId));
  conn.connect();
  const welcome = await waitForWelcome(conn).catch((err: unknown) => {
    ui.destroy();
    throw err;
  });
  window.__lab.playerId = welcome.playerId;
  window.__lab.welcome = welcome;
  window.__lab.game = startOnlineGame({ view, conn, welcome, config, params });
  canvas?.focus();
}

/** PWA (Лаба 8): service worker лише у production-збірці — у dev він заважав би HMR. */
if (import.meta.env.PROD && "serviceWorker" in navigator && !params.has("nosw")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
      console.warn("[pwa] service worker registration failed:", errorMessage(err));
    });
  });
}

boot().catch((err: unknown) => {
  console.error(err);
  const p = document.createElement("p");
  p.style.cssText =
    "position:fixed;inset:auto 0 40% 0;text-align:center;color:#ff8a8a;font:16px monospace";
  p.textContent = `Помилка запуску: ${errorMessage(err)}`;
  document.body.append(p);
});
