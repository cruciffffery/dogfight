/**
 * Журнал матчу як потік:
 *
 *   події кімнати ──► Readable (objectMode) ──► Transform (об'єкт → рядок NDJSON) ──► файл
 *                     pipeline() з'єднує все, передає backpressure і закриває потоки при помилці.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Об'єкт → один рядок JSON + "\n". Об'єктний режим лише з боку запису. */
export function createNdjsonTransform() {
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record, _enc, callback) {
      try {
        callback(null, `${JSON.stringify(record)}\n`);
      } catch (err) {
        callback(err); // напр. циклічне посилання — pipeline закриє всі потоки
      }
    },
  });
}

/**
 * Перетворює події "record" кімнати на Readable. Кімнату не можна «поставити на паузу»,
 * тому при backpressure записи накопичуються в буфері потоку (видно в readableLength).
 */
export function roomRecordStream(room) {
  const source = new Readable({ objectMode: true, read() {} });
  const onRecord = (record) => {
    source.push(record);
  };
  room.on("record", onRecord);
  room.once("close", () => {
    room.off("record", onRecord);
    source.push(null); // кінець потоку → pipeline допише файл і завершиться
  });
  return source;
}

function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

/**
 * Почати журнал кімнати. Повертає { file, done }, де done — проміс завершення pipeline
 * (graceful shutdown чекає на нього, щоб не втратити хвіст файлу).
 */
export function startMatchLog(room, dir, { onError = console.error } = {}) {
  mkdirSync(dir, { recursive: true });
  const id = `${room.id}-${timestamp()}`;
  const file = join(dir, `${id}.ndjson`);
  const done = pipeline(roomRecordStream(room), createNdjsonTransform(), createWriteStream(file))
    .then(() => ({ id, file }))
    .catch((err) => {
      onError(err);
      return { id, file, error: err };
    });
  return { id, file, done };
}
