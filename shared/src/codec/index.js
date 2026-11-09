/**
 * Codec — спільний інтерфейс двох реалізацій:
 *   { name, encodeSnapshot(snap), decodeSnapshot(data), encodeInput(seq, cmds) }
 * Клієнт обирає кодек при join; сервер кодує знімки кожному гравцю його кодеком.
 */
import * as binary from "./binary.js";
import * as json from "./json.js";

export const codecs = Object.freeze({
  binary: Object.freeze({ name: "binary", ...pick(binary) }),
  json: Object.freeze({ name: "json", ...pick(json) }),
});

function pick(m) {
  return {
    encodeSnapshot: m.encodeSnapshot,
    decodeSnapshot: m.decodeSnapshot,
    encodeInput: m.encodeInput,
  };
}

export { CodecError, decodeInput, MSG } from "./binary.js";
