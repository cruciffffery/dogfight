/**
 * Детермінований ГПВЧ (mulberry32). Math.random() у симуляції заборонений:
 * однакове зерно → однаковий світ на будь-якій машині.
 */
export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(min: number, maxExclusive: number): number;
  pick<T>(items: readonly [T, ...T[]]): T;
  readonly state: number;
}

export function createRng(seed = 1): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, maxExclusive) => Math.floor(min + next() * (maxExclusive - min)),
    // непорожній кортеж: індекс завжди валідний, тож noUncheckedIndexedAccess не заважає
    pick: (items) => items[Math.floor(next() * items.length)] ?? items[0],
    get state() {
      return a;
    },
  };
}
