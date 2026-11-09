/**
 * Система колізій — окремий модуль, який отримує світ і ВИДАЄ пари (a, b).
 * Що робити з парою, вирішує rules.js. Завдяки цьому наївний O(n²) пошук можна замінити
 * просторовим хешем (Лаба 7), не чіпаючи ні World, ні правил гри.
 */
import { torusDelta } from "./arena.js";

/** Перетин двох кіл з урахуванням «загортання» арени. */
export function circlesOverlap(a, b, arena) {
  const d = torusDelta(a.pos, b.pos, arena);
  const r = a.radius + b.radius;
  return d.x * d.x + d.y * d.y < r * r;
}

/** Наївний пошук: кожен з кожним. Генератор — пари віддаються по одній, без масиву. */
export function* naiveCollisions(world) {
  const list = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (circlesOverlap(a, b, world.arena)) yield [a, b];
    }
  }
}
