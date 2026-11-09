/**
 * Поведінка через композицію: «наведення» — компонент-дані + система.
 */
import { torusDelta } from "./arena.ts";
import type { Entity, Homing } from "./entity.ts";
import type { World } from "./world.ts";

/** Додає компонент наведення. Повертає ту саму сутність (зручно для ланцюжків). */
export function withHoming<E extends Entity>(
  entity: E,
  {
    targetKind,
    turnRate = 3,
    range = 400,
    ignoreId = null,
  }: Partial<Homing> & Pick<Homing, "targetKind">,
): E {
  entity.homing = { targetKind, turnRate, range, ignoreId };
  return entity;
}

/** Система: повертає швидкість кожної сутності з компонентом `homing` до найближчої цілі. */
export function homingSystem(world: World, dt: number): void {
  for (const e of world) {
    const h = e.homing;
    if (!h || !e.alive) continue;

    let best: Entity | null = null;
    let bestDist = h.range;
    for (const t of world.ofKind(h.targetKind)) {
      if (t === e || t.id === h.ignoreId) continue;
      if (t.kind === "ship" && t.destroyed) continue;
      const d = torusDelta(e.pos, t.pos, world.arena).length();
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    if (!best) continue;

    const speed = e.vel.length();
    const desired = torusDelta(e.pos, best.pos, world.arena).angle();
    let diff = desired - e.vel.angle();
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const maxTurn = h.turnRate * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
    e.vel = e.vel.rotate(turn).normalize().scale(speed);
  }
}
