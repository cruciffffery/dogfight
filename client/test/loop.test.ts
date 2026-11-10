/**
 * Акумулятор фіксованого кроку з ФЕЙКОВИМИ таймерами: час іде тоді, коли тест скаже.
 * requestAnimationFrame у Node немає — підставляємо його поверх фейкового setTimeout.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLoop } from "../src/loop.ts";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Кадри рівно на k·frameMs (фейковий setTimeout не вміє дробові мілісекунди). */
function stubRaf(frameMs: number): void {
  let k = Math.floor(performance.now() / frameMs);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    k += 1;
    const at = Math.round(k * frameMs);
    return setTimeout(() => cb(performance.now()), Math.max(0, at - performance.now()));
  });
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
}

describe("fixed-timestep loop", () => {
  test.each([
    ["60 Hz", 1000 / 60],
    ["144 Hz", 1000 / 144],
    ["30 Hz", 1000 / 30],
  ])("exactly 60 simulation steps per second on a %s display", (_name, frameMs) => {
    stubRaf(frameMs);
    let steps = 0;
    let frames = 0;
    const loop = createLoop({ simulate: () => steps++, render: () => frames++ });
    loop.start();
    vi.advanceTimersByTime(10_000);
    loop.stop();
    expect(steps).toBeGreaterThanOrEqual(599);
    expect(steps).toBeLessThanOrEqual(600);
    expect(frames).toBeCloseTo(10_000 / frameMs, -1);
  });

  test("alpha is the leftover fraction of a step, in [0, 1)", () => {
    stubRaf(1000 / 144);
    const alphas: number[] = [];
    const loop = createLoop({ simulate: () => {}, render: (a) => alphas.push(a) });
    loop.start();
    vi.advanceTimersByTime(1000);
    loop.stop();
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
    expect(new Set(alphas.map((a) => a.toFixed(2))).size).toBeGreaterThan(1);
  });

  test("a 2-second hitch is clamped to 0.25 s: no spiral of death", () => {
    stubRaf(1000 / 60);
    let steps = 0;
    const loop = createLoop({ simulate: () => steps++, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(1000);
    const before = steps;
    vi.setSystemTime(Date.now()); // без впливу на performance
    vi.advanceTimersByTime(0);
    // імітуємо зависання: наступний кадр приходить через 2 с
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
      setTimeout(() => cb(performance.now()), 2000),
    );
    vi.advanceTimersByTime(2100);
    loop.stop();
    expect(steps - before).toBeLessThanOrEqual(Math.ceil(0.25 * 60) + 2 + 60);
  });

  test("variable timestep calls simulate once per frame with the real dt", () => {
    stubRaf(1000 / 30);
    const dts: number[] = [];
    const loop = createLoop({
      simulate: (dt) => dts.push(dt),
      render: () => {},
      timestep: "variable",
    });
    loop.start();
    vi.advanceTimersByTime(1000);
    loop.stop();
    expect(dts.length).toBeGreaterThan(25);
    expect(dts[5]).toBeCloseTo(1 / 30, 3);
  });

  test("setInterval scheduler fires about 62 times per second (16 ms ≠ 16.67 ms)", () => {
    let frames = 0;
    const loop = createLoop({
      simulate: () => {},
      render: () => frames++,
      scheduler: "interval",
      intervalMs: 16,
    });
    loop.start();
    vi.advanceTimersByTime(1000);
    loop.stop();
    expect(frames).toBe(62);
    expect(loop.isRunning()).toBe(false);
  });

  test("stats: steps/s and frames/s are measured over a 1 s window", () => {
    stubRaf(1000 / 60);
    const loop = createLoop({ simulate: () => {}, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(3000);
    loop.stop();
    expect(loop.stats.stepsPerSec).toBeCloseTo(60, 0);
    expect(loop.stats.framesPerSec).toBeCloseTo(60, 0);
    expect(loop.stats.totalFrames).toBeGreaterThan(170);
  });
});
