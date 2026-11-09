/**
 * Конфіги арен — джерело правди для сервера. Клієнт у режимі ?offline вантажить ті самі
 * значення з client/public/assets/arenas/*.json (тест перевіряє, що вони однакові).
 */
import type { ArenaConfig } from "./protocol.ts";

export const ARENA_IDS: readonly ["classic", "rockfield", "duel"] = [
  "classic",
  "rockfield",
  "duel",
];
export type ArenaId = (typeof ARENA_IDS)[number];

export const ARENAS: Readonly<Record<ArenaId, ArenaConfig>> = Object.freeze({
  classic: { name: "Classic", width: 1600, height: 900, asteroids: 5, pickupEvery: 6, seed: 2026 },
  rockfield: {
    name: "Rockfield",
    width: 1920,
    height: 1080,
    asteroids: 12,
    pickupEvery: 4,
    seed: 77,
  },
  duel: { name: "Duel", width: 1200, height: 700, asteroids: 1, pickupEvery: 10, seed: 5 },
});

export function isArenaId(x: unknown): x is ArenaId {
  return ARENA_IDS.some((id) => id === x);
}
