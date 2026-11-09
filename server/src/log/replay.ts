/**
 * Читання журналу: async-генератор, рядок за рядком. У пам'яті — лише поточний шматок.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* readReplay(file: string): AsyncGenerator<unknown> {
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

/** Безпечний id журналу (без "../" і слешів). */
export const REPLAY_ID_RE = /^[a-z0-9-]{1,80}$/i;
