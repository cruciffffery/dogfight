/**
 * Записує демо для README (Лаба 8): два гравці + боти в одній кімнаті, кадри обох вікон
 * поруч → docs/lab-08/two-players.gif; і знімок /dashboard.html під час матчу.
 *   npm run build && node scripts/record-demo.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const PORT = 8099;
const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "lab-08");
const FRAMES = "/tmp/dogfight-frames";
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const server = spawn(process.execPath, ["server/src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_LEVEL: "warn",
    LOG_DIR: "/tmp/dogfight-demo",
    APP_VERSION: "v1.0.0",
  },
  stdio: "ignore",
});
const base = `http://localhost:${PORT}`;
for (
  let i = 0;
  i < 50 &&
  !(await fetch(`${base}/ready`).then(
    (r) => r.ok,
    () => false,
  ));
  i++
)
  await new Promise((r) => setTimeout(r, 100));
await fetch(`${base}/api/rooms/rocks/bots`, { method: "POST", body: JSON.stringify({ count: 3 }) });

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  args: ["--headless=new"],
});
const open = async (name, extra) => {
  const page = await (
    await browser.newContext({ viewport: { width: 720, height: 450 } })
  ).newPage();
  await page.goto(`${base}/?room=rocks&name=${name}&fast&nosw${extra}`);
  await page.waitForFunction(() => window.__lab?.game !== undefined);
  return page;
};
const ann = await open("Ann", "&net"); // у Ann — netgraph (RTT, буфер, корекції)
const bob = await open("Bob", "");
await bob.keyboard.press("h"); // у Bob — чиста гра без HUD
await new Promise((r) => setTimeout(r, 1500));

const script = [
  [ann, ["ArrowUp", "Space"]],
  [bob, ["ArrowLeft", "ArrowUp"]],
];
for (const [page, keys] of script) for (const k of keys) await page.keyboard.down(k);
for (let f = 0; f < 60; f++) {
  if (f === 20) await ann.keyboard.down("ArrowRight");
  if (f === 35) {
    await ann.keyboard.up("ArrowRight");
    await bob.keyboard.down("Space");
  }
  if (f === 45) await bob.keyboard.up("ArrowLeft");
  const n = String(f).padStart(3, "0");
  await Promise.all([
    ann.screenshot({ path: `${FRAMES}/a${n}.png` }),
    bob.screenshot({ path: `${FRAMES}/b${n}.png` }),
  ]);
  await new Promise((r) => setTimeout(r, 60));
}

const dash = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await dash.goto(`${base}/dashboard.html`);
await new Promise((r) => setTimeout(r, 24000)); // ~12 точок на спарклайнах, гра триває
await dash.screenshot({ path: join(OUT, "dashboard.png") });
await browser.close();
server.kill("SIGTERM");

// Два вікна поруч → GIF з власною палітрою (ffmpeg palettegen/paletteuse)
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-framerate",
  "8",
  "-i",
  `${FRAMES}/a%03d.png`,
  "-framerate",
  "8",
  "-i",
  `${FRAMES}/b%03d.png`,
  "-filter_complex",
  "[0][1]hstack=inputs=2,scale=1080:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
  join(OUT, "two-players.gif"),
]);
console.log("docs/lab-08/two-players.gif, docs/lab-08/dashboard.png");
