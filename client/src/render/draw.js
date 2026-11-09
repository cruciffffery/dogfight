import { lerpAngle } from "@dogfight/shared/sim/physics.js";
import { screenSpace, worldSpace } from "./canvas.js";

const COLORS = {
  void: "#05070d",
  arena: "#0a0f1c",
  grid: "rgba(110, 150, 255, 0.07)",
  border: "rgba(110, 150, 255, 0.35)",
  hull: "#e8edf7",
  hullEdge: "#7fa2ff",
  cockpit: "#2bd4ff",
  flameOuter: "#ff7a1a",
  flameInner: "#ffe27a",
  bullet: "#ffe27a",
  rock: "#8a7a64",
  rockEdge: "#c9b796",
  hud: "#cfe0ff",
  hudDim: "rgba(207, 224, 255, 0.55)",
  ok: "#39d98a",
  warn: "#ffb020",
  bad: "#ff4d5e",
};

export const PICKUP_COLORS = { shield: "#2bd4ff", rapid: "#ffb020", homing: "#d26bff" };
export const SKIN_COLORS = { blue: "#e8edf7", red: "#ff9a9a", green: "#9af0c0", gold: "#ffe08a" };

/** Спрайти (Лаба 3). Якщо аркуш не завантажився — малюємо векторні фігури з Лаби 1–2. */
let sprites = null;
export function setSprites(s) {
  sprites = s;
}

/** Детермінований ГПВЧ — зоряне небо й форми астероїдів однакові при кожному запуску. */
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

export function createStarfield(arena, count = 260, seed = 1337) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    x: rand() * arena.width,
    y: rand() * arena.height,
    r: 0.4 + rand() * 1.4,
    a: 0.25 + rand() * 0.6,
  }));
}

export function drawBackground(view, arena, stars) {
  const { ctx } = view;
  screenSpace(view);
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, view.cssWidth, view.cssHeight);

  worldSpace(view);
  ctx.fillStyle = COLORS.arena;
  ctx.fillRect(0, 0, arena.width, arena.height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= arena.width; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, arena.height);
  }
  for (let y = 0; y <= arena.height; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(arena.width, y);
  }
  ctx.stroke();

  ctx.fillStyle = COLORS.hull;
  for (const s of stars) {
    ctx.globalAlpha = s.a;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, arena.width, arena.height);
}

/** Позиція між попереднім і поточним кроком з урахуванням перельоту через край. */
export function lerpPos(prev, cur, t, arena) {
  let px = prev.x;
  let py = prev.y;
  if (cur.x - px > arena.width / 2) px += arena.width;
  else if (px - cur.x > arena.width / 2) px -= arena.width;
  if (cur.y - py > arena.height / 2) py += arena.height;
  else if (py - cur.y > arena.height / 2) py -= arena.height;
  return { x: px + (cur.x - px) * t, y: py + (cur.y - py) * t };
}

// ---------- форми в локальних координатах (ніс дивиться вправо) ----------

function shipShape(ctx, ship, time) {
  if (sprites) {
    const name = `ship-${ship.skin ?? "blue"}${ship.thrust ? "-thrust" : ""}`;
    if (sprites.draw(ctx, name, sprites.naturalSize(name))) return;
  }
  if (ship.thrust) {
    const flicker = 0.75 + 0.25 * Math.sin(time * 0.045) + 0.15 * Math.sin(time * 0.13);
    const len = 22 * flicker;
    ctx.fillStyle = COLORS.flameOuter;
    ctx.beginPath();
    ctx.moveTo(-10, -6);
    ctx.lineTo(-10 - len, 0);
    ctx.lineTo(-10, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.flameInner;
    ctx.beginPath();
    ctx.moveTo(-10, -3);
    ctx.lineTo(-10 - len * 0.55, 0);
    ctx.lineTo(-10, 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = SKIN_COLORS[ship.skin] ?? COLORS.hull;
  ctx.strokeStyle = COLORS.hullEdge;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(-12, -13);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, 13);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.cockpit;
  ctx.beginPath();
  ctx.ellipse(4, 0, 5, 3, 0, 0, Math.PI * 2);
  ctx.fill();
}

const rockCache = new Map();
function rockPolygon(seed, radius) {
  const key = `${seed}:${radius.toFixed(1)}`;
  let pts = rockCache.get(key);
  if (!pts) {
    const rand = mulberry32(seed);
    const n = 9 + Math.floor(rand() * 5);
    pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = radius * (0.75 + rand() * 0.3);
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    rockCache.set(key, pts);
  }
  return pts;
}

function asteroidShape(ctx, a) {
  if (sprites && !a.homing) {
    // кадр намальовано з радіусом 44 px у клітинці 96 px
    if (sprites.draw(ctx, `asteroid-${a.shapeSeed % 4}`, (96 * a.radius) / 44)) return;
  }
  const pts = rockPolygon(a.shapeSeed, a.radius);
  ctx.fillStyle = COLORS.rock;
  ctx.strokeStyle = a.homing ? PICKUP_COLORS.homing : COLORS.rockEdge;
  ctx.lineWidth = a.homing ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function bulletShape(ctx, b) {
  if (sprites?.draw(ctx, b.homing ? "bullet-homing" : "bullet", 48)) return;
  ctx.fillStyle = b.homing ? PICKUP_COLORS.homing : COLORS.bullet;
  ctx.fillRect(-7, -1.5, 12, 3);
}

function pickupShape(ctx, p) {
  const pulse = 1 + 0.12 * Math.sin(p.age * 6);
  ctx.scale(pulse, pulse);
  if (sprites?.draw(ctx, `pickup-${p.type}`, 52)) return;
  ctx.strokeStyle = PICKUP_COLORS[p.type];
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = PICKUP_COLORS[p.type];
  ctx.font = "bold 13px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.type[0].toUpperCase(), 0, 1);
}

/**
 * Малює сутність у кількох копіях біля країв арени, щоб перехід через край був безшовним.
 * `shape(ctx, entity)` малює в локальних координатах.
 */
function drawWrapped(ctx, arena, x, y, angle, radius, shape) {
  const m = radius + 24;
  const xs = [x];
  const ys = [y];
  if (x < m) xs.push(x + arena.width);
  if (x > arena.width - m) xs.push(x - arena.width);
  if (y < m) ys.push(y + arena.height);
  if (y > arena.height - m) ys.push(y - arena.height);
  for (const px of xs) {
    for (const py of ys) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      shape();
      ctx.restore();
    }
  }
}

function drawExplosion(ctx, e) {
  const k = Math.max(0, e.ttl / e.maxTtl);
  ctx.globalAlpha = k;
  ctx.fillStyle = e.color;
  for (const p of e.particles) ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  ctx.globalAlpha = 1;
}

function drawHealthBar(ctx, x, y, ship) {
  const w = 36;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - w / 2, y - 30, w, 5);
  const k = ship.hp / 100;
  ctx.fillStyle = k > 0.5 ? COLORS.ok : k > 0.25 ? COLORS.warn : COLORS.bad;
  ctx.fillRect(x - w / 2, y - 30, w * k, 5);
  if (ship.effects?.shield > 0) {
    ctx.strokeStyle = PICKUP_COLORS.shield;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/**
 * Малює всі сутності світу з інтерполяцією між prev і поточним станом.
 * Рендер лише ЧИТАЄ світ — нічого в ньому не змінює.
 */
export function drawWorld(view, world, alpha, time) {
  const { ctx } = view;
  const arena = world.arena;
  worldSpace(view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, arena.width, arena.height);
  ctx.clip();

  for (const e of world) {
    if (!e.alive) continue;
    if (e.kind === "explosion") {
      drawExplosion(ctx, e);
      continue;
    }
    if (e.kind === "ship" && e.destroyed) continue;
    const p = lerpPos(e.prevPos, e.pos, alpha, arena);
    const angle = lerpAngle(e.prevAngle, e.angle, alpha);
    switch (e.kind) {
      case "ship":
        drawWrapped(ctx, arena, p.x, p.y, angle, e.radius, () => shipShape(ctx, e, time));
        drawHealthBar(ctx, p.x, p.y, e);
        break;
      case "asteroid":
        drawWrapped(ctx, arena, p.x, p.y, angle, e.radius, () => asteroidShape(ctx, e));
        break;
      case "bullet":
        drawWrapped(ctx, arena, p.x, p.y, angle, e.radius, () => bulletShape(ctx, e));
        break;
      case "pickup":
        drawWrapped(ctx, arena, p.x, p.y, 0, e.radius, () => pickupShape(ctx, e));
        break;
    }
  }
  ctx.restore();
}

function rateColor(value, target) {
  const err = Math.abs(value - target) / target;
  if (err < 0.05) return COLORS.ok;
  if (err < 0.2) return COLORS.warn;
  return COLORS.bad;
}

/** HUD у CSS-пікселях: метрики циклу + довільні рядки + гістограма часу кадру. */
export function drawHud(view, stats, info) {
  const { ctx } = view;
  screenSpace(view);

  const x = 14;
  let y = 14;
  const lh = 18;
  const panelW = 300;

  ctx.fillStyle = "rgba(5, 7, 13, 0.72)";
  ctx.fillRect(x - 8, y - 8, panelW, lh * (5 + info.lines.length) + 74);

  ctx.font = "600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const row = (label, value, color = COLORS.hud) => {
    ctx.fillStyle = COLORS.hudDim;
    ctx.fillText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x + 120, y);
    y += lh;
  };

  row("steps/s", stats.stepsPerSec.toFixed(1), rateColor(stats.stepsPerSec, info.targetSteps));
  row("frames/s", stats.framesPerSec.toFixed(1));
  row(
    "frame time",
    `${stats.frameTime.toFixed(2)} ms`,
    stats.frameTime > 1000 / 60 + 2 ? COLORS.warn : COLORS.hud,
  );
  row("work time", `${stats.workTime.toFixed(2)} ms`);
  row("loop", `${stats.scheduler} · ${stats.timestep}`);

  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  for (const line of info.lines) {
    ctx.fillStyle = line.color ?? COLORS.hudDim;
    ctx.fillText(line.text, x, y);
    y += lh;
  }

  y += 6;
  const h = 48;
  const w = panelW - 16;
  const n = stats.history.length;
  const bw = w / n;
  const maxMs = 50;
  ctx.strokeStyle = "rgba(207, 224, 255, 0.25)";
  ctx.lineWidth = 1;
  const budgetY = y + h - (16.7 / maxMs) * h;
  ctx.beginPath();
  ctx.moveTo(x, budgetY);
  ctx.lineTo(x + w, budgetY);
  ctx.stroke();
  for (let i = 0; i < n; i++) {
    const ms = stats.history[(stats.historyIndex + i) % n];
    if (ms <= 0) continue;
    const bh = Math.min(h, (ms / maxMs) * h);
    ctx.fillStyle = ms > 16.7 + 1 ? COLORS.bad : COLORS.ok;
    ctx.fillRect(x + i * bw, y + h - bh, Math.max(1, bw - 0.3), bh);
  }
}

/** Великий рахунок по центру зверху. */
export function drawScore(view, text) {
  const { ctx } = view;
  screenSpace(view);
  ctx.font = "700 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.hud;
  ctx.fillText(text, view.cssWidth / 2, 14);
  ctx.textAlign = "left";
}

export function drawBanner(view, text, color = COLORS.warn) {
  const { ctx } = view;
  screenSpace(view);
  ctx.font = "600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const w = ctx.measureText(text).width + 24;
  const bx = view.cssWidth - w - 14;
  ctx.fillStyle = "rgba(5, 7, 13, 0.8)";
  ctx.fillRect(bx, 10, w, 28);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 12, 24);
  ctx.textBaseline = "top";
}
