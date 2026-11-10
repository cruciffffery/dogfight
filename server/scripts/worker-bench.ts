/**
 * Експеримент «симуляція у worker_threads?» (Лаба 7, M4) — go/no-go за вимірами.
 *
 *   node server/scripts/worker-bench.ts
 *
 * Однаковий світ (N кораблів, що стріляють) крутимо 600 тіків двома способами:
 *   main   — world.step + buildSnapshot + encode у головному потоці (як зараз);
 *   worker — те саме у Worker, головний потік отримує готовий ArrayBuffer (transfer, без копії).
 * Міряємо: скільки часу ГОЛОВНИЙ потік зайнятий на тік, і затримку «запит тіку → кадр готовий».
 */
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { encodeSnapshot } from "@dogfight/shared/codec/binary.ts";
import { buildSnapshot } from "@dogfight/shared/protocol/snapshot.ts";
import { TICK_DT } from "@dogfight/shared/protocol.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { spatialHashCollisions } from "@dogfight/shared/sim/collision.ts";
import { Ship } from "@dogfight/shared/sim/entities/ship.ts";
import { spawnAsteroid, World } from "@dogfight/shared/sim/world.ts";
import type { Command } from "@dogfight/shared/types.ts";

function makeWorld(ships: number) {
  const world = new World({
    arena: createArena(1600, 900),
    seed: 7,
    collide: spatialHashCollisions,
    rules: { asteroids: 8, pickupEvery: 10 },
  });
  for (let i = 0; i < 8; i++) spawnAsteroid(world);
  const ids: number[] = [];
  for (let i = 0; i < ships; i++)
    ids.push(
      world.spawn(
        new Ship({ pos: world.findSafeSpot(60), name: `s${i}`, skin: "blue", color: "#fff" }),
      ).id,
    );
  const inputs = new Map<number, Command>();
  return (tick: number): ArrayBuffer => {
    for (const [i, id] of ids.entries())
      inputs.set(id, {
        thrust: (tick + i) % 3 !== 0,
        brake: false,
        turn: ((((tick >> 4) + i) % 3) - 1) as Command["turn"],
        fire: (tick + i) % 4 === 0,
      });
    world.step(TICK_DT, inputs as never);
    return encodeSnapshot({ ...buildSnapshot(world, world.drainEvents()), ack: 0 });
  };
}

const TICKS = 600;

if (!isMainThread) {
  let step: ((t: number) => ArrayBuffer) | null = null;
  parentPort?.on("message", (m: { init?: number; tick?: number }) => {
    if (m.init !== undefined) step = makeWorld(m.init);
    else if (step && m.tick !== undefined) {
      const buf = step(m.tick);
      parentPort?.postMessage(buf, [buf]);
    }
  });
} else {
  const pct = (a: number[], p: number) =>
    [...a].sort((x, y) => x - y)[Math.floor((p / 100) * (a.length - 1))] ?? 0;
  const rows = [];
  for (const ships of [8, 64, 128, 256]) {
    const step = makeWorld(ships);
    const main: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      const t0 = performance.now();
      step(t);
      main.push(performance.now() - t0);
    }
    const worker = new Worker(new URL(import.meta.url));
    worker.postMessage({ init: ships });
    const busy: number[] = [];
    const latency: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      const t0 = performance.now();
      const done = new Promise<ArrayBuffer>((r) => worker.once("message", r));
      worker.postMessage({ tick: t });
      busy.push(performance.now() - t0); // головний потік зайнятий лише на postMessage
      await done;
      latency.push(performance.now() - t0);
    }
    await worker.terminate();
    const row = {
      ships,
      mainThreadMsP50: +pct(main, 50).toFixed(3),
      mainThreadMsP99: +pct(main, 99).toFixed(3),
      workerMainBusyMsP50: +pct(busy, 50).toFixed(3),
      workerLatencyMsP50: +pct(latency, 50).toFixed(3),
      workerLatencyMsP99: +pct(latency, 99).toFixed(3),
      budgetMs: +(TICK_DT * 1000).toFixed(1),
    };
    console.log(JSON.stringify(row));
    rows.push(row);
  }
}
