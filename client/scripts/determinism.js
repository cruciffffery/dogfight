/**
 * Експеримент 3 (Лаба 1) без браузера: sim/ не залежить від DOM, тому фізику можна
 * прогнати в Node з будь-якою «частотою кадрів» і порівняти траєкторії.
 *
 *   npm run determinism
 */
import { integrate } from "@dogfight/shared/sim/physics.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";

const STEP = 1 / 60;
const THRUST = { turn: 0, thrust: true, brake: false };
const DURATION = 5;

function jittered(baseMs, spreadMs, seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return baseMs + ((s / 4294967296) * 2 - 1) * spreadMs;
  };
}

const scenarios = [
  { name: "60 Hz", next: () => 1000 / 60 },
  { name: "144 Hz", next: () => 1000 / 144 },
  { name: "30 Hz", next: () => 1000 / 30 },
  { name: "CPU 6× (~10 fps, jitter)", next: jittered(100, 30, 42) },
];

const start = () => ({ pos: Vector2.ZERO, vel: Vector2.ZERO, angle: 0 });

function runFixed(nextFrameMs) {
  let ship = start();
  let acc = 0;
  let simTime = 0;
  let steps = 0;
  while (simTime < DURATION - 1e-9) {
    acc += Math.min(nextFrameMs() / 1000, 0.25);
    while (acc >= STEP && simTime < DURATION - 1e-9) {
      ship = integrate(ship, THRUST, STEP);
      acc -= STEP;
      simTime += STEP;
      steps++;
    }
  }
  return { x: ship.pos.x, steps };
}

function runVariable(nextFrameMs) {
  let ship = start();
  let simTime = 0;
  let steps = 0;
  while (simTime < DURATION - 1e-9) {
    const dt = Math.min(nextFrameMs() / 1000, 0.25, DURATION - simTime);
    ship = integrate(ship, THRUST, dt);
    simTime += dt;
    steps++;
  }
  return { x: ship.pos.x, steps };
}

const rows = scenarios.map((sc) => {
  const f = runFixed(sc.next);
  const v = runVariable(sc.next);
  return {
    scenario: sc.name,
    "fixed x (px)": f.x.toFixed(6),
    "fixed steps": f.steps,
    "variable x (px)": v.x.toFixed(6),
    "variable steps": v.steps,
  };
});
console.table(rows);

const fixedXs = new Set(rows.map((r) => r["fixed x (px)"]));
const varXs = rows.map((r) => Number(r["variable x (px)"]));
console.log(
  fixedXs.size === 1
    ? "✔ fixed: однакова позиція у всіх сценаріях (біт-у-біт)"
    : "✘ fixed: позиції розходяться!",
);
console.log(
  `variable: розкид позицій ${(Math.max(...varXs) - Math.min(...varXs)).toFixed(3)} px між сценаріями`,
);
