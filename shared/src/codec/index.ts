/**
 * Codec — спільний інтерфейс двох реалізацій. Сервер кодує знімки кожному гравцю
 * тим кодеком, який він обрав при join; клієнт шле input тим самим кодеком.
 */
import type { CodecName, Snapshot } from "../protocol.ts";
import type { Command } from "../types.ts";
import * as binary from "./binary.ts";
import * as json from "./json.ts";

export type Frame = string | ArrayBuffer;

export interface Codec {
  readonly name: CodecName;
  encodeSnapshot(snap: Snapshot): Frame;
  decodeSnapshot(frame: Frame): Snapshot;
  encodeInput(seq: number, cmds: readonly Command[]): Frame;
}

export const binaryCodec: Codec = {
  name: "binary",
  encodeSnapshot: binary.encodeSnapshot,
  decodeSnapshot(frame) {
    if (typeof frame === "string") throw new binary.CodecError("binary codec got a text frame");
    return binary.decodeSnapshot(frame);
  },
  encodeInput: binary.encodeInput,
};

export const jsonCodec: Codec = {
  name: "json",
  encodeSnapshot: json.encodeSnapshot,
  decodeSnapshot(frame) {
    if (typeof frame !== "string") throw new binary.CodecError("json codec got a binary frame");
    return json.decodeSnapshot(frame);
  },
  encodeInput: json.encodeInput,
};

export const codecs: Readonly<Record<CodecName, Codec>> = Object.freeze({
  binary: binaryCodec,
  json: jsonCodec,
});

export function frameSize(frame: Frame): number {
  return typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
}

export { CodecError, decodeInput, MSG } from "./binary.ts";
