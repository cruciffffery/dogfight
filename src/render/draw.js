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
  hud: "#cfe0ff",
  hudDim: "rgba(207, 224, 255, 0.55)",
  ok: "#39d98a",
  warn: "#ffb020",
  bad: "#ff4d5e",
};

/** Детермінований ГПВЧ (mulberry32) — зоряне небо однакове при кожному запуску. */
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

  // сітка — щоб рух було видно навіть без зірок
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

  for (const s of stars) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = COLORS.hull;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, arena.width, arena.height);
}

/** Корабель у локальних координатах: ніс дивиться вправо (+x), центр у (0, 0). */
function shipShape(ctx, ship, time) {
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

  ctx.fillStyle = COLORS.hull;
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

/**
 * Малює корабель через translate/rotate. Біля краю арени малюємо ще й «привид»
 * з іншого боку — так перетин межі виглядає безшовно.
 */
export function drawShip(view, arena, ship, time) {
  const { ctx } = view;
  worldSpace(view);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, arena.width, arena.height);
  ctx.clip();

  const margin = 40;
  const xs = [ship.x];
  const ys = [ship.y];
  if (ship.x < margin) xs.push(ship.x + arena.width);
  if (ship.x > arena.width - margin) xs.push(ship.x - arena.width);
  if (ship.y < margin) ys.push(ship.y + arena.height);
  if (ship.y > arena.height - margin) ys.push(ship.y - arena.height);

  for (const x of xs) {
    for (const y of ys) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ship.angle);
      shipShape(ctx, ship, time);
      ctx.restore();
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

/** HUD у CSS-пікселях: steps/s, frames/s, час кадру + гістограма останніх кадрів. */
export function drawHud(view, stats, info) {
  const { ctx } = view;
  screenSpace(view);

  const x = 14;
  let y = 14;
  const lh = 18;
  const panelW = 300;

  ctx.fillStyle = "rgba(5, 7, 13, 0.72)";
  ctx.fillRect(x - 8, y - 8, panelW, lh * (7 + info.lines.length) + 74);

  ctx.font = "600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

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
  row("alpha", stats.alpha.toFixed(3));
  row("loop", `${stats.scheduler} · ${stats.timestep}`);
  row("steps total", String(stats.totalSteps));

  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  for (const line of info.lines) {
    ctx.fillStyle = line.color ?? COLORS.hudDim;
    ctx.fillText(line.text, x, y);
    y += lh;
  }

  // Гістограма frameTime (stretch): 240 останніх кадрів, червоне — понад 16.7 мс
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
