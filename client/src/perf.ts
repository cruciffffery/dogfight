/**
 * Інструментування гарячих ділянок (Лаба 7): performance.mark/measure.
 * Увімкнено лише з ?perf — сам measure() створює об'єкти, і у звичайній грі вони зайві.
 * Записи видно у вкладці Performance → Timings у DevTools і через window.__lab.perf().
 */
const enabled = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
const samples = new Map<string, number[]>();

if (enabled && typeof PerformanceObserver !== "undefined") {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      let arr = samples.get(e.name);
      if (!arr) {
        arr = [];
        samples.set(e.name, arr);
      }
      arr.push(e.duration);
    }
    performance.clearMeasures();
  }).observe({ entryTypes: ["measure"] });
}

export function measure<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    performance.measure(name, { start, end: performance.now() });
  }
}

/** Обгортка, створена ОДИН раз: без нових замикань на кожен кадр. */
export function measured<A extends unknown[]>(
  name: string,
  fn: (...args: A) => void,
): (...args: A) => void {
  if (!enabled) return fn;
  return (...args: A) => {
    const start = performance.now();
    fn(...args);
    performance.measure(name, { start, end: performance.now() });
  };
}

function pct(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export interface PerfSummary {
  [name: string]: {
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    total: number;
  };
}

export function perfSummary(reset = false): PerfSummary {
  const out: PerfSummary = {};
  for (const [name, arr] of samples) {
    const s = [...arr].sort((a, b) => a - b);
    out[name] = {
      count: s.length,
      p50: +pct(s, 50).toFixed(3),
      p95: +pct(s, 95).toFixed(3),
      p99: +pct(s, 99).toFixed(3),
      max: +(s.at(-1) ?? 0).toFixed(3),
      total: +s.reduce((a, b) => a + b, 0).toFixed(1),
    };
  }
  if (reset) samples.clear();
  return out;
}

export const perfEnabled = enabled;
