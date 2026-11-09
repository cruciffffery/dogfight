/**
 * Арена має фіксований розмір у «світових» пікселях і не залежить від вікна браузера:
 * інакше на широкому моніторі гравець бачив би більше світу, а симуляція була б різною
 * для різних гравців. Вікно лише масштабує картинку (render/canvas.js).
 */
export const ARENA = Object.freeze({ width: 1600, height: 900 });

export function createArena(width = ARENA.width, height = ARENA.height) {
  return Object.freeze({ width, height });
}

function mod(v, m) {
  return ((v % m) + m) % m;
}

/** «Загортання» країв (тор): вилетів праворуч — з'явився ліворуч. */
export function wrap(ship, arena) {
  const x = mod(ship.x, arena.width);
  const y = mod(ship.y, arena.height);
  if (x === ship.x && y === ship.y) return ship;
  return { ...ship, x, y };
}
