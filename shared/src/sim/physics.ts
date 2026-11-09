/**
 * Чиста фізика корабля: (стан, команда, dt) → новий стан. Жодного DOM чи Date.now().
 */
import type { Command } from "../types.ts";
import { Vector2 } from "./vector.ts";

export const SHIP = Object.freeze({
  turnRate: 3.6, // рад/с
  thrustAccel: 520, // px/с²
  drag: 0.55, // 1/с
  brakeDrag: 3.0, // 1/с
  maxSpeed: 560, // px/с
  radius: 14,
});

const TAU = Math.PI * 2;

/**
 * ЕКСПЕРИМЕНТ Лаби 5 («зламай детермінізм»): якщо amount > 0, тяга множиться на
 * випадковий коефіцієнт з Math.random(). За замовчуванням вимкнено.
 */
export const chaos = { amount: 0 };

export interface Kinematics {
  readonly pos: Vector2;
  readonly vel: Vector2;
  readonly angle: number;
}

export interface KinematicsWithThrust extends Kinematics {
  readonly thrust: boolean;
}

/** Нормалізує кут у [-π, π). */
export function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Інтерполяція кута найкоротшим шляхом. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Один крок фізики корабля (напівнеявний Ейлер). */
export function integrate(ship: Kinematics, input: Command, dt: number): KinematicsWithThrust {
  const angle = wrapAngle(ship.angle + input.turn * SHIP.turnRate * dt);
  let vel = ship.vel;
  if (input.thrust) {
    const noise = chaos.amount ? 1 + (Math.random() - 0.5) * chaos.amount : 1;
    vel = vel.add(Vector2.fromAngle(angle, SHIP.thrustAccel * dt * noise));
  }
  const k = SHIP.drag + (input.brake ? SHIP.brakeDrag : 0);
  vel = vel.scale(Math.exp(-k * dt)).clampLength(SHIP.maxSpeed);
  return { pos: ship.pos.add(vel.scale(dt)), vel, angle, thrust: input.thrust };
}
