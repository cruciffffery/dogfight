/**
 * Клієнтське передбачення і звірка (reconciliation) — чисті функції, без DOM і мережі.
 *
 * Передбачення: свій корабель рухається ОДРАЗУ за натисканням, тією самою integrate(),
 * що й на сервері. Це працює лише тому, що симуляція детермінована.
 *
 * Звірка: прийшов знімок, де сервер обробив наші команди до seq = ack.
 *   1. беремо авторитетний стан корабля з сервера;
 *   2. викидаємо з буфера всі команди з seq ≤ ack — сервер їх уже врахував;
 *   3. «програємо» решту (ще не підтверджені) поверх серверного стану.
 * Якщо результат збігся з тим, що ми вже показували, — корекція нульова.
 */
import { torusDelta, wrapPos } from "@dogfight/shared/sim/arena.js";
import { integrate } from "@dogfight/shared/sim/physics.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";

/** Один крок передбачення: та сама фізика + загортання, що й у World.step на сервері. */
export function predictStep(state, cmd, dt, arena) {
  const next = integrate(state, cmd, dt);
  return { pos: wrapPos(next.pos, arena), vel: next.vel, angle: next.angle, thrust: next.thrust };
}

/**
 * @param {object} predicted  поточний передбачений стан {pos, vel, angle}
 * @param {object} server     стан корабля зі знімка {x, y, vx, vy, angle}
 * @param {number} ack        lastProcessedSeq зі знімка
 * @param {Array<{seq, cmd}>} pending  непідтверджені команди (за зростанням seq)
 * @returns {{ state, pending, correction: Vector2 }}
 *   correction — наскільки стрибнула позиція (стара − нова); рендер її плавно «з'їдає»
 */
export function reconcile(predicted, server, ack, pending, dt, arena) {
  const remaining = pending.filter((p) => p.seq > ack);
  let state = {
    pos: new Vector2(server.x, server.y),
    vel: new Vector2(server.vx, server.vy),
    angle: server.angle,
    thrust: false,
  };
  for (const { cmd } of remaining) state = predictStep(state, cmd, dt, arena);
  const correction = torusDelta(state.pos, predicted.pos, arena);
  return { state, pending: remaining, correction };
}
