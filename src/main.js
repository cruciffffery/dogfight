import { busyWait, createRecorder, readExperiment } from "./experiments.js";
import { createInput, readCommand } from "./input.js";
import { createLoop } from "./loop.js";
import { setupCanvas } from "./render/canvas.js";
import { createStarfield, drawBackground, drawBanner, drawHud, drawShip } from "./render/draw.js";
import { createArena, wrap } from "./sim/arena.js";
import { createShip, integrate, lerpShip } from "./sim/ship.js";

const STEP = 1 / 60;
const config = readExperiment();

const canvas = document.getElementById("game");
const arena = createArena();
const view = setupCanvas(canvas, arena);
const stars = createStarfield(arena);
const input = createInput(window);
const recorder = createRecorder({ seconds: config.recordSeconds });

// ---- Стан гри: два знімки для інтерполяції ----
const spawn = () => createShip({ x: arena.width / 2, y: arena.height / 2 });
let previous = spawn();
let current = spawn();
let showHud = true;

// Для експерименту 3: «розгорнута» позиція (без загортання) після 5 с газу
const probe = { x: current.x, y: current.y, logged: null };

const AUTOPILOT = Object.freeze({ turn: 0, thrust: true, brake: false });

function simulate(dt) {
  // фронти клавіш обробляються в кроці симуляції, тому й «споживаються» тут
  if (input.justPressed("KeyR")) {
    current = spawn();
    probe.x = current.x;
    probe.y = current.y;
    probe.logged = null;
  }
  if (input.justPressed("KeyH")) showHud = !showHud;
  if (input.justPressed("KeyM")) recorder.restart();

  const command = config.autopilot ? AUTOPILOT : readCommand(input);

  previous = current;
  const moved = integrate(current, command, dt);
  probe.x += moved.x - current.x;
  probe.y += moved.y - current.y;
  current = wrap(moved, arena);

  input.endStep();
}

function logProbe(stats) {
  if (!config.autopilot || probe.logged || stats.simTime < 5 - 1e-9) return;
  probe.logged = {
    mode: `${stats.scheduler} · ${stats.timestep}`,
    simTime: +stats.simTime.toFixed(4),
    steps: stats.totalSteps,
    x: +probe.x.toFixed(3),
    y: +probe.y.toFixed(3),
    speed: +Math.hypot(current.vx, current.vy).toFixed(3),
  };
  console.log("[lab-01] позиція після 5 с газу:", probe.logged);
}

let renderedFrames = 0;

function render(alpha, stats) {
  renderedFrames += 1;
  recorder.onFrame(stats);
  logProbe(stats);

  // ЕКСПЕРИМЕНТ 1: синхронно блокуємо потік на 100 мс кожен 60-й кадр
  if (config.blockEvery && renderedFrames % config.blockEvery === 0) {
    busyWait(config.blockMs);
  }

  const ship = lerpShip(previous, current, alpha, arena);
  drawBackground(view, arena, stars);
  drawShip(view, arena, ship, performance.now());

  if (config.exp !== "none") {
    drawBanner(view, `EXPERIMENT: ${config.exp}${config.autopilot ? " + autopilot" : ""}`);
  }

  if (showHud) {
    const lines = [
      { text: "←/→ або A/D — поворот, ↑/W — газ" },
      { text: "↓/S — гальмо, R — респавн, H — HUD" },
    ];
    const r = recorder.result;
    if (r) {
      lines.push({
        text: `rec ${r.seconds}s: ${r.fps} fps, jitter ${r.jitterMs} ms`,
        color: "#39d98a",
      });
      lines.push({
        text: `p95 ${r.p95Ms} / max ${r.maxMs} ms, long ${r.longFrames}`,
        color: "#39d98a",
      });
    } else {
      lines.push({ text: `запис: ${Math.round(recorder.progress * 100)}% (M — заново)` });
    }
    if (probe.logged) {
      lines.push({ text: `5 с газу: x=${probe.logged.x}, y=${probe.logged.y}`, color: "#ffb020" });
    }
    drawHud(view, stats, { targetSteps: 1 / STEP, lines });
  }
}

const loop = createLoop({
  step: STEP,
  simulate,
  render,
  scheduler: config.scheduler,
  timestep: config.timestep,
});
loop.start();
canvas.focus();

// Доступ з консолі DevTools / Playwright: window.__lab.recorder.result тощо
window.__lab = { loop, recorder, probe, config };
