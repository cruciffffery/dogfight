/**
 * Протокол v1 — ЄДИНЕ джерело правди: zod-схеми → TypeScript-типи (z.infer) → парсери.
 * Кожне повідомлення в обидва боки описане тут один раз; рукописний валідатор Лаби 4 видалено.
 *
 * Бінарні кадри (input 0x01, snapshot 0x10) описані в docs/protocol.md і закодовані
 * в codec/binary.ts; їхні JS-форми (Snapshot, Command) — теж звідси.
 */
import { z } from "zod";
import type { Result } from "./types.ts";

export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const INPUT_REDUNDANCY = 3;

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

// ---------------- будівельні блоки ----------------
const v = z.literal(PROTOCOL_VERSION);
const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);
const finite = z.number().finite();

export const CommandSchema = z
  .object({
    turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    thrust: z.boolean(),
    brake: z.boolean(),
    fire: z.boolean(),
  })
  .strict();

export const CodecNameSchema = z.enum(["json", "binary"]);
export type CodecName = z.infer<typeof CodecNameSchema>;

export const ArenaSchema = z
  .object({
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    asteroids: z.number().int().min(0),
    pickupEvery: z.number().positive(),
    seed: u32,
  })
  .strict();
export type ArenaConfig = z.infer<typeof ArenaSchema>;

export const RoomInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  arena: z.string(),
  players: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

// ---------------- знімок ----------------
export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export const EVENT = Object.freeze({ fired: 1, hit: 2, exploded: 3, picked: 4, scored: 5 });

const entityBase = { id: u16, x: finite, y: finite, angle: finite };
export const ShipStateSchema = z.object({
  ...entityBase,
  kind: z.literal(KIND.ship),
  vx: finite,
  vy: finite,
  hp: z.number().int().min(0).max(255),
  flags: z.number().int().min(0).max(255),
  skin: z.number().int().min(0).max(255),
});
export const BulletStateSchema = z.object({
  ...entityBase,
  kind: z.literal(KIND.bullet),
  owner: u16,
  seq: u16,
  homing: z.boolean(),
});
export const AsteroidStateSchema = z.object({
  ...entityBase,
  kind: z.literal(KIND.asteroid),
  radius: z.number().int().min(0).max(255),
  variant: z.number().int().min(0).max(255),
  homing: z.boolean(),
});
export const PickupStateSchema = z.object({
  ...entityBase,
  kind: z.literal(KIND.pickup),
  ptype: z.number().int().min(0).max(255),
});
export const EntityStateSchema = z.discriminatedUnion("kind", [
  ShipStateSchema,
  BulletStateSchema,
  AsteroidStateSchema,
  PickupStateSchema,
]);
export type ShipState = z.infer<typeof ShipStateSchema>;
export type EntityState = z.infer<typeof EntityStateSchema>;
export type EntityKindCode = EntityState["kind"];

export const EventStateSchema = z.object({
  type: z.union([
    z.literal(EVENT.fired),
    z.literal(EVENT.hit),
    z.literal(EVENT.exploded),
    z.literal(EVENT.picked),
    z.literal(EVENT.scored),
  ]),
  x: finite,
  y: finite,
  a: u16,
  b: u16,
});
export type EventState = z.infer<typeof EventStateSchema>;

export const SnapshotSchema = z.object({
  tick: u32,
  ack: u32,
  entities: z.array(EntityStateSchema).max(0xffff),
  events: z.array(EventStateSchema).max(0xff),
  scores: z.array(z.tuple([u16, u32])).max(0xff),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---------------- клієнт → сервер ----------------
const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;
const ROOM_RE = /^[a-z0-9-]{1,32}$/;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      v,
      type: z.literal("join"),
      room: z.string().regex(ROOM_RE),
      name: z.string().trim().regex(NAME_RE),
      codec: CodecNameSchema.default("binary"),
    })
    .strict(),
  z.object({ v, type: z.literal("chat"), text: z.string().trim().min(1).max(200) }).strict(),
  z.object({ v, type: z.literal("ping"), t: finite }).strict(),
  z
    .object({
      v,
      type: z.literal("input"),
      seq: u32.min(1),
      cmds: z.array(CommandSchema).min(1).max(INPUT_REDUNDANCY),
    })
    .strict(),
  z.object({ v, type: z.literal("leave") }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;
/** Те, що клієнт передає в conn.send(): без поля v (його додає транспорт). */
export type OutgoingClientMessage = DistributiveOmit<ClientMessageInput, "v">;

// ---------------- сервер → клієнт ----------------
export const PlayerInfoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shipId: u16,
  skin: z.string(),
});
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    v,
    type: z.literal("welcome"),
    playerId: z.number().int(),
    shipId: u16,
    room: RoomInfoSchema,
    arena: ArenaSchema,
    tickRate: z.number().int().positive(),
    codec: CodecNameSchema,
  }),
  z.object({ v, type: z.literal("roster"), players: z.array(PlayerInfoSchema) }),
  z.object({
    v,
    type: z.literal("chat"),
    from: z.number().int(),
    name: z.string(),
    text: z.string(),
    t: z.number(),
  }),
  z.object({ v, type: z.literal("pong"), t: finite }),
  z.object({ v, type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ v, type: z.literal("shutdown") }),
  SnapshotSchema.extend({ v, type: z.literal("snapshot") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
/** Те, що сервер передає в encode(): без поля v. */
export type OutgoingServerMessage = DistributiveOmit<ServerMessage, "v">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------- парсери на межах ----------------
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid message";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`.slice(0, 120);
}

function decodeText(raw: unknown, maxBytes: number): Result<unknown> {
  let text: string;
  if (typeof raw === "string") {
    if (encoder.encode(raw).byteLength > maxBytes) return { ok: false, error: "message too large" };
    text = raw;
  } else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
    if (bytes.byteLength > maxBytes) return { ok: false, error: "message too large" };
    try {
      text = decoder.decode(bytes);
    } catch {
      return { ok: false, error: "invalid UTF-8" };
    }
  } else {
    return { ok: false, error: "unsupported frame" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

/** Текстовий кадр від клієнта → Result. Ніколи не кидає. */
export function parseClientMessage(raw: unknown, { maxBytes = 4096 } = {}): Result<ClientMessage> {
  const json = decodeText(raw, maxBytes);
  if (!json.ok) return json;
  const parsed = ClientMessageSchema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: describe(parsed.error) };
}

/** Текстовий кадр від сервера → Result (клієнт теж не довіряє мережі). */
export function parseServerMessage(raw: unknown): Result<ServerMessage> {
  const json = decodeText(raw, 4 * 1024 * 1024);
  if (!json.ok) return json;
  const parsed = ServerMessageSchema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: describe(parsed.error) };
}

/** Текстове повідомлення сервера — версія додається тут, тип перевіряє компілятор. */
export function encodeServerMessage(msg: OutgoingServerMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}
