/**
 * JSON-кодек — для порівняння з бінарним і налагодження (видно в DevTools).
 * Декодування — через zod-схему знімка: та сама перевірка, що й для решти протоколу.
 */
import { PROTOCOL_VERSION, type Snapshot, SnapshotSchema } from "../protocol.ts";
import type { Command } from "../types.ts";
import { CodecError } from "./binary.ts";

export function encodeSnapshot(snap: Snapshot): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", ...snap });
}

export function decodeSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CodecError("invalid JSON");
  }
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new CodecError(`not a snapshot: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export function encodeInput(seq: number, cmds: readonly Command[]): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: "input", seq, cmds });
}
