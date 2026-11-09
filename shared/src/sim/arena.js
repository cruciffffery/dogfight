import { Vector2 } from "./vector.js";

/**
 * Арена має фіксований розмір у «світових» пікселях і не залежить від вікна браузера.
 */
export const ARENA = Object.freeze({ width: 1600, height: 900 });

export function createArena(width = ARENA.width, height = ARENA.height) {
  return Object.freeze({ width, height });
}

function mod(v, m) {
  return ((v % m) + m) % m;
}

/** «Загортання» країв (тор): вилетів праворуч — з'явився ліворуч. */
export function wrapPos(pos, arena) {
  const x = mod(pos.x, arena.width);
  const y = mod(pos.y, arena.height);
  return x === pos.x && y === pos.y ? pos : new Vector2(x, y);
}

/** Найкоротший вектор від a до b на торі (для наведення й колізій через край). */
export function torusDelta(a, b, arena) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (dx > arena.width / 2) dx -= arena.width;
  else if (dx < -arena.width / 2) dx += arena.width;
  if (dy > arena.height / 2) dy -= arena.height;
  else if (dy < -arena.height / 2) dy += arena.height;
  return new Vector2(dx, dy);
}
