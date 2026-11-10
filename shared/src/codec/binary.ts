/**
 * Бінарний кодек на DataView. Специфікація — docs/protocol.md. Little-endian скрізь.
 * Кодування перевіряє діапазони; декодування на будь-яких байтах дає або Snapshot,
 * або CodecError — і ніколи інший виняток (перевіряється property-тестами в Лабі 7).
 */
import { type EntityState, EVENT, type EventState, KIND, type Snapshot } from "../protocol.ts";
import type { Command } from "../types.ts";

export const MSG = Object.freeze({ input: 0x01, snapshot: 0x10 });
export const BINARY_VERSION = 1;

const LE = true;
const ANGLE_SCALE = 1000;

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodecError";
  }
}

function u8(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new CodecError(`${what} out of Uint8: ${v}`);
  return v;
}
function u16(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff)
    throw new CodecError(`${what} out of Uint16: ${v}`);
  return v;
}
function u32(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new CodecError(`${what} out of Uint32: ${v}`);
  }
  return v;
}
function f32(v: number, what: string): number {
  if (!Number.isFinite(v)) throw new CodecError(`${what} is not finite`);
  return v;
}
function angle16(a: number): number {
  const q = Math.round(f32(a, "angle") * ANGLE_SCALE);
  return Math.max(-32768, Math.min(32767, q));
}

const HEADER = 14;
const ENTITY_BASE = 13;
const EXTRA: Readonly<Record<EntityState["kind"], number>> = {
  [KIND.ship]: 11,
  [KIND.bullet]: 5,
  [KIND.asteroid]: 3,
  [KIND.pickup]: 1,
};
const EVENT_SIZE = 13;
const SCORE_SIZE = 6;

export function snapshotSize(snap: Snapshot): number {
  let size = HEADER;
  for (const e of snap.entities) size += ENTITY_BASE + EXTRA[e.kind];
  return size + snap.events.length * EVENT_SIZE + snap.scores.length * SCORE_SIZE;
}

/** Зсув поля ack у бінарному знімку — сервер дописує його на копію спільного кадру. */
export const SNAPSHOT_ACK_OFFSET = 6;

export function encodeSnapshot(snap: Snapshot): ArrayBuffer {
  if (snap.entities.length > 0xffff) throw new CodecError("too many entities");
  const body: Snapshot = {
    ...snap,
    events: snap.events.slice(0, 0xff),
    scores: snap.scores.slice(0, 0xff),
  };
  const buf = new ArrayBuffer(snapshotSize(body));
  const dv = new DataView(buf);
  dv.setUint8(0, MSG.snapshot);
  dv.setUint32(1, u32(snap.tick, "tick"), LE);
  dv.setUint8(5, BINARY_VERSION);
  dv.setUint32(SNAPSHOT_ACK_OFFSET, u32(snap.ack, "ack"), LE);
  dv.setUint16(10, snap.entities.length, LE);
  dv.setUint8(12, body.events.length);
  dv.setUint8(13, body.scores.length);
  let o = HEADER;

  for (const e of snap.entities) {
    dv.setUint16(o, u16(e.id, "id"), LE);
    dv.setUint8(o + 2, e.kind);
    dv.setFloat32(o + 3, f32(e.x, "x"), LE);
    dv.setFloat32(o + 7, f32(e.y, "y"), LE);
    dv.setInt16(o + 11, angle16(e.angle), LE);
    o += ENTITY_BASE;
    switch (e.kind) {
      case KIND.ship:
        dv.setFloat32(o, f32(e.vx, "vx"), LE);
        dv.setFloat32(o + 4, f32(e.vy, "vy"), LE);
        dv.setUint8(o + 8, u8(e.hp, "hp"));
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
      default: {
        const never: never = e;
        throw new CodecError(`unknown entity ${JSON.stringify(never)}`);
      }
    }
    o += EXTRA[e.kind];
  }
  for (const ev of body.events) {
    dv.setUint8(o, ev.type);
    dv.setFloat32(o + 1, f32(ev.x, "event.x"), LE);
    dv.setFloat32(o + 5, f32(ev.y, "event.y"), LE);
    dv.setUint16(o + 9, u16(ev.a, "event.a"), LE);
    dv.setUint16(o + 11, u16(ev.b, "event.b"), LE);
    o += EVENT_SIZE;
  }
  for (const [id, score] of body.scores) {
    dv.setUint16(o, u16(id, "score.id"), LE);
    dv.setUint32(o + 2, u32(score, "score"), LE);
    o += SCORE_SIZE;
  }
  return buf;
}

export type BinaryInput = ArrayBuffer | ArrayBufferView;

function viewOf(data: BinaryInput): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError("expected binary data");
}

function eventType(n: number): EventState["type"] {
  switch (n) {
    case EVENT.fired:
      return EVENT.fired;
    case EVENT.hit:
      return EVENT.hit;
    case EVENT.exploded:
      return EVENT.exploded;
    case EVENT.picked:
      return EVENT.picked;
    case EVENT.scored:
      return EVENT.scored;
    default:
      throw new CodecError(`unknown event type ${n}`);
  }
}

export function decodeSnapshot(data: BinaryInput): Snapshot {
  const dv = viewOf(data);
  const need = (o: number, n: number): void => {
    if (o + n > dv.byteLength) throw new CodecError(`truncated at byte ${o}`);
  };
  need(0, HEADER);
  if (dv.getUint8(0) !== MSG.snapshot) throw new CodecError("not a snapshot");
  if (dv.getUint8(5) !== BINARY_VERSION)
    throw new CodecError(`unsupported version ${dv.getUint8(5)}`);
  const tick = dv.getUint32(1, LE);
  const ack = dv.getUint32(6, LE);
  const nEnt = dv.getUint16(10, LE);
  const nEv = dv.getUint8(12);
  const nScore = dv.getUint8(13);
  let o = HEADER;

  const entities: EntityState[] = [];
  for (let i = 0; i < nEnt; i++) {
    need(o, ENTITY_BASE);
    const base = {
      id: dv.getUint16(o, LE),
      x: dv.getFloat32(o + 3, LE),
      y: dv.getFloat32(o + 7, LE),
      angle: dv.getInt16(o + 11, LE) / ANGLE_SCALE,
    };
    const kind = dv.getUint8(o + 2);
    o += ENTITY_BASE;
    switch (kind) {
      case KIND.ship:
        need(o, EXTRA[KIND.ship]);
        entities.push({
          ...base,
          kind: KIND.ship,
          vx: dv.getFloat32(o, LE),
          vy: dv.getFloat32(o + 4, LE),
          hp: dv.getUint8(o + 8),
          flags: dv.getUint8(o + 9),
          skin: dv.getUint8(o + 10),
        });
        o += EXTRA[KIND.ship];
        break;
      case KIND.bullet:
        need(o, EXTRA[KIND.bullet]);
        entities.push({
          ...base,
          kind: KIND.bullet,
          owner: dv.getUint16(o, LE),
          seq: dv.getUint16(o + 2, LE),
          homing: dv.getUint8(o + 4) === 1,
        });
        o += EXTRA[KIND.bullet];
        break;
      case KIND.asteroid:
        need(o, EXTRA[KIND.asteroid]);
        entities.push({
          ...base,
          kind: KIND.asteroid,
          radius: dv.getUint8(o),
          variant: dv.getUint8(o + 1),
          homing: dv.getUint8(o + 2) === 1,
        });
        o += EXTRA[KIND.asteroid];
        break;
      case KIND.pickup:
        need(o, EXTRA[KIND.pickup]);
        entities.push({ ...base, kind: KIND.pickup, ptype: dv.getUint8(o) });
        o += EXTRA[KIND.pickup];
        break;
      default:
        throw new CodecError(`unknown kind ${kind} at byte ${o - 11}`);
    }
  }
  const events: EventState[] = [];
  for (let i = 0; i < nEv; i++) {
    need(o, EVENT_SIZE);
    events.push({
      type: eventType(dv.getUint8(o)),
      x: dv.getFloat32(o + 1, LE),
      y: dv.getFloat32(o + 5, LE),
      a: dv.getUint16(o + 9, LE),
      b: dv.getUint16(o + 11, LE),
    });
    o += EVENT_SIZE;
  }
  const scores: [number, number][] = [];
  for (let i = 0; i < nScore; i++) {
    need(o, SCORE_SIZE);
    scores.push([dv.getUint16(o, LE), dv.getUint32(o + 2, LE)]);
    o += SCORE_SIZE;
  }
  if (o !== dv.byteLength) throw new CodecError(`trailing ${dv.byteLength - o} bytes`);
  return { tick, ack, entities, events, scores };
}

// ---------------- input ----------------
const INPUT_HEADER = 7;

function packCommand(c: Command): number {
  return (c.turn + 1) | (c.thrust ? 4 : 0) | (c.brake ? 8 : 0) | (c.fire ? 16 : 0);
}

function unpackTurn(t: number): Command["turn"] {
  switch (t) {
    case 0:
      return -1;
    case 1:
      return 0;
    case 2:
      return 1;
    default:
      throw new CodecError(`bad turn bits ${t}`);
  }
}

function unpackCommand(b: number): Command {
  if (b & 0xe0) throw new CodecError(`bad command byte ${b}`);
  return {
    turn: unpackTurn(b & 3),
    thrust: (b & 4) !== 0,
    brake: (b & 8) !== 0,
    fire: (b & 16) !== 0,
  };
}

export interface DecodedInput {
  seq: number;
  cmds: Command[];
}

export function encodeInput(seq: number, cmds: readonly Command[]): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_HEADER + cmds.length);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG.input);
  dv.setUint32(1, u32(seq, "seq"), LE);
  dv.setUint8(5, BINARY_VERSION);
  dv.setUint8(6, u8(cmds.length, "n"));
  cmds.forEach((c, i) => {
    dv.setUint8(INPUT_HEADER + i, packCommand(c));
  });
  return buf;
}

export function decodeInput(data: BinaryInput): DecodedInput {
  const dv = viewOf(data);
  if (dv.byteLength < INPUT_HEADER) throw new CodecError("truncated input");
  if (dv.getUint8(0) !== MSG.input) throw new CodecError("not an input");
  if (dv.getUint8(5) !== BINARY_VERSION) throw new CodecError("unsupported version");
  const n = dv.getUint8(6);
  if (dv.byteLength !== INPUT_HEADER + n) throw new CodecError("input length mismatch");
  const cmds: Command[] = [];
  for (let i = 0; i < n; i++) cmds.push(unpackCommand(dv.getUint8(INPUT_HEADER + i)));
  return { seq: dv.getUint32(1, LE), cmds };
}

/** Перший байт бінарного кадру — тип повідомлення. */
export function binaryType(data: BinaryInput): number {
  const dv = viewOf(data);
  if (dv.byteLength < 1) throw new CodecError("empty frame");
  return dv.getUint8(0);
}
