/**
 * Експерименти Лаби 1 (вмикаються параметрами URL) і рекордер метрик кадрів.
 */
import type { LoopStats, Scheduler, Timestep } from "./loop.ts";

export interface ExperimentConfig {
  exp: string;
  scheduler: Scheduler;
  timestep: Timestep;
  blockEvery: number;
  blockMs: number;
  autopilot: boolean;
  recordSeconds: number;
}

export function readExperiment(search: string = window.location.search): ExperimentConfig {
  const params = new URLSearchParams(search);
  const exp = params.get("exp") ?? "none";
  return {
    exp,
    scheduler: exp === "interval" ? "interval" : "raf",
    timestep: exp === "variable" ? "variable" : "fixed",
    blockEvery: exp === "block" ? 60 : 0,
    blockMs: Number(params.get("blockMs") ?? 100),
    autopilot: params.has("autopilot"),
    recordSeconds: Number(params.get("record") ?? 10),
  };
}

export function busyWait(ms: number): void {
  const t = performance.now();
  while (performance.now() < t + ms) {
    // стек викликів зайнятий, event loop стоїть
  }
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

export interface RecorderResult {
  mode: string;
  seconds: number;
  frames: number;
  fps: number;
  stepsPerSec: number;
  meanMs: number;
  jitterMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  longFrames: number;
  hiddenMs: number;
  framesWhileHidden: number;
}

export interface Recorder {
  onFrame(stats: LoopStats): void;
  restart(): void;
  readonly result: RecorderResult | null;
  readonly progress: number;
  /** Сирі інтервали між кадрами (Лаба 7: перцентилі до/після). */
  readonly deltas: readonly number[];
}

export function createRecorder({ seconds = 10, warmup = 1 } = {}): Recorder {
  const deltas: number[] = [];
  let startAt: number | null = null;
  let startSteps = 0;
  let lastFrameAt = 0;
  let result: RecorderResult | null = null;
  let createdAt = performance.now();
  let hiddenSince: number | null = null;
  let hiddenMs = 0;
  let framesWhileHidden = 0;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenSince = performance.now();
    else if (hiddenSince !== null) {
      hiddenMs += performance.now() - hiddenSince;
      hiddenSince = null;
    }
  });

  return {
    onFrame(stats) {
      const now = performance.now();
      if (result) return;
      if (startAt === null) {
        if (now - createdAt < warmup * 1000) return;
        startAt = now;
        startSteps = stats.totalSteps;
        lastFrameAt = now;
        return;
      }
      deltas.push(now - lastFrameAt);
      lastFrameAt = now;
      if (document.hidden) framesWhileHidden += 1;
      if (now - startAt >= seconds * 1000) {
        const elapsed = (now - startAt) / 1000;
        const sorted = [...deltas].sort((a, b) => a - b);
        const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
        const variance = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length;
        result = {
          mode: `${stats.scheduler} · ${stats.timestep}`,
          seconds: +elapsed.toFixed(2),
          frames: deltas.length,
          fps: +(deltas.length / elapsed).toFixed(2),
          stepsPerSec: +((stats.totalSteps - startSteps) / elapsed).toFixed(2),
          meanMs: +mean.toFixed(2),
          jitterMs: +Math.sqrt(variance).toFixed(2),
          minMs: +(sorted[0] ?? 0).toFixed(2),
          p50Ms: +percentile(sorted, 50).toFixed(2),
          p95Ms: +percentile(sorted, 95).toFixed(2),
          p99Ms: +percentile(sorted, 99).toFixed(2),
          maxMs: +(sorted.at(-1) ?? 0).toFixed(2),
          longFrames: deltas.filter((d) => d > 1000 / 60 + 4).length,
          hiddenMs: Math.round(hiddenMs),
          framesWhileHidden,
        };
        console.log("[lab] вимірювання:", result);
      }
    },
    restart() {
      deltas.length = 0;
      startAt = null;
      result = null;
      hiddenMs = 0;
      framesWhileHidden = 0;
      createdAt = performance.now();
    },
    get result() {
      return result;
    },
    get progress() {
      return startAt === null ? 0 : Math.min(1, (performance.now() - startAt) / (seconds * 1000));
    },
    deltas,
  };
}
