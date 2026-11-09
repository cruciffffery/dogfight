/**
 * Відбиток стану світу: FNV-1a по бітах float64 позицій, швидкостей і кутів.
 * Однакові входи → однаковий хеш у Node і в браузері.
 */

import type { World } from "./sim/world.ts";
import type { SeqCommand } from "./types.ts";

const buf = new DataView(new ArrayBuffer(8));

function fnv(hash: number, value: number): number {
  buf.setFloat64(0, value, true);
  let h = hash;
  for (let i = 0; i < 8; i++) {
    h ^= buf.getUint8(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function worldHash(world: World): string {
  let h = 0x811c9dc5;
  for (const e of world) {
    if (!e.alive) continue;
    h = fnv(h, e.id);
    h = fnv(h, e.pos.x);
    h = fnv(h, e.pos.y);
    h = fnv(h, e.vel.x);
    h = fnv(h, e.vel.y);
    h = fnv(h, e.angle);
  }
  return h.toString(16).padStart(8, "0");
}

export interface ScenarioResult {
  hash: string;
  tick: number;
  entities: number;
  scores: [number, number][];
}

/** Еталонний сценарій: 2 кораблі зі скриптованими командами, 10 с при 30 Гц. */
export async function runScenario({ ticks = 300 } = {}): Promise<ScenarioResult> {
  const { Entity } = await import("./sim/entity.ts");
  const { World, spawnAsteroid } = await import("./sim/world.ts");
  const { Ship } = await import("./sim/entities/ship.ts");
  const { Vector2 } = await import("./sim/vector.ts");
  Entity.resetIds();
  const world = new World({ seed: 42 });
  const a = world.spawn(new Ship({ pos: new Vector2(400, 450) }));
  const b = world.spawn(new Ship({ pos: new Vector2(1200, 450), angle: Math.PI }));
  for (let i = 0; i < 6; i++) spawnAsteroid(world);
  const inputs = new Map<typeof a.id, SeqCommand>();
  for (let t = 1; t <= ticks; t++) {
    inputs.set(a.id, {
      seq: t,
      turn: t % 90 < 30 ? 1 : 0,
      thrust: t % 50 < 35,
      brake: false,
      fire: t % 7 === 0,
    });
    inputs.set(b.id, {
      seq: t,
      turn: t % 70 < 20 ? -1 : 0,
      thrust: t % 40 < 30,
      brake: t % 100 > 90,
      fire: t % 11 === 0,
    });
    world.step(1 / 30, inputs);
    world.drainEvents();
  }
  return {
    hash: worldHash(world),
    tick: world.tick,
    entities: world.size,
    scores: [...world.scores],
  };
}
