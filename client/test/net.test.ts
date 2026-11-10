import { KIND, type Snapshot } from "@dogfight/shared/protocol.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { Command } from "@dogfight/shared/types.ts";
import { describe, expect, test } from "vitest";
import { interpolateEntities, lerpWrapped, SnapshotBuffer } from "../src/net/interpolation.ts";
import {
  type PendingInput,
  type Predicted,
  predictStep,
  reconcile,
} from "../src/net/prediction.ts";

const DT = 1 / 30;
const arena = createArena();
const thrust: Command = { turn: 0, thrust: true, brake: false, fire: false };
const left: Command = { turn: -1, thrust: true, brake: false, fire: false };
const start: Predicted = { pos: new Vector2(800, 450), vel: Vector2.ZERO, angle: 0, thrust: false };

function simulate(from: Predicted, cmds: readonly Command[]): Predicted {
  return cmds.reduce((s, c) => predictStep(s, c, DT, arena), from);
}

describe("reconciliation (pure)", () => {
  test("server agrees with the prediction → zero correction", () => {
    const cmds = [thrust, thrust, left, left, thrust];
    const pending: PendingInput[] = cmds.map((cmd, i) => ({ seq: i + 1, cmd }));
    const predicted = simulate(start, cmds);
    // сервер обробив перші 2 команди
    const server = simulate(start, cmds.slice(0, 2));
    const r = reconcile(
      predicted,
      { x: server.pos.x, y: server.pos.y, vx: server.vel.x, vy: server.vel.y, angle: server.angle },
      2,
      pending,
      DT,
      arena,
    );
    expect(r.pending.map((p) => p.seq)).toEqual([3, 4, 5]);
    expect(r.correction.length()).toBeLessThan(1e-9);
    expect(r.state.pos.x).toBeCloseTo(predicted.pos.x, 9);
  });

  test("server disagrees (e.g. a collision) → correction equals the difference", () => {
    const pending: PendingInput[] = [{ seq: 1, cmd: thrust }];
    const predicted = simulate(start, [thrust]);
    const r = reconcile(
      predicted,
      { x: 790, y: 450, vx: 0, vy: 0, angle: 0 },
      1,
      pending,
      DT,
      arena,
    );
    expect(r.pending).toHaveLength(0);
    expect(r.state.pos).toEqual(new Vector2(790, 450));
    expect(r.correction.x).toBeCloseTo(predicted.pos.x - 790, 9);
  });

  test("acked inputs are dropped; a stale ack keeps everything", () => {
    const pending: PendingInput[] = [1, 2, 3].map((seq) => ({ seq, cmd: thrust }));
    const p = simulate(start, [thrust, thrust, thrust]);
    expect(
      reconcile(p, { x: 800, y: 450, vx: 0, vy: 0, angle: 0 }, 0, pending, DT, arena).pending,
    ).toHaveLength(3);
    expect(
      reconcile(p, { x: 800, y: 450, vx: 0, vy: 0, angle: 0 }, 99, pending, DT, arena).pending,
    ).toHaveLength(0);
  });

  test("prediction wraps around the arena edge exactly like the server", () => {
    const edge: Predicted = {
      pos: new Vector2(1599, 450),
      vel: new Vector2(500, 0),
      angle: 0,
      thrust: false,
    };
    const s = predictStep(edge, thrust, DT, arena);
    expect(s.pos.x).toBeGreaterThanOrEqual(0);
    expect(s.pos.x).toBeLessThan(50);
  });
});

function snap(tick: number, x: number): Snapshot {
  return {
    tick,
    ack: 0,
    entities: [
      { id: 1, kind: KIND.asteroid, x, y: 100, angle: 0, radius: 20, variant: 1, homing: false },
    ],
    events: [],
    scores: [],
  };
}

describe("interpolation", () => {
  test("lerpWrapped goes through the edge the short way", () => {
    expect(lerpWrapped(1590, 10, 0.5, 1600)).toBeCloseTo(0, 9);
    expect(lerpWrapped(100, 200, 0.25, 1600)).toBe(125);
  });

  test("buffer brackets render time between two snapshots", () => {
    const buf = new SnapshotBuffer({ stepMs: 100 });
    buf.push(snap(1, 0), 1000);
    buf.push(snap(2, 100), 1100);
    buf.push(snap(3, 200), 1200);
    const t = buf.renderTime(1250, 100);
    const br = buf.bracket(t);
    expect(br?.a.tick).toBe(2);
    expect(br?.b.tick).toBe(3);
    const [e] = br ? interpolateEntities(br, arena) : [];
    expect(e?.x).toBeCloseTo(150, 6);
  });

  test("render time newer than the last snapshot → starved, no extrapolation", () => {
    const buf = new SnapshotBuffer({ stepMs: 100 });
    buf.push(snap(1, 0), 1000);
    const br = buf.bracket(buf.renderTime(5000, 0));
    expect(br?.starved).toBe(true);
  });

  test("old or duplicate snapshots are ignored; capacity is bounded", () => {
    const buf = new SnapshotBuffer({ stepMs: 10, capacity: 3 });
    expect(buf.push(snap(5, 0), 0)).toBe(true);
    expect(buf.push(snap(5, 0), 0)).toBe(false);
    expect(buf.push(snap(4, 0), 0)).toBe(false);
    for (let t = 6; t < 20; t++) buf.push(snap(t, 0), t * 10);
    expect(buf.items).toHaveLength(3);
  });

  test("entity present only in the older snapshot is kept; only in the newer — not yet shown", () => {
    const buf = new SnapshotBuffer({ stepMs: 100 });
    const a = snap(1, 0);
    const b: Snapshot = {
      ...snap(2, 100),
      entities: [{ id: 9, kind: KIND.pickup, x: 5, y: 5, angle: 0, ptype: 0 }],
    };
    buf.push(a, 0);
    buf.push(b, 100);
    const br = buf.bracket(150);
    expect(br && interpolateEntities(br, arena).map((e) => e.id)).toEqual([1]);
  });
});
