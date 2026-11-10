/**
 * Навантажувальний тест (Лаба 7, M4): N справжніх WebSocket-клієнтів в одній кімнаті.
 * Кожен клієнт: join (binary), інпут 30 Гц (газ/поворот/вогонь випадково), читає знімки.
 *
 *   node server/scripts/loadtest.ts                 → docs/lab-07/load.json
 *   COLLISIONS=naive node server/scripts/loadtest.ts → порівняння з O(n²)
 *   NS=8,32 SECONDS=10 node server/scripts/loadtest.ts
 *
 * Для кожного N сервер стартує ОКРЕМИМ процесом (чистий стан), 3 с прогріву, далі вимір.
 * З /api/stats: tick p50/p99 (мс на тік), jitter p99, ELU, RSS; байти/с — дельта bytesOut.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeInput } from "@dogfight/shared/codec/binary.ts";
import type { Command } from "@dogfight/shared/types.ts";
import WebSocket from "ws";

const NS = (process.env.NS ?? "8,32,64,128").split(",").map(Number);
const SECONDS = Number(process.env.SECONDS ?? 15);
const COLLISIONS = process.env.COLLISIONS ?? "grid";
const LABEL = process.env.LABEL ?? COLLISIONS;
const ROOT = join(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Stats {
  elu: number;
  rss: number;
  bytesOut: number;
  matches: {
    room: string;
    players: number;
    entities: number;
    tickMs: { p50: number; p99: number };
    jitterMs: { p99: number };
    skippedTicks: number;
  }[];
}

async function run(n: number, port: number) {
  const server = spawn(process.execPath, ["server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MAX_PLAYERS_PER_ROOM: String(Math.max(n, 8)),
      COLLISIONS,
      LOG_DIR: "/tmp/dogfight-load",
      MAX_CONNECTIONS_PER_IP: "1000",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => server.stdout?.once("data", r));
  const base = `http://127.0.0.1:${port}`;
  const stats = async (): Promise<Stats> =>
    (await fetch(`${base}/api/stats`)).json() as Promise<Stats>;

  const sockets: WebSocket[] = [];
  let received = 0;
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.binaryType = "arraybuffer";
    ws.on("message", () => {
      received++;
    });
    ws.on("error", () => {});
    await new Promise((r) => ws.once("open", r));
    ws.send(
      JSON.stringify({ v: 1, type: "join", room: "alpha", name: `load-${i}`, codec: "binary" }),
    );
    sockets.push(ws);
  }
  let seq = 0;
  const turns: Command["turn"][] = [-1, 0, 1];
  const timer = setInterval(() => {
    seq++;
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const cmd: Command = {
        thrust: Math.random() < 0.6,
        turn: turns[Math.floor(Math.random() * 3)] ?? 0,
        fire: Math.random() < 0.3,
        brake: false,
      };
      ws.send(encodeInput(seq, [cmd]));
    }
  }, 1000 / 30);

  await sleep(3000);
  await stats(); // скидає вікно ELU
  const s0 = await stats();
  const t0 = performance.now();
  await sleep(SECONDS * 1000);
  const s1 = await stats();
  const dt = (performance.now() - t0) / 1000;
  clearInterval(timer);
  for (const ws of sockets) ws.terminate();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));

  const m = s1.matches.find((x) => x.room === "alpha");
  return {
    players: n,
    connected: m?.players ?? 0,
    entities: m?.entities ?? 0,
    tickP50: m?.tickMs.p50 ?? 0,
    tickP99: m?.tickMs.p99 ?? 0,
    jitterP99: m?.jitterMs.p99 ?? 0,
    skipped: m?.skippedTicks ?? 0,
    elu: s1.elu,
    rssMB: Math.round(s1.rss / 2 ** 20),
    outKBps: Math.round((s1.bytesOut - s0.bytesOut) / dt / 1024),
    framesReceivedPerClientPerSec: +(received / n / (SECONDS + 3)).toFixed(1),
  };
}

const rows = [];
let port = 8200;
for (const n of NS) {
  const row = await run(n, port++);
  console.log(JSON.stringify(row));
  rows.push(row);
}
const out = join(ROOT, "docs", "lab-07");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, `load-${LABEL}.json`),
  `${JSON.stringify({ collisions: COLLISIONS, seconds: SECONDS, node: process.version, cpus: (await import("node:os")).cpus().length, rows }, null, 2)}\n`,
);
