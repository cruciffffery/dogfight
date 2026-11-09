/**
 * Система колізій — генерує пари (a, b). Що з ними робити, вирішує rules.ts.
 * Сигнатура CollisionSystem дозволяє підставити просторовий хеш (Лаба 7).
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

/** Наївний пошук: кожен з кожним, O(n²). */
export function* naiveCollisions(world: World): Generator<CollisionPair> {
  const list: GameEntity[] = [];
  for (const e of world) if (e.alive && e.collidable) list.push(e);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b && circlesOverlap(a, b, world.arena)) yield [a, b];
    }
  }
}
