/**
 * Бінарний кодек на DataView. Специфікація — docs/protocol.md.
 *
 * Порядок байтів — LITTLE-ENDIAN скрізь і явно (третій аргумент DataView = true).
 * Типізований масив (Float32Array) пише в порядку байтів МАШИНИ, а мережевий протокол
 * мусить мати один порядок для всіх — тому тут лише DataView.
 */
import { KIND, PROTOCOL_VERSION_BINARY } from "./constants.js";

export const MSG = Object.freeze({ input: 0x01, snapshot: 0x10 });
export { PROTOCOL_VERSION_BINARY };

const LE = true;
const ANGLE_SCALE = 1000; // кут у тисячних радіана в Int16

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}

function u8(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new CodecError(`${what} out of Uint8: ${v}`);
  return v;
}
function u16(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new CodecError(`${what} out of Uint16: ${v}`);
  }
  return v;
}
function u32(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new CodecError(`${what} out of Uint32: ${v}`);
  }
  return v;
}
function f32(v, what) {
  if (!Number.isFinite(v)) throw new CodecError(`${what} is not finite`);
  return v;
}
function angle16(a) {
  const q = Math.round(f32(a, "angle") * ANGLE_SCALE);
  return Math.max(-32768, Math.min(32767, q));
}

// ---------------- розміри ----------------
const HEADER = 14; // type u8, tick u32, version u8, ack u32, nEnt u16, nEv u8, nScore u8
const ENTITY_BASE = 13; // id u16, kind u8, x f32, y f32, angle i16
const EXTRA = { [KIND.ship]: 11, [KIND.bullet]: 5, [KIND.asteroid]: 3, [KIND.pickup]: 1 };
const EVENT_SIZE = 13; // type u8, x f32, y f32, a u16, b u16
const SCORE_SIZE = 6; // shipId u16, score u32

export function snapshotSize(snap) {
  let size = HEADER;
  for (const e of snap.entities) {
    const extra = EXTRA[e.kind];
    if (extra === undefined) throw new CodecError(`unknown kind ${e.kind}`);
    size += ENTITY_BASE + extra;
  }
  return size + snap.events.length * EVENT_SIZE + snap.scores.length * SCORE_SIZE;
}

export function encodeSnapshot(snap) {
  if (snap.entities.length > 0xffff) throw new CodecError("too many entities");
  const events = snap.events.slice(0, 0xff); // подій у тіку більше 255 не буває; обрізаємо явно
  const scores = snap.scores.slice(0, 0xff);
  const body = { ...snap, events, scores };
  const buf = new ArrayBuffer(snapshotSize(body));
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, MSG.snapshot);
  o += 1;
  dv.setUint32(o, u32(snap.tick, "tick"), LE);
  o += 4;
  dv.setUint8(o, PROTOCOL_VERSION_BINARY);
  o += 1;
  dv.setUint32(o, u32(snap.ack, "ack"), LE);
  o += 4;
  dv.setUint16(o, snap.entities.length, LE);
  o += 2;
  dv.setUint8(o, events.length);
  o += 1;
  dv.setUint8(o, scores.length);
  o += 1;

  for (const e of snap.entities) {
    dv.setUint16(o, u16(e.id, "id"), LE);
    dv.setUint8(o + 2, u8(e.kind, "kind"));
    dv.setFloat32(o + 3, f32(e.x, "x"), LE);
    dv.setFloat32(o + 7, f32(e.y, "y"), LE);
    dv.setInt16(o + 11, angle16(e.angle), LE);
    o += ENTITY_BASE;
    switch (e.kind) {
      case KIND.ship:
        dv.setFloat32(o, f32(e.vx, "vx"), LE);
        dv.setFloat32(o + 4, f32(e.vy, "vy"), LE);
        dv.setUint8(o + 8, u8(Math.round(e.hp), "hp"));
        dv.setUint8(o + 9, u8(e.flags, "flags"));
        dv.setUint8(o + 10, u8(e.skin, "skin"));
        break;
      case KIND.bullet:
        dv.setUint16(o, u16(e.owner, "owner"), LE);
        dv.setUint16(o + 2, u16(e.seq, "seq"), LE);
        dv.setUint8(o + 4, e.homing ? 1 : 0);
        break;
      case KIND.asteroid:
        dv.setUint8(o, u8(e.radius, "radius"));
        dv.setUint8(o + 1, u8(e.variant, "variant"));
        dv.setUint8(o + 2, e.homing ? 1 : 0);
        break;
      case KIND.pickup:
        dv.setUint8(o, u8(e.ptype, "ptype"));
        break;
    }
    o += EXTRA[e.kind];
  }
  for (const ev of events) {
    dv.setUint8(o, u8(ev.type, "event.type"));
    dv.setFloat32(o + 1, f32(ev.x, "event.x"), LE);
    dv.setFloat32(o + 5, f32(ev.y, "event.y"), LE);
    dv.setUint16(o + 9, u16(ev.a, "event.a"), LE);
    dv.setUint16(o + 11, u16(ev.b, "event.b"), LE);
    o += EVENT_SIZE;
  }
  for (const [id, score] of scores) {
    dv.setUint16(o, u16(id, "score.id"), LE);
    dv.setUint32(o + 2, u32(score, "score"), LE);
    o += SCORE_SIZE;
  }
  return buf;
}

function viewOf(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError("expected binary data");
}

/** Будь-які байти → або знімок, або CodecError. Жодних інших винятків. */
export function decodeSnapshot(data) {
  const dv = viewOf(data);
  const need = (o, n) => {
    if (o + n > dv.byteLength) throw new CodecError(`truncated at byte ${o}`);
  };
  need(0, HEADER);
  if (dv.getUint8(0) !== MSG.snapshot) throw new CodecError("not a snapshot");
  if (dv.getUint8(5) !== PROTOCOL_VERSION_BINARY) {
    throw new CodecError(`unsupported version ${dv.getUint8(5)}`);
  }
  const tick = dv.getUint32(1, LE);
  const ack = dv.getUint32(6, LE);
  const nEnt = dv.getUint16(10, LE);
  const nEv = dv.getUint8(12);
  const nScore = dv.getUint8(13);
  let o = HEADER;
  const entities = new Array(nEnt);
  for (let i = 0; i < nEnt; i++) {
    need(o, ENTITY_BASE);
    const e = {
      id: dv.getUint16(o, LE),
      kind: dv.getUint8(o + 2),
      x: dv.getFloat32(o + 3, LE),
      y: dv.getFloat32(o + 7, LE),
      angle: dv.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    o += ENTITY_BASE;
    const extra = EXTRA[e.kind];
    if (extra === undefined) throw new CodecError(`unknown kind ${e.kind} at byte ${o - 11}`);
    need(o, extra);
    switch (e.kind) {
      case KIND.ship:
        e.vx = dv.getFloat32(o, LE);
        e.vy = dv.getFloat32(o + 4, LE);
        e.hp = dv.getUint8(o + 8);
        e.flags = dv.getUint8(o + 9);
        e.skin = dv.getUint8(o + 10);
        break;
      case KIND.bullet:
        e.owner = dv.getUint16(o, LE);
        e.seq = dv.getUint16(o + 2, LE);
        e.homing = dv.getUint8(o + 4) === 1;
        break;
      case KIND.asteroid:
        e.radius = dv.getUint8(o);
        e.variant = dv.getUint8(o + 1);
        e.homing = dv.getUint8(o + 2) === 1;
        break;
      case KIND.pickup:
        e.ptype = dv.getUint8(o);
        break;
    }
    o += extra;
    entities[i] = e;
  }
  const events = new Array(nEv);
  for (let i = 0; i < nEv; i++) {
    need(o, EVENT_SIZE);
    events[i] = {
      type: dv.getUint8(o),
      x: dv.getFloat32(o + 1, LE),
      y: dv.getFloat32(o + 5, LE),
      a: dv.getUint16(o + 9, LE),
      b: dv.getUint16(o + 11, LE),
    };
    o += EVENT_SIZE;
  }
  const scores = new Array(nScore);
  for (let i = 0; i < nScore; i++) {
    need(o, SCORE_SIZE);
    scores[i] = [dv.getUint16(o, LE), dv.getUint32(o + 2, LE)];
    o += SCORE_SIZE;
  }
  if (o !== dv.byteLength) throw new CodecError(`trailing ${dv.byteLength - o} bytes`);
  return { tick, ack, entities, events, scores };
}

// ---------------- input ----------------
const INPUT_HEADER = 7; // type u8, seq u32, version u8, n u8

function packCommand(c) {
  return (c.turn + 1) | (c.thrust ? 4 : 0) | (c.brake ? 8 : 0) | (c.fire ? 16 : 0);
}

function unpackCommand(b) {
  const t = b & 3;
  if (t === 3 || b & 0xe0) throw new CodecError(`bad command byte ${b}`);
  return { turn: t - 1, thrust: (b & 4) !== 0, brake: (b & 8) !== 0, fire: (b & 16) !== 0 };
}

/** cmds — від найстарішої до найновішої; seq — номер НАЙНОВІШОЇ. */
export function encodeInput(seq, cmds) {
  const buf = new ArrayBuffer(INPUT_HEADER + cmds.length);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG.input);
  dv.setUint32(1, u32(seq, "seq"), LE);
  dv.setUint8(5, PROTOCOL_VERSION_BINARY);
  dv.setUint8(6, u8(cmds.length, "n"));
  cmds.forEach((c, i) => {
    dv.setUint8(INPUT_HEADER + i, packCommand(c));
  });
  return buf;
}

export function decodeInput(data) {
  const dv = viewOf(data);
  if (dv.byteLength < INPUT_HEADER) throw new CodecError("truncated input");
  if (dv.getUint8(0) !== MSG.input) throw new CodecError("not an input");
  if (dv.getUint8(5) !== PROTOCOL_VERSION_BINARY) throw new CodecError("unsupported version");
  const n = dv.getUint8(6);
  if (dv.byteLength !== INPUT_HEADER + n) throw new CodecError("input length mismatch");
  const cmds = [];
  for (let i = 0; i < n; i++) cmds.push(unpackCommand(dv.getUint8(INPUT_HEADER + i)));
  return { seq: dv.getUint32(1, LE), cmds };
}

/** Тип бінарного повідомлення (перший байт) — для диспетчеризації. */
export function binaryType(data) {
  const dv = viewOf(data);
  if (dv.byteLength < 1) throw new CodecError("empty frame");
  return dv.getUint8(0);
}
