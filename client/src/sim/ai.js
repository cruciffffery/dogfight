/**
 * Простий «пілот» для тренувального манекена. Чиста функція (ship, world, dt) → команда,
 * тобто та сама форма даних, що й від клавіатури. У Лабі 7 повноцінні боти на сервері
 * будуть реалізовані так само — сервер не відрізнятиме їх від людей.
 */
import { torusDelta } from "./arena.js";

export function dummyPilot(ship, world) {
  let target = null;
  let best = Number.POSITIVE_INFINITY;
  for (const other of world.ofKind("ship")) {
    if (other === ship || other.destroyed) continue;
    const d = torusDelta(ship.pos, other.pos, world.arena).length();
    if (d < best) {
      best = d;
      target = other;
    }
  }
  if (!target) return { turn: 1, thrust: false, brake: false, fire: false };

  const desired = torusDelta(ship.pos, target.pos, world.arena).angle();
  let diff = desired - ship.angle;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const aimed = Math.abs(diff) < 0.12;
  return {
    turn: diff > 0.05 ? 0.6 : diff < -0.05 ? -0.6 : 0, // повільно — щоб його можна було перемогти
    thrust: best > 380 && Math.abs(diff) < 0.6,
    brake: best < 160,
    // стріляє не кожен тік: раз на ~0.75 с, детерміновано від номера тіку
    fire: aimed && best < 520 && world.tick % 45 === 0,
  };
}
