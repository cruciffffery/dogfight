/**
 * Читання журналу: async-генератор, який стрімить файл рядок за рядком.
 * Файл будь-якого розміру — у пам'яті одночасно лише один шматок (highWaterMark = 64 КБ).
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* readReplay(file) {
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let n = 0;
  for await (const line of lines) {
    n += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      throw new SyntaxError(`${file}:${n}: invalid NDJSON line`);
    }
  }
}

/** Безпечний id журналу (без "../" і слешів) — захист від path traversal. */
export const REPLAY_ID_RE = /^[a-z0-9-]{1,80}$/i;
