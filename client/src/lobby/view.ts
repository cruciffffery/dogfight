import { $ } from "../ui/dom.ts";
import type { Lobby } from "./lobby.ts";

/**
 * DOM-рендер лобі. Модель (Lobby) нічого не знає про цей файл —
 * view лише слухає її події й викликає її методи.
 */
const STYLE = `
.lobby { position: fixed; inset: 0; display: grid; place-items: center; font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #cfe0ff; background: rgba(5,7,13,.78); }
.lobby .card { width: min(520px, calc(100vw - 32px)); background: #0d1424; border: 1px solid #22305a; border-radius: 12px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.lobby h1 { margin: 0 0 4px; font-size: 22px; color: #e8edf7; letter-spacing: .5px; }
.lobby p { margin: 0 0 14px; color: #8fa3cc; }
.lobby label { display: block; margin-bottom: 14px; }
.lobby input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 9px 10px; border-radius: 8px; border: 1px solid #2c3d6e; background: #070b15; color: #e8edf7; font: inherit; }
.lobby ul { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 8px; }
.lobby li button { width: 100%; display: flex; justify-content: space-between; gap: 12px; padding: 11px 12px; border-radius: 8px; border: 1px solid #2c3d6e; background: #111b33; color: #e8edf7; font: inherit; cursor: pointer; text-align: left; }
.lobby li button:hover:not(:disabled) { border-color: #7fa2ff; background: #16244a; }
.lobby li button:disabled { opacity: .5; cursor: not-allowed; }
.lobby .status { min-height: 1.4em; font-size: 13px; color: #8fa3cc; }
.lobby .status.err { color: #ff8a8a; }
.lobby form.create { display: flex; gap: 8px; margin-bottom: 10px; }
.lobby form.create input { margin: 0; flex: 1; }
.lobby form.create select, .lobby form.create button { padding: 8px 10px; border-radius: 8px; border: 1px solid #2c3d6e; background: #111b33; color: #e8edf7; font: inherit; }
.lobby form.create button { cursor: pointer; }
.lobby .retry { margin-left: 8px; padding: 3px 10px; border-radius: 6px; border: 1px solid #ff8a8a; background: none; color: #ff8a8a; font: inherit; cursor: pointer; }
`;

export interface LobbyView {
  destroy(): void;
  setStatus(text: string, isError?: boolean): void;
}

export function mountLobbyView(lobby: Lobby, root: HTMLElement = document.body): LobbyView {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const el = document.createElement("div");
  el.className = "lobby";
  el.innerHTML = `
    <div class="card" role="dialog" aria-label="Лобі">
      <h1>dogfight</h1>
      <p>Обери ім'я та кімнату.</p>
      <label>Ім'я пілота <input name="name" maxlength="16" autocomplete="nickname"></label>
      <ul class="rooms" aria-live="polite"></ul>
      <form class="create">
        <input name="room" maxlength="32" placeholder="Нова кімната" required>
        <select name="arena"><option>classic</option><option>rockfield</option><option>duel</option></select>
        <button>Створити</button>
      </form>
      <div class="status"></div>
    </div>`;
  root.append(style, el);

  const nameInput = $(el, "input[name=name]", HTMLInputElement);
  const list = $(el, ".rooms", HTMLUListElement);
  const status = $(el, ".status", HTMLDivElement);
  const form = $(el, "form.create", HTMLFormElement);
  nameInput.value = loadName();
  nameInput.addEventListener("input", () => saveName(nameInput.value));

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("err", isError);
  };

  const subs = new AbortController(); // одна відписка від усіх подій
  const opts = { signal: subs.signal };

  lobby.on(
    "loading",
    () => {
      if (!lobby.rooms.length) setStatus("Завантажую кімнати…");
    },
    opts,
  );
  lobby.on(
    "rooms",
    (rooms) => {
      list.replaceChildren(
        ...rooms.map((room) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.disabled = room.players >= room.maxPlayers;
          const title = document.createElement("span");
          title.textContent = room.name; // textContent — без HTML-ін'єкцій з сервера
          const count = document.createElement("span");
          count.textContent = `${room.players}/${room.maxPlayers}`;
          btn.append(title, count);
          btn.addEventListener("click", () => {
            setStatus(`Підключаюсь до «${room.name}»…`);
            void lobby.join(room.id, nameInput.value.trim() || "pilot");
          });
          li.append(btn);
          return li;
        }),
      );
      setStatus(`Оновлено ${new Date().toLocaleTimeString()} · автооновлення кожні 5 с`);
    },
    opts,
  );
  lobby.on(
    "error",
    (err) => {
      const why = err.name === "TimeoutError" ? "сервер не відповів за 3 с" : err.message;
      setStatus(`Не вдалося завантажити: ${why}`, true);
      const retry = document.createElement("button");
      retry.className = "retry";
      retry.textContent = "Повторити";
      retry.addEventListener("click", () => void lobby.refresh());
      status.append(retry);
    },
    opts,
  );
  lobby.on("left", () => destroy(), opts);

  function destroy(): void {
    subs.abort();
    el.remove();
    style.remove();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    lobby
      .createRoom(String(data.get("room")), String(data.get("arena")))
      .then((room) => {
        setStatus(`Кімнату «${room.name}» створено`);
        form.reset();
      })
      .catch((err: unknown) => {
        setStatus(`Не вдалося створити: ${err instanceof Error ? err.message : String(err)}`, true);
      });
  });

  nameInput.focus();
  return { destroy, setStatus };
}

function loadName(): string {
  try {
    return localStorage.getItem("dogfight.name") ?? "";
  } catch {
    return "";
  }
}

function saveName(v: string): void {
  try {
    localStorage.setItem("dogfight.name", v);
  } catch {
    /* приватний режим — не страшно */
  }
}
