/**
 * JSON-кодек — для порівняння з бінарним (і для налагодження: його видно в DevTools).
 */
import { CodecError } from "./binary.js";

export function encodeSnapshot(snap) {
  return JSON.stringify({ v: 1, type: "snapshot", ...snap });
}

export function decodeSnapshot(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new CodecError("invalid JSON");
  }
  if (m?.type !== "snapshot" || !Array.isArray(m.entities)) throw new CodecError("not a snapshot");
  return { tick: m.tick, ack: m.ack, entities: m.entities, events: m.events, scores: m.scores };
}

export function encodeInput(seq, cmds) {
  return JSON.stringify({ v: 1, type: "input", seq, cmds });
}
