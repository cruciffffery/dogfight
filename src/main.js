import { busyWait, createRecorder, readExperiment } from "./experiments.js";
import { createInput, readCommand } from "./input.js";
import { createLoop } from "./loop.js";
import { setupCanvas } from "./render/canvas.js";
import {
  createStarfield,
  drawBackground,
  drawBanner,
  drawHud,
  drawScore,
  drawWorld,
} from "./render/draw.js";
import { dummyPilot } from "./sim/ai.js";
import { createArena, torusDelta } from "./sim/arena.js";
import { Ship } from "./sim/entities/ship.js";
import { Vector2 } from "./sim/vector.js";
import { spawnAsteroid, World } from "./sim/world.js";

const STEP = 1 / 60;
const config = readExperiment();

const canvas = document.getElementById("game");
const arena = createArena();
const view = setupCanvas(canvas, arena);
const stars = createStarfield(arena);
const input = createInput(window);
const recorder = createRecorder({ seconds: config.recordSeconds });

// ---- Світ ----
let world;
let player;
let dummy;

function newMatch() {
  world = new World({ arena, seed: 2026 });
  player = world.spawn(
    new Ship({ pos: new Vector2(arena.width * 0.3, arena.height / 2), name: "you" }),
  );
  dummy = world.spawn(
    new Ship({
      pos: new Vector2(arena.width * 0.75, arena.height / 2),
      angle: Math.PI,
      name: "dummy",
      color: "#ff8a8a",
      ai: dummyPilot,
    }),
  );
  for (let i = 0; i < 5; i++) spawnAsteroid(world, { hunter: i === 0 });
  probe.distance = Vector2.ZERO;
  probe.logged = null;
}

const probe = { distance: Vector2.ZERO, logged: null };
let showHud = true;
const inputs = new Map();
const AUTOPILOT = Object.freeze({ turn: 0, thrust: true, brake: false, fire: false });

// ---- Демонстрація бага з `this` (див. README, розділ «Баг з this») ----
// БАГ:     input.onPress("KeyF", player.fire);
//          → fire викликається як fn(e): this === undefined → TypeError: reading 'destroyed'
//          (а навіть якби this був, у fire прийшов би KeyboardEvent замість world)
// ВИПРАВЛЕННЯ (обране): стрілкова функція фіксує, на кому і з чим викликати метод
input.onPress("KeyF", () => player.fire(world));

function simulate(dt) {
  if (input.justPressed("KeyR")) newMatch();
  if (input.justPressed("KeyH")) showHud = !showHud;
  if (input.justPressed("KeyM")) recorder.restart();

  inputs.set(player.id, config.autopilot ? AUTOPILOT : readCommand(input));
  world.step(dt, inputs);
  world.drainEvents(); // у Лабі 3 їх слухатимуть аудіо та HUD

  probe.distance = probe.distance.add(torusDelta(player.prevPos, player.pos, arena));
  input.endStep();
}

function logProbe(stats) {
  if (!config.autopilot || probe.logged || world.time < 5 - 1e-9) return;
  probe.logged = {
    mode: `${stats.scheduler} · ${stats.timestep}`,
    simTime: +world.time.toFixed(4),
    steps: world.tick,
    dx: +probe.distance.x.toFixed(3),
    dy: +probe.distance.y.toFixed(3),
  };
  console.log("[lab] переміщення після 5 с газу:", probe.logged);
}

let renderedFrames = 0;

function render(alpha, stats) {
  renderedFrames += 1;
  recorder.onFrame(stats);
  logProbe(stats);

  if (config.blockEvery && renderedFrames % config.blockEvery === 0) busyWait(config.blockMs);

  const now = performance.now();
  drawBackground(view, arena, stars);
  drawWorld(view, world, alpha, now);

  const you = world.scores.get(player.id) ?? 0;
  const them = world.scores.get(dummy.id) ?? 0;
  drawScore(view, `YOU ${you}   ·   DUMMY ${them}`);

  if (config.exp !== "none") {
    drawBanner(view, `EXPERIMENT: ${config.exp}${config.autopilot ? " + autopilot" : ""}`);
  }

  if (showHud) {
    const fx = Object.entries(player.effects)
      .filter(([, t]) => t > 0)
      .map(([k, t]) => `${k} ${t.toFixed(1)}s`)
      .join("  ");
    const lines = [
      { text: `hp ${player.hp}  entities ${world.size}`, color: "#cfe0ff" },
      { text: fx ? `effects: ${fx}` : "effects: —" },
      { text: "←/→ поворот, ↑ газ, ↓ гальмо, Space вогонь" },
      { text: "F — одиночний постріл, R — новий матч, H — HUD" },
    ];
    const r = recorder.result;
    if (r) {
      lines.push({ text: `rec ${r.seconds}s: ${r.fps} fps, p99 ${r.p99Ms} ms`, color: "#39d98a" });
    }
    if (probe.logged) {
      lines.push({
        text: `5 с газу: dx=${probe.logged.dx}, dy=${probe.logged.dy}`,
        color: "#ffb020",
      });
    }
    drawHud(view, stats, { targetSteps: 1 / STEP, lines });
  }
}

newMatch();
const loop = createLoop({
  step: STEP,
  simulate,
  render,
  scheduler: config.scheduler,
  timestep: config.timestep,
});
loop.start();
canvas.focus();

window.__lab = {
  loop,
  recorder,
  probe,
  config,
  get world() {
    return world;
  },
  get player() {
    return player;
  },
};
