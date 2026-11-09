/**
 * Інструменти для експериментів M4 «зламай навмисно і поміряй».
 * Вмикаються параметром URL, щоб код гри лишався чистим:
 *
 *   /                         — нормальний режим (rAF + фіксований крок)
 *   /?exp=block               — експ. 1: busy-wait 100 мс у render кожен 60-й кадр
 *   /?exp=interval            — експ. 2: setInterval(frame, 16) замість rAF
 *   /?exp=variable            — експ. 3: змінний крок simulate(dt) раз на кадр
 *   &autopilot=1              — тримає «газ» сам (для експ. 3, щоб рухи були однакові)
 *
 * Throttling CPU 6× вмикається в DevTools → Performance → CPU: 6× slowdown.
 */

export function readExperiment(search = window.location.search) {
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

/** Синхронне блокування потоку — те, що робить «важкий» код у кадрі. */
export function busyWait(ms) {
  const t = performance.now();
  while (performance.now() < t + ms) {
    // нічого: стек викликів зайнятий, event loop стоїть
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * Записує інтервали між кадрами протягом `seconds` секунд (після 1 с прогріву)
 * і рахує середнє, джитер (стандартне відхилення), перцентилі та «довгі» кадри.
 * Також фіксує, що відбувалось, поки вкладка була прихована.
 */
export function createRecorder({ seconds = 10, warmup = 1 } = {}) {
  const deltas = [];
  let startAt = null;
  let startSteps = 0;
  let lastFrameAt = null;
  let result = null;
  let createdAt = performance.now();

  let hiddenSince = null;
  let hiddenMs = 0;
  let framesWhileHidden = 0;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenSince = performance.now();
    else if (hiddenSince !== null) {
      hiddenMs += performance.now() - hiddenSince;
      hiddenSince = null;
    }
  });

  function onFrame(stats) {
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
        minMs: +sorted[0].toFixed(2),
        p50Ms: +percentile(sorted, 50).toFixed(2),
        p95Ms: +percentile(sorted, 95).toFixed(2),
        p99Ms: +percentile(sorted, 99).toFixed(2),
        maxMs: +sorted[sorted.length - 1].toFixed(2),
        longFrames: deltas.filter((d) => d > 1000 / 60 + 4).length,
        hiddenMs: Math.round(hiddenMs),
        framesWhileHidden,
      };
      console.log("[lab-01] вимірювання:", result);
      console.table([result]);
    }
  }

  function restart() {
    deltas.length = 0;
    startAt = null;
    result = null;
    hiddenMs = 0;
    framesWhileHidden = 0;
    createdAt = performance.now();
  }

  return {
    onFrame,
    restart,
    get result() {
      return result;
    },
    get progress() {
      if (startAt === null) return 0;
      return Math.min(1, (performance.now() - startAt) / (seconds * 1000));
    },
  };
}
