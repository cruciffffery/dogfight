/**
 * Ігровий цикл з фіксованим кроком симуляції (Glenn Fiedler, "Fix Your Timestep!").
 * scheduler / timestep — лише для експериментів Лаби 1.
 */
const HISTORY_SIZE = 240;

export type Scheduler = "raf" | "interval";
export type Timestep = "fixed" | "variable";

export interface LoopStats {
  stepsPerSec: number;
  framesPerSec: number;
  frameTime: number;
  workTime: number;
  alpha: number;
  totalSteps: number;
  totalFrames: number;
  simTime: number;
  readonly scheduler: Scheduler;
  readonly timestep: Timestep;
  readonly history: Float32Array;
  historyIndex: number;
}

export interface LoopOptions {
  step?: number;
  simulate: (dt: number) => void;
  render: (alpha: number, stats: LoopStats) => void;
  maxFrameTime?: number;
  scheduler?: Scheduler;
  intervalMs?: number;
  timestep?: Timestep;
}

export interface Loop {
  start(): void;
  stop(): void;
  readonly stats: LoopStats;
  isRunning(): boolean;
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  maxFrameTime = 0.25,
  scheduler = "raf",
  intervalMs = 16,
  timestep = "fixed",
}: LoopOptions): Loop {
  let running = false;
  let rafHandle = 0;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  let accumulator = 0;
  let windowStart = 0;
  let windowSteps = 0;
  let windowFrames = 0;

  const stats: LoopStats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameTime: 0,
    workTime: 0,
    alpha: 0,
    totalSteps: 0,
    totalFrames: 0,
    simTime: 0,
    scheduler,
    timestep,
    history: new Float32Array(HISTORY_SIZE),
    historyIndex: 0,
  };

  function doStep(dt: number): void {
    simulate(dt);
    stats.totalSteps += 1;
    stats.simTime += dt;
    windowSteps += 1;
  }

  function frame(timestamp?: number): void {
    if (!running) return;
    const now = scheduler === "raf" && timestamp !== undefined ? timestamp : performance.now();
    const workStart = performance.now();
    const deltaMs = now - last;
    last = now;
    const delta = Math.min(deltaMs / 1000, maxFrameTime);

    if (timestep === "fixed") {
      accumulator += delta;
      while (accumulator >= step) {
        doStep(step);
        accumulator -= step;
      }
      stats.alpha = accumulator / step;
    } else {
      doStep(delta);
      stats.alpha = 1;
    }

    stats.frameTime = deltaMs;
    stats.history[stats.historyIndex] = deltaMs;
    stats.historyIndex = (stats.historyIndex + 1) % HISTORY_SIZE;
    stats.totalFrames += 1;
    windowFrames += 1;

    if (now - windowStart >= 1000) {
      const seconds = (now - windowStart) / 1000;
      stats.stepsPerSec = windowSteps / seconds;
      stats.framesPerSec = windowFrames / seconds;
      windowStart = now;
      windowSteps = 0;
      windowFrames = 0;
    }

    render(stats.alpha, stats);
    stats.workTime = performance.now() - workStart;
    if (scheduler === "raf") rafHandle = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      windowStart = last;
      accumulator = 0;
      if (scheduler === "raf") rafHandle = requestAnimationFrame(frame);
      else intervalHandle = setInterval(() => frame(), intervalMs);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafHandle);
      clearInterval(intervalHandle);
    },
    stats,
    isRunning: () => running,
  };
}
