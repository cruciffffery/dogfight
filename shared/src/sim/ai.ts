/**
 * Простий «пілот» (тренувальний манекен; у Лабі 7 — основа серверних ботів).
 * Чиста функція (ship, world) → команда тієї ж форми, що й від клавіатури.
 */
import type { SeqCommand } from "../types.ts";
import { torusDelta } from "./arena.ts";
import type { Ship } from "./entities/ship.ts";
import type { World } from "./world.ts";

export function dummyPilot(ship: Ship, world: World): SeqCommand {
  let target: Ship | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const other of world.ofKind("ship")) {
    if (other === ship || other.destroyed) continue;
    const d = torusDelta(ship.pos, other.pos, world.arena).length();
    if (d < best) {
      best = d;
      target = other;
    }
  }
  if (!target) return { seq: 0, turn: 1, thrust: false, brake: false, fire: false };

  const desired = torusDelta(ship.pos, target.pos, world.arena).angle();
  let diff = desired - ship.angle;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const aimed = Math.abs(diff) < 0.12;
  return {
    seq: 0,
    turn: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0,
    thrust: best > 380 && Math.abs(diff) < 0.6,
    brake: best < 160,
    fire: aimed && best < 520 && world.tick % 45 === 0,
  };
}
