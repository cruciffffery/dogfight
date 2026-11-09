/**
 * Протокол v1. Спільний для клієнта й сервера (працює і в браузері, і в Node — без Buffer).
 *
 * Текстові кадри (завжди JSON):
 *   Клієнт → сервер:
 *     { v, type: "join",  room, name, codec?: "json" | "binary" }
 *     { v, type: "chat",  text }
 *     { v, type: "ping",  t }                      — RTT для netgraph
 *     { v, type: "leave" }
 *     { v, type: "input", seq, cmds: Command[] }    — лише з codec "json"
 *   Сервер → клієнт:
 *     { v, type: "welcome",  playerId, shipId, room, arena, tickRate, codec }
 *     { v, type: "roster",   players: [{ id, name, shipId, skin }] }
 *     { v, type: "chat",     from, name, text, t }
 *     { v, type: "pong",     t }
 *     { v, type: "error",    code, message }
 *     { v, type: "shutdown" }
 *     { v, type: "snapshot", … }                    — лише з codec "json"
 *
 * Бінарні кадри (codec "binary", специфікація — docs/protocol.md):
 *   0x01 input, 0x10 snapshot
 *
 * Command = { turn: -1 | 0 | 1, thrust: boolean, brake: boolean, fire: boolean }
 */
export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Скільки останніх команд дублюється в кожному повідомленні input (захист від втрат). */
export const INPUT_REDUNDANCY = 3;

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
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ProtocolError extends Error {
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

/** Перевірка однієї команди керування. */
export function validateCommand(c) {
  if (!isPlainObject(c)) throw new ProtocolError("command must be an object");
  onlyKeys(c, ["turn", "thrust", "brake", "fire"]);
  if (c.turn !== -1 && c.turn !== 0 && c.turn !== 1) throw new ProtocolError("turn ∈ {-1,0,1}");
  for (const k of ["thrust", "brake", "fire"]) {
    if (typeof c[k] !== "boolean") throw new ProtocolError(`${k} must be boolean`);
  }
  return { turn: c.turn, thrust: c.thrust, brake: c.brake, fire: c.fire };
}

export function validateInput(seq, cmds) {
  if (!Number.isInteger(seq) || seq < 1 || seq > 0xffffffff) throw new ProtocolError("bad seq");
  if (!Array.isArray(cmds) || cmds.length < 1 || cmds.length > INPUT_REDUNDANCY) {
    throw new ProtocolError(`cmds: 1..${INPUT_REDUNDANCY} commands`);
  }
  return { type: "input", seq, cmds: cmds.map(validateCommand) };
}

const validators = {
  join(m) {
    onlyKeys(m, ["v", "type", "room", "name", "codec"]);
    if (typeof m.room !== "string" || !ROOM_RE.test(m.room)) throw new ProtocolError("bad room");
    if (typeof m.name !== "string" || !NAME_RE.test(m.name.trim())) {
      throw new ProtocolError("bad name");
    }
    const codec = m.codec ?? "binary";
    if (codec !== "json" && codec !== "binary") throw new ProtocolError("bad codec");
    return { type: "join", room: m.room, name: m.name.trim(), codec };
  },
  chat(m) {
    onlyKeys(m, ["v", "type", "text"]);
    if (typeof m.text !== "string") throw new ProtocolError("chat.text must be a string");
    const text = m.text.trim();
    if (text.length === 0 || text.length > 200) throw new ProtocolError("chat.text length");
    return { type: "chat", text };
  },
  ping(m) {
    onlyKeys(m, ["v", "type", "t"]);
    if (typeof m.t !== "number" || !Number.isFinite(m.t)) throw new ProtocolError("ping.t");
    return { type: "ping", t: m.t };
  },
  input(m) {
    onlyKeys(m, ["v", "type", "seq", "cmds"]);
    return validateInput(m.seq, m.cmds);
  },
  leave(m) {
    onlyKeys(m, ["v", "type"]);
    return { type: "leave" };
  },
};

/**
 * Розбирає ТЕКСТОВИЙ кадр від клієнта. Повертає { ok: true, msg } або { ok: false, error }.
 * Ніколи не кидає — некоректне повідомлення не має права покласти сервер.
 */
export function parseClientMessage(raw, { maxBytes = 4096 } = {}) {
  try {
    const bytes = typeof raw === "string" ? encoder.encode(raw) : new Uint8Array(raw);
    if (bytes.byteLength > maxBytes) throw new ProtocolError("message too large");
    const m = JSON.parse(typeof raw === "string" ? raw : decoder.decode(bytes));
    if (!isPlainObject(m)) throw new ProtocolError("message must be an object");
    if (m.v !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version ${m.v}`);
    const validate = Object.hasOwn(validators, m.type) ? validators[m.type] : null;
    if (!validate) throw new ProtocolError(`unknown type "${String(m.type).slice(0, 32)}"`);
    return { ok: true, msg: validate(m) };
  } catch (err) {
    return { ok: false, error: err instanceof SyntaxError ? "invalid JSON" : err.message };
  }
}

/** Текстове повідомлення сервера — версія додається автоматично. */
export function encode(type, payload = {}) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, ...payload });
}
