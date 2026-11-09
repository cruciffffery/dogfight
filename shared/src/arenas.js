/**
 * Конфіги арен — джерело правди для сервера. Клієнт у режимі ?offline вантажить ті самі
 * значення з client/public/assets/arenas/*.json (тест у shared/test перевіряє, що вони однакові).
 */
export const ARENAS = Object.freeze({
  classic: Object.freeze({
    name: "Classic",
    width: 1600,
    height: 900,
    asteroids: 5,
    pickupEvery: 6,
    seed: 2026,
  }),
  rockfield: Object.freeze({
    name: "Rockfield",
    width: 1920,
    height: 1080,
    asteroids: 12,
    pickupEvery: 4,
    seed: 77,
  }),
  duel: Object.freeze({
    name: "Duel",
    width: 1200,
    height: 700,
    asteroids: 1,
    pickupEvery: 10,
    seed: 5,
  }),
});
