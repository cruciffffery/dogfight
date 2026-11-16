/**
 * Профіль клієнта (Лаба 7, M3): 30 с бою з 8 серверними ботами і стрільбою без перерви.
 *
 *   npm run build
 *   node scripts/profile-client.mjs before        → docs/lab-07/profile-before.json (+ .cpuprofile)
 *
 * Через Chrome DevTools Protocol знімає одночасно:
 *   Profiler (CPU, self time) · HeapProfiler.sampling (хто алокує) · Tracing (паузи GC)
 * а зі сторінки — інтервали між кадрами (rAF) і performance.measure (simulate/render/decode/reconcile).
 * Змінна PW_CHROMIUM — шлях до Chromium, якщо Playwright-браузер не встановлено.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const label = process.argv[2] ?? "run";
const SECONDS = Number(process.env.SECONDS ?? 30);
const PORT = 8096;
const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "lab-07");
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ["server/src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    MAX_PLAYERS_PER_ROOM: "16",
    LOG_DIR: "/tmp/dogfight-profile",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const base = `http://localhost:${PORT}`;
// Чекаємо, поки сервер реально слухає порт: перший рядок логу (room.created) з'являється раніше.
for (let i = 0; i < 100; i++) {
  if (
    await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await new Promise((r) => setTimeout(r, 100));
}
await fetch(`${base}/api/rooms/rocks/bots`, { method: "POST", body: JSON.stringify({ count: 8 }) });

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  args: ["--headless=new", "--js-flags=--expose-gc"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${base}/?room=rocks&name=Prof&fast&perf`);
await page.waitForFunction(() => window.__lab?.game !== undefined);
await page.waitForTimeout(3000);

const cdp = await page.context().newCDPSession(page);
// THROTTLE=4 — сповільнити CPU у 4 рази (як слабкий ноутбук): на швидкій машині 60 fps тримаються
// і до оптимізації, тож різницю в кадрах видно лише під навантаженням.
const THROTTLE = Number(process.env.THROTTLE ?? 1);
if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("HeapProfiler.enable");
const traceEvents = [];
cdp.on("Tracing.dataCollected", (e) => traceEvents.push(...e.value));
const traceDone = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
await cdp.send("Tracing.start", {
  categories: "devtools.timeline,v8,disabled-by-default-v8.gc",
  transferMode: "ReportEvents",
});
await cdp.send("Profiler.start");
await cdp.send("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  // інакше профіль покаже лише ті алокації, що ДОЖИЛИ до кінця, — а сміття і є проблема
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
await page.evaluate(() => {
  window.__lab.perf(true);
  const deltas = [];
  let last = performance.now();
  const tick = (t) => {
    deltas.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__frameDeltas = deltas;
});

// Важкий бій: вогонь без перерви, газ і повороти по черзі
const k = page.keyboard;
await k.down("Space");
const end = Date.now() + SECONDS * 1000;
let i = 0;
while (Date.now() < end) {
  const turn = i % 2 ? "ArrowLeft" : "ArrowRight";
  await k.down("ArrowUp");
  await k.down(turn);
  await page.waitForTimeout(450);
  await k.up(turn);
  await page.waitForTimeout(350);
  await k.up("ArrowUp");
  await page.waitForTimeout(200);
  i++;
}
await k.up("Space");

const { profile } = await cdp.send("Profiler.stop");
const { profile: heap } = await cdp.send("HeapProfiler.stopSampling");
await cdp.send("Tracing.end");
await traceDone;
const page_ = await page.evaluate(() => ({
  deltas: window.__frameDeltas.slice(1),
  perf: window.__lab.perf(),
  entities: window.__lab.game.buffer.items.at(-1)?.snap.entities.length ?? 0,
}));
await browser.close();
const stats = await (await fetch(`${base}/api/stats`)).json();
server.kill("SIGTERM");

// ---------- обробка ----------
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(2);
};
const where = (cf) =>
  `${cf.functionName || "(anonymous)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`;

// GC з траси: MinorGC = Scavenge (молоде покоління), MajorGC = Mark-Compact (старе)
const gc = { minor: { count: 0, ms: 0 }, major: { count: 0, ms: 0 } };
for (const e of traceEvents) {
  if (e.ph !== "X" || !e.dur) continue;
  if (e.name === "MinorGC") {
    gc.minor.count++;
    gc.minor.ms += e.dur / 1000;
  } else if (e.name === "MajorGC") {
    gc.major.count++;
    gc.major.ms += e.dur / 1000;
  }
}

// Self time з CPU-профілю
const selfMs = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
profile.samples.forEach((id, idx) => {
  const node = byId.get(id);
  const key = where(node.callFrame);
  selfMs.set(key, (selfMs.get(key) ?? 0) + (profile.timeDeltas[idx] ?? 0) / 1000);
});
const busy = [...selfMs].filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)"));
const totalMs = busy.reduce((a, [, ms]) => a + ms, 0);
const topSelf = busy
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([fn, ms]) => ({ fn, ms: +ms.toFixed(1), pct: +((100 * ms) / totalMs).toFixed(1) }));

// Хто алокує (вибірка купи)
const alloc = new Map();
(function walk(node) {
  if (node.selfSize) {
    const key = where(node.callFrame);
    alloc.set(key, (alloc.get(key) ?? 0) + node.selfSize);
  }
  for (const c of node.children ?? []) walk(c);
})(heap.head);
const allocTotal = [...alloc.values()].reduce((a, b) => a + b, 0);
const topAlloc = [...alloc]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([fn, bytes]) => ({
    fn,
    kb: Math.round(bytes / 1024),
    pct: +((100 * bytes) / allocTotal).toFixed(1),
  }));

const summary = {
  label,
  seconds: SECONDS,
  throttle: THROTTLE,
  env: {
    chromium: "141 headless",
    node: process.version,
    cpu: process.env.CPU_NAME ?? "container",
  },
  entitiesInLastSnapshot: page_.entities,
  frames: page_.deltas.length,
  frameIntervalMs: {
    p50: pct(page_.deltas, 50),
    p95: pct(page_.deltas, 95),
    p99: pct(page_.deltas, 99),
    max: pct(page_.deltas, 100),
  },
  longFrames: page_.deltas.filter((d) => d > 1000 / 60 + 4).length,
  measures: page_.perf,
  gc: {
    minor: { count: gc.minor.count, totalMs: +gc.minor.ms.toFixed(1) },
    major: { count: gc.major.count, totalMs: +gc.major.ms.toFixed(1) },
  },
  topSelfTime: topSelf,
  topAllocators: topAlloc,
  sampledAllocKB: Math.round(allocTotal / 1024),
  busyMs: +totalMs.toFixed(0),
  serverTickMs: stats.matches?.find((m) => m.room === "rocks")?.tickMs,
};
writeFileSync(join(OUT, `profile-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join("/tmp", `dogfight-${label}.cpuprofile`), JSON.stringify(profile));
writeFileSync(join("/tmp", `dogfight-${label}.heapprofile`), JSON.stringify(heap));
console.log(JSON.stringify(summary, null, 2));
