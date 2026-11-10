/**
 * Конфігурація з process.env через zod-схему з типами й значеннями за замовчуванням.
 * ServerConfig — виведений тип; невалідне значення = падіння на старті з назвою змінної.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const bool = (def: boolean) =>
  z
    .enum(["1", "0", "true", "false", "yes", "no"])
    .default(def ? "1" : "0")
    .transform((v) => v === "1" || v === "true" || v === "yes");

/** Порожній рядок у .env трактуємо як «не задано». */
const env = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null
      ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== undefined))
      : raw,
  z.object({
    PORT: int(8080, 0, 65535),
    HOST: z.string().default("0.0.0.0"),
    LOG_DIR: z.string().default("./logs"),
    STATIC_DIR: z.string().default(fileURLToPath(new URL("../../client/dist", import.meta.url))),
    MAX_ROOMS: int(50, 1),
    MAX_PLAYERS_PER_ROOM: int(8, 1, 256),
    MAX_PAYLOAD: int(4096, 256),
    JOIN_TIMEOUT_MS: int(5000, 100),
    HEARTBEAT_MS: int(15000, 50),
    RATE_PER_SECOND: int(60, 1),
    RATE_BURST: int(120, 1),
    SLOW_DROP_BYTES: int(256 * 1024),
    SLOW_CLOSE_BYTES: int(1024 * 1024),
    ENABLE_DEBUG_ROUTES: bool(false),
    DEMO_NO_ERROR_LISTENER: bool(false),
    SHUTDOWN_TIMEOUT_MS: int(10000, 100),
    /** Лаба 7: "grid" — просторовий хеш (за замовчуванням), "naive" — O(n²) для порівняння. */
    COLLISIONS: z.enum(["grid", "naive"]).default("grid"),
  }),
);

export type Env = z.input<typeof env>;

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly logDir: string;
  readonly staticDir: string;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly maxPayload: number;
  readonly joinTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly rateLimit: { readonly perSecond: number; readonly burst: number };
  readonly slowClient: { readonly dropAbove: number; readonly closeAbove: number };
  readonly debugRoutes: boolean;
  readonly demoNoErrorListener: boolean;
  readonly shutdownTimeoutMs: number;
  readonly collisions: "grid" | "naive";
}

export function loadConfig(source: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = env.safeParse(source);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Config: ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  const e = parsed.data;
  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    logDir: resolve(e.LOG_DIR),
    staticDir: resolve(e.STATIC_DIR),
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
    maxPayload: e.MAX_PAYLOAD,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    heartbeatMs: e.HEARTBEAT_MS,
    rateLimit: { perSecond: e.RATE_PER_SECOND, burst: e.RATE_BURST },
    slowClient: { dropAbove: e.SLOW_DROP_BYTES, closeAbove: e.SLOW_CLOSE_BYTES },
    debugRoutes: e.ENABLE_DEBUG_ROUTES,
    demoNoErrorListener: e.DEMO_NO_ERROR_LISTENER,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    collisions: e.COLLISIONS,
  });
}
