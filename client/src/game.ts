/**
 * Локальна гра без сервера (?offline): світ + цикл + рендер + HUD + звук.
 */
import type { ArenaConfig } from "@dogfight/shared/protocol.ts";
import { dummyPilot } from "@dogfight/shared/sim/ai.ts";
import { createArena, torusDelta } from "@dogfight/shared/sim/arena.ts";
import { Ship } from "@dogfight/shared/sim/entities/ship.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { spawnAsteroid, World } from "@dogfight/shared/sim/world.ts";
import type { EntityId, SeqCommand } from "@dogfight/shared/types.ts";
import { attachAudio } from "./audio.ts";
import { busyWait, createRecorder, type ExperimentConfig, type Recorder } from "./experiments.ts";
import { createHud, type Hud } from "./hud.ts";
import { createInput, readCommand } from "./input.ts";
import { createLoop, type Loop, type LoopStats } from "./loop.ts";
import type { View } from "./render/canvas.ts";
import { createStarfield, drawBackground, drawBanner, drawHud, drawWorld } from "./render/draw.ts";

const STEP = 1 / 60;
const AUTOPILOT: SeqCommand = Object.freeze({
  seq: 0,
  turn: 0,
  thrust: true,
  brake: false,
  fire: false,
});

interface MatchState {
  world: World;
  player: Ship;
  hud: Hud;
}

export interface LocalGame {
  readonly loop: Loop;
  readonly recorder: Recorder;
  readonly world: World;
  readonly player: Ship;
}

export function startGame({
  view,
  arenaConfig,
  name = "you",
  config,
}: {
  view: View;
  arenaConfig: ArenaConfig;
  name?: string;
  config: ExperimentConfig;
}): LocalGame {
  const arena = createArena(arenaConfig.width, arenaConfig.height);
  view.setArena(arena);
  const stars = createStarfield(arena, Math.round((arena.width * arena.height) / 5500));
  const input = createInput(window);
  const recorder = createRecorder({ seconds: config.recordSeconds });
  const probe: { distance: Vector2; logged: Record<string, number | string> | null } = {
    distance: Vector2.ZERO,
    logged: null,
  };
  const inputs = new Map<EntityId, SeqCommand>();
  let showHud = true;
  let seq = 0;

  function newMatch(): MatchState {
    const world = new World({
      arena,
      seed: arenaConfig.seed,
      rules: { asteroids: arenaConfig.asteroids, pickupEvery: arenaConfig.pickupEvery },
    });
    const player = world.spawn(
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
    const nameOf = (id: number): string => {
      for (const s of world.ofKind("ship")) if (s.id === id) return s.name;
      return `#${id}`;
    };
    attachAudio(world, { isLocal: (id) => id === player.id });
    const hud = createHud(world, { nameOf, localId: () => player.id });
    probe.distance = Vector2.ZERO;
    probe.logged = null;
    return { world, player, hud };
  }

  let match = newMatch();

  // Баг з this (Лаба 2): input.onPress("KeyF", match.player.fire) → TypeError. Виправлення:
  input.onPress("KeyF", () => match.player.fire(match.world));

  function simulate(dt: number): void {
    if (input.justPressed("KeyR")) match = newMatch();
    if (input.justPressed("KeyH")) showHud = !showHud;
    if (input.justPressed("KeyM")) recorder.restart();
    const { world, player, hud } = match;
    seq += 1;
    inputs.set(player.id, config.autopilot ? AUTOPILOT : { ...readCommand(input), seq });
    world.step(dt, inputs);
    world.drainEvents();
    hud.update(dt);
    probe.distance = probe.distance.add(torusDelta(player.prevPos, player.pos, arena));
    input.endStep();
  }

  function logProbe(stats: LoopStats): void {
    if (!config.autopilot || probe.logged || match.world.time < 5 - 1e-9) return;
    probe.logged = {
      mode: `${stats.scheduler} · ${stats.timestep}`,
      simTime: +match.world.time.toFixed(4),
      steps: match.world.tick,
      dx: +probe.distance.x.toFixed(3),
      dy: +probe.distance.y.toFixed(3),
    };
    console.log("[lab] переміщення після 5 с газу:", probe.logged);
  }

  let renderedFrames = 0;
  const toScreen = (x: number, y: number) => ({
    x: view.offsetX + x * view.scale,
    y: view.offsetY + y * view.scale,
  });

  function render(alpha: number, stats: LoopStats): void {
    renderedFrames += 1;
    recorder.onFrame(stats);
    logProbe(stats);
    if (config.blockEvery && renderedFrames % config.blockEvery === 0) busyWait(config.blockMs);
    const { world, player, hud } = match;
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
      const r = recorder.result;
      if (r)
        lines.push({
          text: `rec ${r.seconds}s: ${r.fps} fps, p99 ${r.p99Ms} ms`,
          color: "#39d98a",
        });
      if (probe.logged) lines.push({ text: `5 с газу: dx=${probe.logged.dx}`, color: "#ffb020" });
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

  return {
    loop,
    recorder,
    get world() {
      return match.world;
    },
    get player() {
      return match.player;
    },
  };
}
