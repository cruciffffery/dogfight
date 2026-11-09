/**
 * Доказ backpressure (Лаба 4, M3).
 *
 *   node scripts/backpressure.js            → docs/lab-04/backpressure.csv
 *
 * 1. Генерує синтетичний журнал матчу на ~200 МБ.
 * 2. Запускає сервер окремим процесом (ENABLE_DEBUG_ROUTES=1).
 * 3. Для кожного режиму (pipeline / buffer / nopipe) завантажує файл «повільним клієнтом»
 *    (~20 МБ/с — як «тротлінг» у DevTools) і кожні 200 мс знімає rss сервера з /api/stats.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LOG_DIR = process.env.LOG_DIR ?? join(ROOT, "logs");
const OUT = join(ROOT, "..", "docs", "lab-04");
const PORT = 8099;
const SIZE = Number(process.env.SIZE_MB ?? 200) * 1024 * 1024;
const RATE = Number(process.env.RATE_MB ?? 20) * 1024 * 1024; // байт/с

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });
const file = join(LOG_DIR, "synthetic-200mb.ndjson");

async function generate() {
  if (existsSync(file) && statSync(file).size >= SIZE) return;
  const out = createWriteStream(file);
  let written = 0;
  let t = Date.now();
  while (written < SIZE) {
    const line = `${JSON.stringify({
      t: t++,
      room: "synthetic",
      type: "snapshot",
      tick: written,
      ships: [
        { id: 1, x: 12.5, y: 99.25, a: 1.57 },
        { id: 2, x: 812.5, y: 399.25, a: -1.2 },
      ],
    })}\n`;
    written += line.length;
    if (!out.write(line)) await once(out, "drain"); // і генератор поважає backpressure
  }
  out.end();
  await once(out, "finish");
}

const get = (path) =>
  new Promise((resolve, reject) => {
    request({ port: PORT, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body)));
    })
      .on("error", reject)
      .end();
  });

function slowDownload(path) {
  return new Promise((resolve, reject) => {
    request({ port: PORT, path }, (res) => {
      let received = 0;
      const t0 = performance.now();
      res.on("data", (chunk) => {
        received += chunk.length;
        // читаємо не швидше за RATE: якщо випередили графік — пауза
        const ahead = received / RATE - (performance.now() - t0) / 1000;
        if (ahead > 0) {
          res.pause();
          setTimeout(() => res.resume(), ahead * 1000);
        }
      });
      res.on("end", () => resolve(received));
      res.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
}

await generate();
console.log(`file: ${(statSync(file).size / 1e6).toFixed(0)} MB`);

async function startServer() {
  const server = spawn(process.execPath, ["src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LOG_DIR, ENABLE_DEBUG_ROUTES: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => server.stdout.once("data", r));
  return server;
}

const rows = ["mode,t_s,rss_mb"];
for (const mode of ["pipeline", "nopipe", "buffer"]) {
  // окремий процес на кожен режим — чесна базова лінія RSS
  const server = await startServer();
  const t0 = performance.now();
  let peak = 0;
  const sampler = setInterval(async () => {
    const { rss } = await get("/api/stats");
    const mb = rss / 1024 / 1024;
    peak = Math.max(peak, mb);
    rows.push(`${mode},${((performance.now() - t0) / 1000).toFixed(1)},${mb.toFixed(1)}`);
  }, 200);
  const q = mode === "pipeline" ? "" : `?mode=${mode}`;
  const bytes = await slowDownload(`/api/replays/synthetic-200mb${q}`);
  clearInterval(sampler);
  console.log(
    `${mode.padEnd(8)} ${(bytes / 1e6).toFixed(0)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, peak rss ${peak.toFixed(0)} MB`,
  );
  server.kill("SIGTERM");
  await once(server, "exit");
}
writeFileSync(join(OUT, "backpressure.csv"), `${rows.join("\n")}\n`);
console.log("→ docs/lab-04/backpressure.csv");
