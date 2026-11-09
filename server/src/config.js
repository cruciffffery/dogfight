/**
 * Конфігурація з process.env — і лише тут. Решта коду отримує вже перевірений об'єкт.
 * Невалідне значення = падіння на старті з зрозумілим повідомленням, а не дивна поведінка потім.
 */
import { resolve } from "node:path";

function int(env, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Config: ${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`Config: ${name} must be a boolean, got "${raw}"`);
}

export function loadConfig(env = process.env) {
  const config = {
    port: int(env, "PORT", 8080, { min: 0, max: 65535 }),
    host: env.HOST || "0.0.0.0",
    logDir: resolve(env.LOG_DIR || "./logs"),
    staticDir: resolve(env.STATIC_DIR || new URL("../../client/dist", import.meta.url).pathname),
    maxRooms: int(env, "MAX_ROOMS", 50, { min: 1 }),
    maxPlayersPerRoom: int(env, "MAX_PLAYERS_PER_ROOM", 8, { min: 1, max: 64 }),
    maxPayload: int(env, "MAX_PAYLOAD", 4096, { min: 256 }),
    joinTimeoutMs: int(env, "JOIN_TIMEOUT_MS", 5000, { min: 100 }),
    heartbeatMs: int(env, "HEARTBEAT_MS", 15000, { min: 50 }),
    rateLimit: {
      perSecond: int(env, "RATE_PER_SECOND", 30, { min: 1 }),
      burst: int(env, "RATE_BURST", 60, { min: 1 }),
    },
    slowClient: {
      dropAbove: int(env, "SLOW_DROP_BYTES", 256 * 1024),
      closeAbove: int(env, "SLOW_CLOSE_BYTES", 1024 * 1024),
    },
    debugRoutes: bool(env, "ENABLE_DEBUG_ROUTES", false),
    // Лише для демонстрації краху в README: НЕ вішати "error"-слухач на сокети
    demoNoErrorListener: bool(env, "DEMO_NO_ERROR_LISTENER", false),
    shutdownTimeoutMs: int(env, "SHUTDOWN_TIMEOUT_MS", 10000, { min: 100 }),
  };
  return Object.freeze(config);
}
