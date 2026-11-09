/**
 * Token bucket: відро на `burst` жетонів, поповнюється зі швидкістю `perSecond`.
 * Кожне повідомлення забирає жетон; порожнє відро = клієнт шле занадто часто.
 * Час передається ззовні (now), щоб функцію було легко тестувати без таймерів.
 */
export function createTokenBucket({ perSecond, burst }, now = performance.now()) {
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
