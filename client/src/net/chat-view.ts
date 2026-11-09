import { $ } from "../ui/dom.ts";
import type { Connection } from "./connection.ts";

/**
 * Склад кімнати + чат поверх гри. Enter — написати/надіслати, Esc — повернутись до гри.
 */
const STYLE = `
.room-ui { position: fixed; left: 14px; bottom: 14px; width: min(340px, calc(100vw - 28px)); font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #cfe0ff; pointer-events: none; }
.room-ui .box { background: rgba(5,7,13,.72); border: 1px solid #22305a; border-radius: 8px; padding: 8px 10px; margin-top: 6px; }
.room-ui .roster b { color: #ffe27a; font-weight: 600; }
.room-ui .msgs { max-height: 140px; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
.room-ui .msgs div { overflow-wrap: anywhere; }
.room-ui .sys { color: #8fa3cc; }
.room-ui input { pointer-events: auto; width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid #2c3d6e; background: #070b15; color: #e8edf7; font: inherit; display: none; }
.room-ui.typing input { display: block; }
.room-ui .status { color: #ffb020; }
`;

export interface RoomUi {
  setMyId(id: number): void;
  destroy(): void;
}

export function mountRoomUi(
  conn: Connection,
  { roomName, myId }: { roomName: string; myId: number | null },
): RoomUi {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const el = document.createElement("div");
  el.className = "room-ui";
  el.innerHTML = `
    <div class="box"><div class="title"></div><div class="roster"></div><div class="status"></div></div>
    <div class="box"><div class="msgs" aria-live="polite"></div><input maxlength="200" placeholder="Повідомлення… (Enter)"></div>`;
  document.body.append(style, el);
  $(el, ".title", HTMLDivElement).textContent = `Кімната: ${roomName} · Enter — чат`;
  const rosterEl = $(el, ".roster", HTMLDivElement);
  const msgs = $(el, ".msgs", HTMLDivElement);
  const input = $(el, "input", HTMLInputElement);
  const status = $(el, ".status", HTMLDivElement);
  let me: number | null = myId;

  const add = (text: string, cls?: string): void => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text; // textContent: чужий текст ніколи не стає HTML
    msgs.append(line);
    while (msgs.childElementCount > 8) msgs.firstElementChild?.remove();
  };

  const offs = [
    conn.on("roster", ({ players }) => {
      rosterEl.replaceChildren(
        ...players.map((p, i) => {
          const span = document.createElement(p.id === me ? "b" : "span");
          span.textContent = `${i ? ", " : "Гравці: "}${p.name}`;
          return span;
        }),
      );
    }),
    conn.on("chat", ({ name, text }) => add(`${name}: ${text}`)),
    conn.on("shutdown", () => add("Сервер перезапускається…", "sys")),
    conn.on("close", ({ code, willRetry, delay }) => {
      status.textContent = willRetry
        ? `З'єднання втрачено (${code}). Повтор через ${(delay / 1000).toFixed(1)} с…`
        : `Від'єднано (${code})`;
    }),
    conn.on("open", () => {
      status.textContent = "";
    }),
  ];

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      if (document.activeElement === input) {
        const text = input.value.trim();
        if (text) conn.send({ type: "chat", text });
        input.value = "";
        input.blur();
        el.classList.remove("typing");
      } else {
        el.classList.add("typing");
        input.focus();
      }
      e.preventDefault();
    } else if (e.key === "Escape" && document.activeElement === input) {
      input.blur();
      el.classList.remove("typing");
    }
  }
  window.addEventListener("keydown", onKey);

  return {
    setMyId(id) {
      me = id;
    },
    destroy() {
      for (const off of offs) off();
      window.removeEventListener("keydown", onKey);
      el.remove();
      style.remove();
    },
  };
}
