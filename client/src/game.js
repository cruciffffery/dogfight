/**
 * Локальна гра (до появи сервера): світ + цикл + рендер + HUD + звук.
 */

import { dummyPilot } from "@dogfight/shared/sim/ai.js";
import { createArena, torusDelta } from "@dogfight/shared/sim/arena.js";
import { Ship } from "@dogfight/shared/sim/entities/ship.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";
import { spawnAsteroid, World } from "@dogfight/shared/sim/world.js";
import { attachAudio } from "./audio.js";
import { busyWait, createRecorder } from "./experiments.js";
import { createHud } from "./hud.js";
import { createInput, readCommand } from "./input.js";
import { createLoop } from "./loop.js";
import { createStarfield, drawBackground, drawBanner, drawHud, drawWorld } from "./render/draw.js";

const STEP = 1 / 60;
const AUTOPILOT = Object.freeze({ turn: 0, thrust: true, brake: false, fire: false });

export function startGame({ view, arenaConfig, name = "you", config }) {
  const arena = createArena(arenaConfig.width, arenaConfig.height);
  view.setArena(arena);
  const stars = createStarfield(arena, Math.round((arena.width * arena.height) / 5500));
  const input = createInput(window);
  const recorder = createRecorder({ seconds: config.recordSeconds });

  let world;
  let player;
  let hud;
  const probe = { distance: Vector2.ZERO, logged: null };
  const inputs = new Map();
  let showHud = true;

  function newMatch() {
    world = new World({
      arena,
      seed: arenaConfig.seed ?? 1,
      rules: { asteroids: arenaConfig.asteroids, pickupEvery: arenaConfig.pickupEvery },
    });
    player = world.spawn(
      new Ship({ pos: new Vector2(arena.width * 0.3, arena.height / 2), name, skin: "blue" }),
    );
    world.spawn(
      new Ship({
        pos: new Vector2(arena.width * 0.75, arena.height / 2),
        angle: Math.PI,
        name: "dummy",
        skin: "red",
        color: "#ff4d5e",
        ai: dummyPilot,
      }),
    );
    for (let i = 0; i < arenaConfig.asteroids; i++) spawnAsteroid(world, { hunter: i === 0 });

    // Підписки на події симуляції: звук і HUD. Симуляція їх не імпортує.
    attachAudio(world, { isLocal: (id) => id === player.id });
    hud = createHud(world, {
      nameOf: (id) => world.get(id)?.name ?? `#${id}`,
      localId: () => player.id,
    });
    probe.distance = Vector2.ZERO;
    probe.logged = null;
  }

  // Баг з this (Лаба 2): input.onPress("KeyF", player.fire) → TypeError. Виправлення:
  input.onPress("KeyF", () => player.fire(world));

  function simulate(dt) {
    if (input.justPressed("KeyR")) newMatch();
    if (input.justPressed("KeyH")) showHud = !showHud;
    if (input.justPressed("KeyM")) recorder.restart();

    inputs.set(player.id, config.autopilot ? AUTOPILOT : readCommand(input));
    world.step(dt, inputs);
    world.drainEvents(); // черга — для мережі (Лаба 5); тут слухачі вже спрацювали
    hud.update(dt);
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
  const toScreen = (x, y) => ({
    x: view.offsetX + x * view.scale,
    y: view.offsetY + y * view.scale,
  });

  function render(alpha, stats) {
    renderedFrames += 1;
    recorder.onFrame(stats);
    logProbe(stats);
    if (config.blockEvery && renderedFrames % config.blockEvery === 0) busyWait(config.blockMs);

    drawBackground(view, arena, stars);
    drawWorld(view, world, alpha, performance.now());
    hud.draw(view, toScreen);

    if (config.exp !== "none") {
      drawBanner(view, `EXPERIMENT: ${config.exp}${config.autopilot ? " + autopilot" : ""}`);
    }
    if (showHud) {
      const fx = Object.entries(player.effects)
        .filter(([, t]) => t > 0)
        .map(([k, t]) => `${k} ${t.toFixed(1)}s`)
        .join("  ");
      const lines = [
        {
          text: `${arenaConfig.name} · hp ${player.hp} · entities ${world.size}`,
          color: "#cfe0ff",
        },
        { text: fx ? `effects: ${fx}` : "effects: —" },
        { text: "←/→ поворот, ↑ газ, ↓ гальмо, Space вогонь" },
        { text: "F постріл, R новий матч, H HUD" },
      ];
      if (recorder.result) {
        const r = recorder.result;
        lines.push({
          text: `rec ${r.seconds}s: ${r.fps} fps, p99 ${r.p99Ms} ms`,
          color: "#39d98a",
        });
      }
      if (probe.logged) {
        lines.push({ text: `5 с газу: dx=${probe.logged.dx}`, color: "#ffb020" });
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

  return {
    loop,
    recorder,
    probe,
    get world() {
      return world;
    },
    get player() {
      return player;
    },
  };
}
