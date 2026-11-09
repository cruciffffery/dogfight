/**
 * Детермінований генератор псевдовипадкових чисел (mulberry32).
 * Math.random() у симуляції заборонений: однакове зерно → однаковий світ на будь-якій машині.
 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
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
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    get state() {
      return a;
    },
  };
}
