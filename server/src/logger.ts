/**
 * Мінімальний інтерфейс логера (сумісний з pino): об'єкт полів + повідомлення.
 * У продакшні — pino (JSON-рядки в stdout), у тестах — тихий логер.
 */
import { pino } from "pino";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child?(bindings: object): Logger;
}

function fmt(obj: object, msg?: string): string {
  const fields = Object.entries(obj)
    .map(([k, v]) => `${k}=${v instanceof Error ? v.message : String(v)}`)
    .join(" ");
  return [msg, fields].filter(Boolean).join(" ");
}

export const consoleLogger: Logger = {
  info: (obj, msg) => console.log(fmt(obj, msg)),
  warn: (obj, msg) => console.warn(fmt(obj, msg)),
  error: (obj, msg) => console.error(fmt(obj, msg)),
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Структуровані логи (Лаба 8): JSON-рядок на подію в stdout — платформа (Docker, Fly)
 * сама збирає stdout. Поле `event` — машинна назва події (room.created, player.joined,
 * ws.rejected), msg — людська. `err` серіалізується зі стеком.
 * redact — на випадок, якщо хтось колись залогує заголовки: cookie/authorization не потраплять.
 */
export function createLogger(level: string, version: string): Logger {
  return pino({
    level,
    base: { service: "dogfight", version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      "headers.cookie",
      "headers.authorization",
    ],
    formatters: { level: (label) => ({ level: label }) },
  });
}
