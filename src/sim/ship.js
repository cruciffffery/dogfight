/**
 * Корабель — звичайний об'єкт даних. Жодного DOM, canvas чи Date.now():
 * integrate() — чиста функція (стан, команда, dt) → новий стан.
 * Той самий модуль у Лабі 5 запуститься на Node-сервері без змін.
 */

// Параметри польоту (підібрані на відчуття — див. README, розділ «Тюнінг»)
export const SHIP = Object.freeze({
  turnRate: 3.6, // рад/с (~206°/с): повний розворот ≈ 1.75 с
  thrustAccel: 520, // px/с² вздовж носа
  drag: 0.55, // 1/с, експоненційне згасання швидкості
  brakeDrag: 3.0, // 1/с, додаткове згасання при гальмуванні
  maxSpeed: 560, // px/с
  radius: 14, // для майбутніх колізій (Лаба 2)
});

const TAU = Math.PI * 2;

export function createShip({ x = 0, y = 0, angle = -Math.PI / 2 } = {}) {
  return { x, y, vx: 0, vy: 0, angle, thrust: false };
}

/** Нормалізує кут у [-π, π), щоб він не «ріс» нескінченно при обертанні. */
export function wrapAngle(a) {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/**
 * Один крок фізики (напівнеявний Ейлер: спершу швидкість, потім позиція).
 * @param {{x:number,y:number,vx:number,vy:number,angle:number,thrust:boolean}} ship
 * @param {{turn:number, thrust:boolean, brake?:boolean}} input — команда, не клавіатура
 * @param {number} dt — секунди
 * @returns новий об'єкт корабля (вхідний не змінюється)
 */
export function integrate(ship, input, dt) {
  const angle = wrapAngle(ship.angle + input.turn * SHIP.turnRate * dt);

  let vx = ship.vx;
  let vy = ship.vy;

  if (input.thrust) {
    vx += Math.cos(angle) * SHIP.thrustAccel * dt;
    vy += Math.sin(angle) * SHIP.thrustAccel * dt;
  }

  // Опір: v *= e^(-k·dt). Експонента, а не (1 - k·dt), — щоб не «перевертати» швидкість при великому dt
  const k = SHIP.drag + (input.brake ? SHIP.brakeDrag : 0);
  const damping = Math.exp(-k * dt);
  vx *= damping;
  vy *= damping;

  // Обмеження швидкості зберігає напрямок
  const speed = Math.hypot(vx, vy);
  if (speed > SHIP.maxSpeed) {
    const s = SHIP.maxSpeed / speed;
    vx *= s;
    vy *= s;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust: input.thrust,
  };
}

/** Інтерполяція кута найкоротшим шляхом: 179° → -179° — це 2°, а не 358°. */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/**
 * Стан для рендеру між двома кроками симуляції.
 * Позиція інтерполюється з урахуванням «загортання» арени: якщо корабель
 * перелетів через край, previous зсувається на ширину/висоту арени,
 * інакше він на один кадр «пролетів би» через увесь екран.
 */
export function lerpShip(prev, curr, t, arena) {
  let px = prev.x;
  let py = prev.y;
  if (arena) {
    if (curr.x - px > arena.width / 2) px += arena.width;
    else if (px - curr.x > arena.width / 2) px -= arena.width;
    if (curr.y - py > arena.height / 2) py += arena.height;
    else if (py - curr.y > arena.height / 2) py -= arena.height;
  }
  return {
    x: px + (curr.x - px) * t,
    y: py + (curr.y - py) * t,
    vx: curr.vx,
    vy: curr.vy,
    angle: lerpAngle(prev.angle, curr.angle, t),
    thrust: curr.thrust,
  };
}
