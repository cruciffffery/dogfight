/**
 * Система колізій — генерує пари (a, b). Що з ними робити, вирішує rules.ts.
 * Дві реалізації з однаковою сигнатурою CollisionSystem:
 *   naiveCollisions   — кожен з кожним, O(n²) (Лаба 2)
 *   spatialHashCollisions — сітка комірок, ~O(n) (Лаба 7)
 *
 * Для куль перевірка «зметена» (swept): чи перетинались кола будь-коли ЗА крок,
 * а не лише в кінці кроку. Інакше швидка куля перестрибує корабель (тунелювання).
 */
import { type Arena, torusDelta } from "./arena.ts";
import type { Entity } from "./entity.ts";
import type { GameEntity, World } from "./world.ts";

export type CollisionPair = readonly [GameEntity, GameEntity];
export type CollisionSystem = (world: World) => Iterable<CollisionPair>;

export function circlesOverlap(a: Entity, b: Entity, arena: Arena): boolean {
  const d = torusDelta(a.pos, b.pos, arena);
  const r = a.radius + b.radius;
  return d.x * d.x + d.y * d.y < r * r;
}

/**
 * Мінімальна відстань між центрами протягом кроку (рух вважаємо лінійним).
 * d0 — вектор b→a на початку кроку, d1 — в кінці; шукаємо найближчу до нуля точку відрізка.
 */
export function sweptOverlap(a: Entity, b: Entity, arena: Arena): boolean {
  const r = a.radius + b.radius;
  const d1 = torusDelta(b.pos, a.pos, arena);
  if (d1.x * d1.x + d1.y * d1.y < r * r) return true;
  const d0 = torusDelta(b.prevPos, a.prevPos, arena);
  const ex = d1.x - d0.x;
  const ey = d1.y - d0.y;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return false;
  const t = Math.max(0, Math.min(1, -(d0.x * ex + d0.y * ey) / len2));
  const cx = d0.x + ex * t;
  const cy = d0.y + ey * t;
  return cx * cx + cy * cy < r * r;
}

function collide(a: GameEntity, b: GameEntity, arena: Arena): boolean {
  return a.kind === "bullet" || b.kind === "bullet"
    ? sweptOverlap(a, b, arena)
    : circlesOverlap(a, b, arena);
}

function collidables(world: World): GameEntity[] {
  const list: GameEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);
  return list;
}

/** Наївний пошук: кожен з кожним, O(n²). */
export function* naiveCollisions(world: World): Generator<CollisionPair> {
  const list = collidables(world);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b && collide(a, b, world.arena)) yield [a, b];
    }
  }
}

/**
 * Просторовий хеш: арена ділиться на комірки CELL×CELL; кожна сутність потрапляє в усі
 * комірки, які перекриває її «рамка» (з урахуванням руху за крок і загортання країв).
 * Перевіряються лише пари, що ділять комірку. Порядок пар — детермінований.
 */
export function createSpatialHash(cell = 96): CollisionSystem {
  return function* spatialHashCollisions(world: World): Generator<CollisionPair> {
    const { width, height } = world.arena;
    const cols = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const buckets = new Map<number, number[]>();
    const list = collidables(world);

    list.forEach((e, index) => {
      // рамка покриває і поточну, і попередню позицію (для зметеної перевірки куль)
      const dx = torusDelta(e.pos, e.prevPos, world.arena);
      const minX = Math.min(e.pos.x, e.pos.x + dx.x) - e.radius;
      const maxX = Math.max(e.pos.x, e.pos.x + dx.x) + e.radius;
      const minY = Math.min(e.pos.y, e.pos.y + dx.y) - e.radius;
      const maxY = Math.max(e.pos.y, e.pos.y + dx.y) + e.radius;
      const c0 = Math.floor(minX / cell);
      const c1 = Math.floor(maxX / cell);
      const r0 = Math.floor(minY / cell);
      const r1 = Math.floor(maxY / cell);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = (((r % rows) + rows) % rows) * cols + (((c % cols) + cols) % cols);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
          }
          if (bucket.at(-1) !== index) bucket.push(index);
        }
      }
    });

    const seen = new Set<number>();
    const pairs: [number, number][] = [];
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const ia = bucket[i] ?? 0;
        for (let j = i + 1; j < bucket.length; j++) {
          const ib = bucket[j] ?? 0;
          const lo = Math.min(ia, ib);
          const hi = Math.max(ia, ib);
          const key = lo * 65536 + hi;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push([lo, hi]);
        }
      }
    }
    // Той самий порядок, що й у наївній версії → ідентична симуляція
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [i, j] of pairs) {
      const a = list[i];
      const b = list[j];
      if (a && b && collide(a, b, world.arena)) yield [a, b];
    }
  };
}

export const spatialHashCollisions: CollisionSystem = createSpatialHash();
