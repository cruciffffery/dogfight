/**
 * Ігровий цикл з фіксованим кроком симуляції (Glenn Fiedler, "Fix Your Timestep!").
 *
 * Симуляція викликається рівно `1 / step` разів за секунду незалежно від частоти монітора,
 * рендер — один раз на кадр з коефіцієнтом інтерполяції `alpha ∈ [0, 1)`.
 *
 * Параметри `scheduler` і `timestep` існують лише для експериментів M4:
 *   scheduler: "raf"   — requestAnimationFrame (правильно)
 *              "interval" — setInterval(frame, 16) (експеримент 2)
 *   timestep:  "fixed" — акумулятор (правильно)
 *              "variable" — simulate(dt) один раз на кадр (експеримент 3)
 */

const HISTORY_SIZE = 240;

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  maxFrameTime = 0.25,
  scheduler = "raf",
  intervalMs = 16,
  timestep = "fixed",
} = {}) {
  if (typeof simulate !== "function" || typeof render !== "function") {
    throw new TypeError("createLoop: simulate і render мають бути функціями");
  }

  // ---- приватний стан циклу (замикання) ----
  let running = false;
  let handle = 0;
  let last = 0;
  let accumulator = 0;

  // вікно для підрахунку частот
  let windowStart = 0;
  let windowSteps = 0;
  let windowFrames = 0;

  // Публічна статистика: один об'єкт, який мутується (HUD читає його кожен кадр)
  const stats = {
    stepsPerSec: 0,
    framesPerSec: 0,
    frameTime: 0, // мс між двома послідовними кадрами
    workTime: 0, // мс, витрачені всередині колбека кадру (simulate + render)
    alpha: 0,
    totalSteps: 0,
    totalFrames: 0,
    simTime: 0, // скільки секунд «прожила» симуляція
    scheduler,
    timestep,
    history: new Float32Array(HISTORY_SIZE), // останні frameTime для гістограми
    historyIndex: 0,
  };

  function doStep(dt) {
    simulate(dt);
    stats.totalSteps += 1;
    stats.simTime += dt;
    windowSteps += 1;
  }

  function frame(timestamp) {
    if (!running) return;
    // rAF передає момент початку кадру; setInterval не передає нічого
    const now = scheduler === "raf" ? timestamp : performance.now();
    const workStart = performance.now();

    const deltaMs = now - last;
    last = now;
    // clamp: після зависання / неактивної вкладки не «доганяємо» секунди симуляції
    const delta = Math.min(deltaMs / 1000, maxFrameTime);

    if (timestep === "fixed") {
      accumulator += delta;
      while (accumulator >= step) {
        doStep(step);
        accumulator -= step;
      }
      stats.alpha = accumulator / step;
    } else {
      // ЕКСПЕРИМЕНТ 3: змінний крок — результат залежить від частоти кадрів
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

    if (scheduler === "raf") handle = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    windowStart = last;
    accumulator = 0;
    if (scheduler === "raf") {
      handle = requestAnimationFrame(frame);
    } else {
      // ЕКСПЕРИМЕНТ 2: таймер-задача (macrotask) замість кроку рендерингу
      handle = setInterval(frame, intervalMs);
    }
  }

  function stop() {
    running = false;
    if (scheduler === "raf") cancelAnimationFrame(handle);
    else clearInterval(handle);
  }

  return { start, stop, stats, isRunning: () => running };
}
