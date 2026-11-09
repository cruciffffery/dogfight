/**
 * Одноразовий генератор ігрових ресурсів (Лаба 3): спрайт-аркуш і звуки.
 * Усе намальовано/синтезовано кодом — жодних чужих ліцензій.
 *
 *   npm i -D sharp && node scripts/make-assets.mjs
 *
 * Результат лежить у public/assets/ і закомічений, тож запускати це для гри не потрібно.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require("sharp");
} catch {
  sharp = createRequire("/opt/npm-tools/node_modules/")("sharp");
}

const OUT = join(import.meta.dirname, "..", "public", "assets");
mkdirSync(join(OUT, "sprites"), { recursive: true });
mkdirSync(join(OUT, "sounds"), { recursive: true });

// ---------------- спрайти ----------------
const CELL = 96; // спрайт удвічі більший за ігровий розмір — чіткий на retina
const COLS = 8;
const ROWS = 3;
const SHIP_SCALE = 1.45; // полум'я (-32) має влізти в клітинку: 48 - 32·1.45 > 0
const SHIP_COLORS = [
  ["blue", "#e8edf7", "#7fa2ff"],
  ["red", "#ff9a9a", "#ff4d5e"],
  ["green", "#9af0c0", "#39d98a"],
  ["gold", "#ffe08a", "#ffb020"],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const atlas = { cell: CELL, frames: {} };
const parts = [];
const at = (col, row) => [col * CELL, row * CELL];

function cell(name, col, row, svgBody, { anchor = [0.5, 0.5], scale = 2 } = {}) {
  const [x, y] = at(col, row);
  atlas.frames[name] = { x, y, w: CELL, h: CELL, anchor, scale };
  parts.push(`<g transform="translate(${x} ${y})">${svgBody}</g>`);
}

// Кораблі: ніс вправо, центр клітинки = центр корабля; масштаб SHIP_SCALE від ігрових координат
function shipSvg(fill, edge, flame) {
  const c = CELL / 2;
  const s = SHIP_SCALE;
  const p = (pts) => pts.map(([px, py]) => `${c + px * s},${c + py * s}`).join(" ");
  const flameSvg = flame
    ? `<polygon points="${p([
        [-10, -6],
        [-32, 0],
        [-10, 6],
      ])}" fill="#ff7a1a"/><polygon points="${p([
        [-10, -3],
        [-22, 0],
        [-10, 3],
      ])}" fill="#ffe27a"/>`
    : "";
  return `${flameSvg}
    <polygon points="${p([
      [20, 0],
      [-12, -13],
      [-6, 0],
      [-12, 13],
    ])}" fill="${fill}" stroke="${edge}" stroke-width="4" stroke-linejoin="round"/>
    <polygon points="${p([
      [14, 0],
      [-4, -6],
      [-1, 0],
      [-4, 6],
    ])}" fill="${edge}" opacity="0.35"/>
    <ellipse cx="${c + 4 * s}" cy="${c}" rx="${5 * s}" ry="${3 * s}" fill="#2bd4ff"/>`;
}

SHIP_COLORS.forEach(([name, fill, edge], i) => {
  cell(`ship-${name}`, i * 2, 0, shipSvg(fill, edge, false), { scale: SHIP_SCALE });
  cell(`ship-${name}-thrust`, i * 2 + 1, 0, shipSvg(fill, edge, true), { scale: SHIP_SCALE });
});

// Астероїди: 4 варіанти, радіус клітинки 46 → масштабуються під radius сутності
for (let v = 0; v < 4; v++) {
  const rand = mulberry32(100 + v);
  const n = 10 + v;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 44 * (0.78 + rand() * 0.22);
    pts.push(`${48 + Math.cos(a) * r},${48 + Math.sin(a) * r}`);
  }
  const craters = Array.from({ length: 4 }, () => {
    const a = rand() * Math.PI * 2;
    const r = rand() * 22;
    return `<circle cx="${48 + Math.cos(a) * r}" cy="${48 + Math.sin(a) * r}" r="${4 + rand() * 6}" fill="#6d604e"/>`;
  }).join("");
  cell(
    `asteroid-${v}`,
    v,
    1,
    `<polygon points="${pts.join(" ")}" fill="#8a7a64" stroke="#c9b796" stroke-width="3"/>${craters}`,
    { scale: 46 / 44 },
  );
}

cell(
  "bullet",
  4,
  1,
  `<rect x="34" y="45" width="28" height="6" rx="3" fill="#ffe27a"/><rect x="50" y="46.5" width="12" height="3" rx="1.5" fill="#fff"/>`,
);
cell(
  "bullet-homing",
  5,
  1,
  `<rect x="34" y="45" width="28" height="6" rx="3" fill="#d26bff"/><rect x="50" y="46.5" width="12" height="3" rx="1.5" fill="#fff"/>`,
);

const PICKUPS = [
  ["shield", "#2bd4ff", "S"],
  ["rapid", "#ffb020", "R"],
  ["homing", "#d26bff", "H"],
];
PICKUPS.forEach(([name, color, letter], i) => {
  cell(
    `pickup-${name}`,
    i,
    2,
    `<circle cx="48" cy="48" r="22" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="5"/>
     <text x="48" y="57" font-family="monospace" font-weight="bold" font-size="26" text-anchor="middle" fill="${color}">${letter}</text>`,
  );
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL}" height="${ROWS * CELL}">${parts.join("")}</svg>`;
await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile(join(OUT, "sprites", "sheet.png"));
writeFileSync(join(OUT, "sprites", "atlas.json"), `${JSON.stringify(atlas, null, 2)}\n`);

// ---------------- звуки (WAV, 22.05 кГц, 16 біт, моно) ----------------
const RATE = 22050;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function synth(seconds, fn) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  const rand = mulberry32(7);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const r = fn(t, i / n, rand);
    phase += (2 * Math.PI * r.freq) / RATE;
    out[i] = r.mix(phase) * r.env;
  }
  return Array.from(out);
}

const SOUNDS = {
  shoot: synth(0.12, (_t, k) => ({
    freq: 1400 - 1000 * k,
    env: (1 - k) ** 2 * 0.5,
    mix: (ph) => (Math.sin(ph) > 0 ? 1 : -1) * 0.5,
  })),
  hit: synth(0.09, (_t, k, rand) => ({
    freq: 300,
    env: (1 - k) ** 3 * 0.7,
    mix: (ph) => 0.6 * (rand() * 2 - 1) + 0.4 * Math.sin(ph),
  })),
  explosion: synth(0.7, (_t, k, rand) => ({
    freq: 70 - 40 * k,
    env: (1 - k) ** 2.2 * 0.9,
    mix: (ph) => 0.75 * (rand() * 2 - 1) * (0.6 + 0.4 * Math.sin(ph)) + 0.25 * Math.sin(ph),
  })),
  pickup: synth(0.3, (_t, k) => ({
    freq: k < 0.33 ? 660 : k < 0.66 ? 880 : 1320,
    env: (1 - k) * 0.4,
    mix: (ph) => Math.sin(ph),
  })),
  // «ембієнт» — найбільший файл; у dev сервер навмисно віддає його повільно (vite.config.js)
  ambient: synth(6, (t, _k, rand) => ({
    freq: 55 + 3 * Math.sin(t * 0.7),
    env: 0.18 * (0.6 + 0.4 * Math.sin(t * 0.9)) * Math.min(1, t * 2, (6 - t) * 2),
    mix: (ph) => Math.sin(ph) + 0.3 * Math.sin(ph * 1.5) + 0.05 * (rand() * 2 - 1),
  })),
};

for (const [name, samples] of Object.entries(SOUNDS)) {
  writeFileSync(join(OUT, "sounds", `${name}.wav`), wav(samples));
}

console.log("sprites + sounds written to", OUT);
