/**
 * Чиста фізика корабля (з Лаби 1), тепер на Vector2.
 * Жодного DOM, canvas чи Date.now(): (стан, команда, dt) → новий стан.
 */
import { Vector2 } from "./vector.js";

export const SHIP = Object.freeze({
  turnRate: 3.6, // рад/с
  thrustAccel: 520, // px/с²
  drag: 0.55, // 1/с
  brakeDrag: 3.0, // 1/с
  maxSpeed: 560, // px/с
  radius: 14,
});

const TAU = Math.PI * 2;

/** Нормалізує кут у [-π, π). */
export function wrapAngle(a) {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Інтерполяція кута найкоротшим шляхом. */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/**
 * Один крок фізики корабля (напівнеявний Ейлер).
 * @param {{pos: Vector2, vel: Vector2, angle: number}} ship
 * @param {{turn: number, thrust: boolean, brake?: boolean}} input
 * @param {number} dt
 * @returns {{pos: Vector2, vel: Vector2, angle: number, thrust: boolean}}
 */
export function integrate(ship, input, dt) {
  const angle = wrapAngle(ship.angle + input.turn * SHIP.turnRate * dt);
  let vel = ship.vel;
  if (input.thrust) vel = vel.add(Vector2.fromAngle(angle, SHIP.thrustAccel * dt));
  const k = SHIP.drag + (input.brake ? SHIP.brakeDrag : 0);
  vel = vel.scale(Math.exp(-k * dt)).clampLength(SHIP.maxSpeed);
  return { pos: ship.pos.add(vel.scale(dt)), vel, angle, thrust: input.thrust };
}
