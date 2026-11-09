import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { ARENAS } from "../src/arenas.ts";
import {
  CodecError,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  snapshotSize,
} from "../src/codec/binary.ts";
import * as json from "../src/codec/json.ts";
import { runScenario } from "../src/determinism.ts";
import { type EntityState, KIND, type Snapshot } from "../src/protocol.ts";
import type { Command } from "../src/types.ts";

const sample: Snapshot = {
  tick: 123456,
  ack: 4242,
  entities: [
    {
      id: 7,
      kind: KIND.ship,
      x: 812.25,
      y: 33.5,
      angle: -1.234,
      vx: 120.5,
      vy: -60.25,
      hp: 80,
      flags: 5,
      skin: 2,
    },
    {
      id: 65535,
      kind: KIND.bullet,
      x: 0,
      y: 899.9,
      angle: 3.0,
      owner: 7,
      seq: 65000,
      homing: true,
    },
    {
      id: 9,
      kind: KIND.asteroid,
      x: 1599.99,
      y: 450,
      angle: 0.5,
      radius: 46,
      variant: 200,
      homing: false,
    },
    { id: 10, kind: KIND.pickup, x: 100, y: 100, angle: 0, ptype: 2 },
  ],
  events: [{ type: 3, x: 10.5, y: 20.25, a: 7, b: 1 }],
  scores: [[7, 1325]],
};

function ship0(): Extract<EntityState, { kind: 1 }> {
  const e = sample.entities[0];
  if (e?.kind !== KIND.ship) throw new Error("fixture");
  return e;
}

describe("binary codec", () => {
  test("round trip within quantization tolerance", () => {
    const decoded = decodeSnapshot(encodeSnapshot(sample));
    assert.equal(decoded.tick, sample.tick);
    assert.equal(decoded.ack, sample.ack);
    assert.deepEqual(decoded.scores, sample.scores);
    sample.entities.forEach((e: EntityState, i) => {
      const d = decoded.entities[i];
      assert.ok(d);
      assert.equal(d.id, e.id);
      assert.equal(d.kind, e.kind);
      assert.ok(Math.abs(d.x - e.x) < 1e-3 * Math.max(1, Math.abs(e.x)), "x as Float32");
      assert.ok(Math.abs(d.y - e.y) < 1e-3 * Math.max(1, Math.abs(e.y)), "y as Float32");
      assert.ok(Math.abs(d.angle - e.angle) <= 0.0005, "angle quantized to 1/1000 rad");
    });
    const [ship, bullet, asteroid, pickup] = decoded.entities;
    assert.ok(ship?.kind === KIND.ship && ship.hp === 80);
    assert.ok(bullet?.kind === KIND.bullet && bullet.seq === 65000 && bullet.homing);
    assert.ok(asteroid?.kind === KIND.asteroid && asteroid.radius === 46);
    assert.ok(pickup?.kind === KIND.pickup && pickup.ptype === 2);
  });

  test("encoded length matches the spec", () => {
    // 14 header + ship 24 + bullet 18 + asteroid 16 + pickup 14 + 1 event 13 + 1 score 6
    assert.equal(snapshotSize(sample), 14 + 24 + 18 + 16 + 14 + 13 + 6);
    assert.equal(encodeSnapshot(sample).byteLength, 105);
  });

  test("little-endian on the wire: tick 1 → bytes 01 00 00 00", () => {
    const buf = new Uint8Array(encodeSnapshot({ ...sample, tick: 1 }));
    assert.equal(buf[0], 0x10);
    assert.deepEqual([...buf.slice(1, 5)], [1, 0, 0, 0]);
  });

  test("range checks on encode", () => {
    assert.throws(() => encodeSnapshot({ ...sample, tick: -1 }), CodecError);
    assert.throws(
      () => encodeSnapshot({ ...sample, entities: [{ ...ship0(), hp: 300 }] }),
      CodecError,
    );
    assert.throws(
      () => encodeSnapshot({ ...sample, entities: [{ ...ship0(), x: Number.NaN }] }),
      CodecError,
    );
  });

  test("garbage → CodecError, never another exception", () => {
    const good = new Uint8Array(encodeSnapshot(sample));
    for (const bad of [
      new Uint8Array(0),
      new Uint8Array([0x10]),
      good.slice(0, good.length - 1),
      Uint8Array.from([...good, 0]),
      Uint8Array.from(good, (b, i) => (i === 5 ? 99 : b)), // версія
      Uint8Array.from(good, (b, i) => (i === 16 ? 77 : b)), // невідомий kind
    ]) {
      assert.throws(() => decodeSnapshot(bad), CodecError);
    }
  });

  test("input round trip", () => {
    const cmds: Command[] = [
      { turn: -1, thrust: true, brake: false, fire: false },
      { turn: 0, thrust: false, brake: true, fire: true },
      { turn: 1, thrust: true, brake: false, fire: true },
    ];
    const buf = encodeInput(99, cmds);
    assert.equal(buf.byteLength, 7 + 3);
    assert.deepEqual(decodeInput(buf), { seq: 99, cmds });
    assert.throws(() => decodeInput(new Uint8Array([1, 0, 0, 0, 0, 1, 1, 0xff])), CodecError);
  });

  test("JSON codec round trip is exact", () => {
    assert.deepEqual(json.decodeSnapshot(json.encodeSnapshot(sample)), sample);
  });
});

describe("determinism", () => {
  test("same inputs → same world hash", async () => {
    const a = await runScenario();
    const b = await runScenario();
    assert.equal(a.hash, b.hash);
    assert.equal(a.tick, 300);
  });

  test("the simulation loads without a DOM", async () => {
    assert.equal("window" in globalThis, false);
    assert.equal("document" in globalThis, false);
    await import("../src/sim/world.ts");
  });
});

describe("arenas", () => {
  test("client JSON files match shared/src/arenas.js", () => {
    for (const [id, arena] of Object.entries(ARENAS)) {
      const file = new URL(`../../client/public/assets/arenas/${id}.json`, import.meta.url);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), arena);
    }
  });
});
