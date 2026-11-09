/**
 * JSON проти DataView (Лаба 5, M4): 4 гравці, 30 Гц, арена classic, 60 с гри.
 *
 *   node scripts/codec-bench.js
 *
 * Гравці керуються детермінованим «пілотом» (стріляють, крутяться), тож у знімках
 * є кулі, астероїди, підсилювачі й події — як у живому матчі.
 */

import { ARENAS } from "@dogfight/shared/arenas.ts";
import * as binary from "@dogfight/shared/codec/binary.ts";
import * as json from "@dogfight/shared/codec/json.ts";
import { Match } from "../src/match.ts";

const TICKS = 30 * 60;
const PLAYERS = 4;
const room = { id: "bench" };
const match = new Match({ room, arena: ARENAS.classic, seed: 7 });
match.autoStart = false; // без таймера — тікаємо вручну
const snaps = [];
const players = [];
for (let i = 0; i < PLAYERS; i++) {
  const player = { id: i + 1, name: `bot${i}`, send() {} };
  players.push(player);
  match.addPlayer(player, { codec: "binary" });
}
// перехоплюємо знімок до кодування: buildSnapshot викликається всередині tick()
const p0 = match.players.get(1);
p0.codec = {
  encodeSnapshot: (s) => {
    snaps.push(s);
    return new ArrayBuffer(0);
  },
};

const inputSizes = { json: [], binary: [] };
for (let t = 1; t <= TICKS; t++) {
  for (const p of players) {
    const cmd = {
      turn: (t + p.id * 13) % 60 < 20 ? 1 : 0,
      thrust: (t + p.id) % 50 < 30,
      brake: false,
      fire: (t + p.id) % 9 === 0,
    };
    const cmds = [cmd, cmd, cmd];
    inputSizes.binary.push(binary.encodeInput(t, cmds).byteLength);
    inputSizes.json.push(json.encodeInput(t, cmds).length);
    match.onInput(p.id, t, cmds);
  }
  match.tick();
}

function bench(name, codec) {
  const sizes = [];
  // прогрів JIT
  for (const s of snaps.slice(0, 200)) codec.decodeSnapshot(codec.encodeSnapshot(s));
  const t0 = performance.now();
  for (const s of snaps) {
    const data = codec.encodeSnapshot(s);
    sizes.push(typeof data === "string" ? Buffer.byteLength(data) : data.byteLength);
    codec.decodeSnapshot(data);
  }
  const us = ((performance.now() - t0) * 1000) / snaps.length;
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const max = Math.max(...sizes);
  const up = inputSizes[name].reduce((a, b) => a + b, 0) / inputSizes[name].length;
  return {
    codec: name,
    "bytes/snapshot (mean)": +mean.toFixed(0),
    "bytes/snapshot (max)": max,
    "KB/s down per client": +((mean * 30) / 1024).toFixed(2),
    "KB/s up per client": +((up * 30) / 1024).toFixed(2),
    "encode+decode µs": +us.toFixed(1),
  };
}

const ents = snaps.map((s) => s.entities.length);
console.log(
  `${snaps.length} snapshots, entities per snapshot: mean ${(ents.reduce((a, b) => a + b, 0) / ents.length).toFixed(1)}, max ${Math.max(...ents)}`,
);
const rows = [bench("json", json), bench("binary", binary)];
console.table(rows);
console.log(
  `binary/json: ${(rows[1]["bytes/snapshot (mean)"] / rows[0]["bytes/snapshot (mean)"]).toFixed(2)}× bytes, ${(rows[0]["bytes/snapshot (mean)"] / rows[1]["bytes/snapshot (mean)"]).toFixed(1)}× smaller`,
);
console.log(
  `(Node ${process.version}; на WebSocket додається 2–8 байт заголовка кадру; TCP/IP — ~40–60 байт на пакет)`,
);
