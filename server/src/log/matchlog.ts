/**
 * Журнал матчу як потік: події кімнати → Readable(objectMode) → Transform(NDJSON) → файл.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MatchRecord, Room } from "../rooms.ts";

export function createNdjsonTransform(): Transform {
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record: unknown, _enc: BufferEncoding, callback: TransformCallback) {
      try {
        callback(null, `${JSON.stringify(record)}\n`);
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

export function roomRecordStream(room: Room): Readable {
  const source = new Readable({ objectMode: true, read() {} });
  const onRecord = (record: MatchRecord): void => {
    source.push(record);
  };
  room.on("record", onRecord);
  room.once("close", () => {
    room.off("record", onRecord);
    source.push(null);
  });
  return source;
}

function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export interface MatchLogResult {
  id: string;
  file: string;
  error?: unknown;
}

export function startMatchLog(
  room: Room,
  dir: string,
  { onError = (e: unknown) => console.error(e) }: { onError?: (e: unknown) => void } = {},
): { id: string; file: string; done: Promise<MatchLogResult> } {
  mkdirSync(dir, { recursive: true });
  const id = `${room.id}-${timestamp()}`;
  const file = join(dir, `${id}.ndjson`);
  const done = pipeline(roomRecordStream(room), createNdjsonTransform(), createWriteStream(file))
    .then((): MatchLogResult => ({ id, file }))
    .catch((error: unknown): MatchLogResult => {
      onError(error);
      return { id, file, error };
    });
  return { id, file, done };
}
