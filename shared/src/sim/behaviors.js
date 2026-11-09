/**
 * Поведінка через композицію: «наведення» — це компонент-дані + система.
 * Його можна причепити до будь-якої сутності з `vel` (кулі, астероїда, у майбутньому — ракети),
 * не створюючи класів HomingBullet / HomingAsteroid.
 */
import { torusDelta } from "./arena.js";

/** Додає компонент наведення. Повертає ту саму сутність (зручно для ланцюжків). */
export function withHoming(entity, { targetKind, turnRate = 3, range = 400, ignoreId = null }) {
  entity.homing = { targetKind, turnRate, range, ignoreId };
  return entity;
}

function isTargetable(e) {
  return e.alive && !e.destroyed;
}

/** Система: повертає швидкість кожної сутності з компонентом `homing` до найближчої цілі. */
export function homingSystem(world, dt) {
  for (const e of world) {
    const h = e.homing;
    if (!h || !e.alive) continue;

    let best = null;
    let bestDist = h.range;
    for (const t of world.ofKind(h.targetKind)) {
      if (t === e || t.id === h.ignoreId || !isTargetable(t)) continue;
      const d = torusDelta(e.pos, t.pos, world.arena).length();
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    if (!best) continue;

    const speed = e.vel.length();
    const current = e.vel.angle();
    const desired = torusDelta(e.pos, best.pos, world.arena).angle();
    let diff = desired - current;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // у [-π, π]
    const maxTurn = h.turnRate * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
    e.vel = e.vel.rotate(turn).normalize().scale(speed);
  }
}
