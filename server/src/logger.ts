/**
 * Мінімальний інтерфейс логера (сумісний з pino): об'єкт полів + повідомлення.
 * Лаба 8 підставить pino; тести — тихий логер.
 */
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
