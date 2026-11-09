/**
 * Що робить синхронний 300-мс обробник з УСІМА клієнтами (Лаба 4, M4).
 *
 *   node scripts/block-demo.js
 *
 * Ann шле чат кожні 50 мс і міряє, коли повідомлення повертається до неї через сервер.
 * Через 1 с інший клієнт тричі смикає /api/slow (busy-wait 300 мс).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = 8098;
const server = spawn(process.execPath, ["src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    PORT: String(PORT),
    ENABLE_DEBUG_ROUTES: "1",
    LOG_DIR: "/tmp/dogfight-block-demo",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await once(server.stdout, "data");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await once(ws, "open");
ws.send(JSON.stringify({ v: 0, type: "join", room: "alpha", name: "Ann" }));

const sent = new Map();
const samples = [];
const t0 = performance.now();
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.type !== "chat") return;
  const at = sent.get(msg.text);
  if (at) samples.push({ t: at - t0, rtt: performance.now() - at });
});

let n = 0;
const ticker = setInterval(() => {
  const text = `ping-${n++}`;
  sent.set(text, performance.now());
  ws.send(JSON.stringify({ v: 0, type: "chat", text }));
}, 50);

setTimeout(async () => {
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    await fetch(`http://127.0.0.1:${PORT}/api/slow`);
    console.log(
      `GET /api/slow #${i + 1} at t=${(s - t0).toFixed(0)} ms took ${(performance.now() - s).toFixed(0)} ms`,
    );
  }
}, 1000);

await new Promise((r) => setTimeout(r, 3000));
clearInterval(ticker);
ws.close();
server.kill();

const fmt = (x) => x.toFixed(0).padStart(5);
console.log("\n  t, ms   chat round-trip, ms");
for (const s of samples) {
  const bar = "█".repeat(Math.min(60, Math.round(s.rtt / 10)));
  console.log(`${fmt(s.t)}   ${fmt(s.rtt)}  ${bar}`);
}
const quiet = samples.filter((s) => s.t < 900).map((s) => s.rtt);
const worst = Math.max(...samples.map((s) => s.rtt));
console.log(
  `\nбез блокування: медіана ${quiet.sort((a, b) => a - b)[Math.floor(quiet.length / 2)].toFixed(1)} мс; гірший під час /api/slow: ${worst.toFixed(0)} мс`,
);
