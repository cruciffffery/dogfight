/**
 * Token bucket: `burst` жетонів, поповнення `perSecond` за секунду.
 * Час передається ззовні — функцію легко тестувати без таймерів.
 */
export interface TokenBucket {
  take(at?: number, cost?: number): boolean;
  readonly tokens: number;
}

export function createTokenBucket(
  { perSecond, burst }: { perSecond: number; burst: number },
  now: number = performance.now(),
): TokenBucket {
  let tokens = burst;
  let last = now;
  return {
    take(at = performance.now(), cost = 1) {
      tokens = Math.min(burst, tokens + ((at - last) / 1000) * perSecond);
      last = at;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
    get tokens() {
      return tokens;
    },
  };
}
