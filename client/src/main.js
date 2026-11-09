/**
 * Точка входу: завантаження ресурсів → лобі → гра. Увесь «сценарій» — один async-ланцюжок.
 */
import { loadAll, loadJson, withRetry } from "./assets/loader.js";
import { getAudioContext, registerBuffers, unlockOnGesture } from "./audio.js";
import { readExperiment } from "./experiments.js";
import { startGame } from "./game.js";
import { Lobby } from "./lobby/lobby.js";
import { mountLobbyView } from "./lobby/view.js";
import { mountRoomUi } from "./net/chat-view.js";
import { Connection } from "./net/connection.js";
import { setupCanvas } from "./render/canvas.js";
import { setSprites } from "./render/draw.js";
import { createLoadingScreen } from "./render/loading.js";
import { createSprites } from "./render/sprites.js";
import { createArena } from "./sim/arena.js";

const config = readExperiment();
const params = new URLSearchParams(location.search);
const canvas = document.getElementById("game");
const view = setupCanvas(canvas, createArena());
window.__lab = { config };

/**
 * Навмисні збої для «галереї відмов» (README, Лаба 3):
 *   ?fail=404     — обов'язковий спрайт-аркуш не існує
 *   ?fail=timeout — обов'язковий ресурс «висить» (сервер не відповідає)
 *   ?fail=abort   — завантаження скасовується через 400 мс (так само, як Esc)
 *   ?fail=json    — атлас спрайтів — зіпсований JSON
 */
function injectFailures(manifest, mode) {
  const items = manifest.items.map((i) => ({ ...i }));
  const byId = (id) => items.find((i) => i.id === id);
  if (mode === "404") byId("sheet").url = "/assets/sprites/missing-sheet.png";
  if (mode === "json") byId("atlas").url = "/__test/corrupt.json";
  if (mode === "timeout") items.push({ id: "map.hang", type: "json", url: "/__test/hang" });
  return { ...manifest, items };
}

async function loadAssets(screen) {
  const audioCtx = getAudioContext();
  let manifest = await withRetry(() => loadJson("/assets/manifest.json"), { attempts: 3 });
  manifest = injectFailures(manifest, params.get("fail"));

  for (;;) {
    const controller = new AbortController();
    const onKey = (e) => {
      if (e.key === "Escape") controller.abort(new DOMException("user pressed Esc", "AbortError"));
    };
    window.addEventListener("keydown", onKey);
    const autoAbort =
      params.get("fail") === "abort"
        ? setTimeout(() => controller.abort(new DOMException("test abort", "AbortError")), 400)
        : 0;

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
          if (!ok)
            screen.log(
              `✘ ${item.id}: ${error.message}${item.optional && error.name !== "AbortError" ? " (необов'язковий — пропускаю)" : ""}`,
            );
        },
        onRetry: ({ item, attempt, delay, error }) =>
          screen.log(
            `↻ ${item.id}: спроба ${attempt} невдала (${error.name}), повтор через ${Math.round(delay)} мс`,
          ),
      });
      const ms = performance.now() - t0;
      window.__lab.loadMs = ms;
      screen.log(
        `✔ ${manifest.items.length} ресурсів за ${ms.toFixed(0)} мс (${params.has("seq") ? "послідовно" : "Promise.all"})`,
      );
      return result;
    } catch (err) {
      const aborted = controller.signal.aborted;
      screen.state.error = aborted
        ? "Завантаження скасовано"
        : `Не вдалося завантажити «${err.assetId ?? "manifest"}»: ${err.name === "TimeoutError" ? "таймаут" : err.message}`;
      screen.log(screen.state.error);
      const choice = await screen.ask([
        { id: "retry", label: aborted ? "Почати знову" : "Повторити" },
        ...(aborted ? [] : [{ id: "skip", label: "Продовжити без нього" }]),
      ]);
      if (choice === "skip") {
        // Деградація: позначаємо ресурс необов'язковим. Без аркуша/атласу гра малює вектори.
        const failed = err.assetId;
        manifest = {
          ...manifest,
          items: manifest.items.map((i) => (i.id === failed ? { ...i, optional: true } : i)),
        };
      }
    } finally {
      window.removeEventListener("keydown", onKey);
      clearTimeout(autoAbort);
    }
  }
}

async function boot() {
  unlockOnGesture();
  const screen = createLoadingScreen(view);
  screen.start();
  const { assets, failures } = await loadAssets(screen);
  window.__lab.failures = failures.map((f) => `${f.id}: ${f.error.message}`);
  registerBuffers(assets);
  setSprites(createSprites(assets.get("sheet"), assets.get("atlas")));
  // Невелика пауза, щоб було видно 100% і журнал (у тестах можна пропустити)
  if (!params.has("fast")) await new Promise((r) => setTimeout(r, 600));
  screen.stop();

  // ---- лобі ----
  const lobby = new Lobby({ roomsUrl: "/api/rooms" });
  window.__lab.lobby = lobby;
  let join;
  if (params.has("offline")) {
    // Без сервера (як у Лабі 3): ?offline&arena=classic
    const arena = await loadJson(`/assets/arenas/${params.get("arena") ?? "classic"}.json`);
    join = { arena, name: params.get("name") ?? "you", room: null };
  } else if (params.has("room")) {
    // Пряме посилання на кімнату: ?room=alpha&name=Ann (зручно для тестів і захисту)
    const joined = lobby.waitForJoin();
    await lobby.refresh();
    await lobby.join(params.get("room"), params.get("name") ?? "pilot");
    join = await joined;
  } else {
    mountLobbyView(lobby);
    lobby.start();
    join = await lobby.waitForJoin();
  }

  // ---- з'єднання з кімнатою (Лаба 4): склад і чат; симуляція поки що локальна ----
  if (join.room) {
    const conn = new Connection(Connection.defaultUrl());
    window.__lab.conn = conn;
    // join відправляється на КОЖНЕ відкриття — і після автоматичного перепідключення
    conn.addEventListener("open", () =>
      conn.send({ type: "join", room: join.room.id, name: join.name }),
    );
    // UI підписується ДО підключення — щоб не пропустити перший roster
    const ui = mountRoomUi(conn, { roomName: join.room.name, myId: null });
    conn.on("welcome", (w) => ui.setMyId(w.playerId));
    conn.connect();
    const welcome = await waitForWelcome(conn).catch((err) => {
      ui.destroy();
      throw err;
    });
    window.__lab.playerId = welcome.playerId;
  }

  const game = startGame({ view, arenaConfig: join.arena, name: join.name, config });
  Object.assign(window.__lab, game);
  canvas.focus();
}

/** welcome або фатальне закриття (кімната повна, немає кімнати) — що станеться першим. */
function waitForWelcome(conn) {
  return new Promise((resolve, reject) => {
    const off = conn.on("welcome", (msg) => {
      cleanup();
      resolve(msg);
    });
    const onClose = (e) => {
      if (e.detail.willRetry) return;
      cleanup();
      reject(new Error(`сервер закрив з'єднання: ${e.detail.reason || e.detail.code}`));
    };
    const cleanup = () => {
      off();
      conn.removeEventListener("close", onClose);
    };
    conn.addEventListener("close", onClose);
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<p style="position:fixed;inset:auto 0 40% 0;text-align:center;color:#ff8a8a;font:16px monospace">Помилка запуску: ${String(err.message).replace(/</g, "&lt;")}</p>`,
  );
});
