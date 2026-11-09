/**
 * Протокол v0 — JSON-повідомлення поверх WebSocket.
 *
 * Сервер перевіряє ФОРМУ кожного вхідного повідомлення, навіть якщо клієнт написали ми:
 * по той бік сокета може бути будь-хто (curl, бот, змінений клієнт у DevTools).
 *
 * Клієнт → сервер:
 *   { v: 0, type: "join", room: string, name: string }
 *   { v: 0, type: "chat", text: string }
 *   { v: 0, type: "leave" }
 * Сервер → клієнт:
 *   { v, type: "welcome", playerId, room: { id, name, arena } }
 *   { v, type: "roster",  players: [{ id, name }] }
 *   { v, type: "chat",    from, name, text, t }
 *   { v, type: "error",   code, message }
 *   { v, type: "shutdown" }
 */
export const PROTOCOL_VERSION = 0;

/** Коди закриття WebSocket (4000–4999 — для застосунку). */
export const CLOSE = Object.freeze({
  SHUTDOWN: 1001,
  TOO_BIG: 1009,
  JOIN_TIMEOUT: 4000,
  BAD_MESSAGE: 4001,
  RATE_LIMITED: 4002,
  ROOM_FULL: 4003,
  SERVER_FULL: 4004,
  SLOW_CLIENT: 4005,
  NO_ROOM: 4006,
  HEARTBEAT: 4008,
});

const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;
const ROOM_RE = /^[a-z0-9-]{1,32}$/;

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isPlainObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function onlyKeys(obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ProtocolError(`unexpected field "${k}"`);
  }
}

const validators = {
  join(m) {
    onlyKeys(m, ["v", "type", "room", "name"]);
    if (typeof m.room !== "string" || !ROOM_RE.test(m.room)) throw new ProtocolError("bad room");
    if (typeof m.name !== "string" || !NAME_RE.test(m.name.trim())) {
      throw new ProtocolError("bad name");
    }
    return { type: "join", room: m.room, name: m.name.trim() };
  },
  chat(m) {
    onlyKeys(m, ["v", "type", "text"]);
    if (typeof m.text !== "string") throw new ProtocolError("chat.text must be a string");
    const text = m.text.trim();
    if (text.length === 0 || text.length > 200) throw new ProtocolError("chat.text length");
    return { type: "chat", text };
  },
  leave(m) {
    onlyKeys(m, ["v", "type"]);
    return { type: "leave" };
  },
};

/**
 * Розбирає сирі дані з сокета. Повертає { ok: true, msg } або { ok: false, error }.
 * Ніколи не кидає — некоректне повідомлення не має права покласти сервер.
 */
export function parseClientMessage(raw, { maxBytes = 4096 } = {}) {
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new ProtocolError("message too large");
    const m = JSON.parse(text);
    if (!isPlainObject(m)) throw new ProtocolError("message must be an object");
    if (m.v !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version ${m.v}`);
    const validate = Object.hasOwn(validators, m.type) ? validators[m.type] : null;
    if (!validate) throw new ProtocolError(`unknown type "${String(m.type).slice(0, 32)}"`);
    return { ok: true, msg: validate(m) };
  } catch (err) {
    return { ok: false, error: err instanceof SyntaxError ? "invalid JSON" : err.message };
  }
}

/** Повідомлення сервера завжди проходять через цю функцію — версія додається автоматично. */
export function encode(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}
