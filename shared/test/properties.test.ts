/**
 * Property-based тести (fast-check): не «ось приклад», а «для БУДЬ-ЯКИХ даних з цього
 * простору виконується властивість». Якщо знайдено контрприклад, fast-check зменшує
 * (shrinking) його до мінімального й показує в повідомленні.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CodecError,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  snapshotSize,
} from "../src/codec/binary.ts";
import {
  ClientMessageSchema,
  type EntityState,
  EVENT,
  KIND,
  type Snapshot,
} from "../src/protocol.ts";
import { Ship } from "../src/sim/entities/ship.ts";
import { Entity } from "../src/sim/entity.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import type { Command } from "../src/types.ts";

// ---------- генератори ----------
const coord = fc.double({ min: -5000, max: 5000, noNaN: true, noDefaultInfinity: true });
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
const u8 = fc.integer({ min: 0, max: 255 });
const u16 = fc.integer({ min: 0, max: 0xffff });
const u32 = fc.integer({ min: 0, max: 0xffffffff });
const base = { id: u16, x: coord, y: coord, angle };

const entityArb: fc.Arbitrary<EntityState> = fc.oneof(
  fc.record({
    ...base,
    kind: fc.constant(KIND.ship),
    vx: coord,
    vy: coord,
    hp: u8,
    flags: u8,
    skin: u8,
  }),
  fc.record({
    ...base,
    kind: fc.constant(KIND.bullet),
    owner: u16,
    seq: u16,
    homing: fc.boolean(),
  }),
  fc.record({
    ...base,
    kind: fc.constant(KIND.asteroid),
    radius: u8,
    variant: u8,
    homing: fc.boolean(),
  }),
  fc.record({ ...base, kind: fc.constant(KIND.pickup), ptype: u8 }),
);
const eventArb = fc.record({
  type: fc.constantFrom(EVENT.fired, EVENT.hit, EVENT.exploded, EVENT.picked, EVENT.scored),
  x: coord,
  y: coord,
  a: u16,
  b: u16,
});
const snapshotArb: fc.Arbitrary<Snapshot> = fc.record({
  tick: u32,
  ack: u32,
  entities: fc.array(entityArb, { maxLength: 60 }),
  events: fc.array(eventArb, { maxLength: 20 }),
  scores: fc.array(fc.tuple(u16, u32), { maxLength: 8 }),
});
const commandArb: fc.Arbitrary<Command> = fc.record({
  turn: fc.constantFrom(-1, 0, 1),
  thrust: fc.boolean(),
  brake: fc.boolean(),
  fire: fc.boolean(),
});

const f32 = (x: number) => Math.fround(x);

describe("properties", () => {
  test("P1: snapshot round trip stays within quantization tolerance", () => {
    fc.assert(
      fc.property(snapshotArb, (snap) => {
        const back = decodeSnapshot(encodeSnapshot(snap));
        expect(back.tick).toBe(snap.tick);
        expect(back.ack).toBe(snap.ack);
        expect(back.scores).toEqual(snap.scores);
        expect(back.entities).toHaveLength(snap.entities.length);
        snap.entities.forEach((e, i) => {
          const d = back.entities[i];
          expect(d?.kind).toBe(e.kind);
          expect(d?.x).toBe(f32(e.x)); // Float32 — точно як Math.fround
          expect(d?.y).toBe(f32(e.y));
          expect(Math.abs((d?.angle ?? 99) - e.angle)).toBeLessThanOrEqual(0.0005 + 1e-12);
        });
        back.events.forEach((ev, i) => {
          expect(ev.type).toBe(snap.events[i]?.type);
        });
      }),
      { numRuns: 300 },
    );
  });

  test("P2: encoded length always matches the spec formula", () => {
    fc.assert(
      fc.property(snapshotArb, (snap) => {
        const extra = { [KIND.ship]: 11, [KIND.bullet]: 5, [KIND.asteroid]: 3, [KIND.pickup]: 1 };
        const expected =
          14 +
          snap.entities.reduce((s, e) => s + 13 + extra[e.kind], 0) +
          13 * snap.events.length +
          6 * snap.scores.length;
        expect(encodeSnapshot(snap).byteLength).toBe(expected);
        expect(snapshotSize(snap)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  test("P3: random garbage → a valid snapshot or CodecError, never anything else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        try {
          decodeSnapshot(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(CodecError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  test("P3b: a valid snapshot with ONE flipped byte → still only CodecError or a snapshot", () => {
    fc.assert(
      fc.property(snapshotArb, fc.nat(), u8, (snap, at, value) => {
        const bytes = new Uint8Array(encodeSnapshot(snap));
        bytes[at % bytes.length] = value;
        try {
          decodeSnapshot(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(CodecError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("P4: input round trip and garbage input never crash", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.array(commandArb, { minLength: 1, maxLength: 3 }),
        (seq, cmds) => {
          expect(decodeInput(encodeInput(seq, cmds))).toEqual({ seq, cmds });
        },
      ),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 20 }), (bytes) => {
        try {
          decodeInput(bytes);
        } catch (err) {
          expect(err).toBeInstanceOf(CodecError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("P5: ships stay inside the arena over 1000 random input steps", () => {
    fc.assert(
      fc.property(
        fc.array(commandArb, { minLength: 1000, maxLength: 1000 }),
        fc.integer({ min: 1, max: 1e6 }),
        (cmds, seed) => {
          Entity.resetIds();
          const world = new World({ seed, director: () => {} });
          const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
          cmds.forEach((cmd, i) => {
            world.step(1 / 30, new Map([[ship.id, { ...cmd, seq: i + 1 }]]));
            expect(ship.pos.x).toBeGreaterThanOrEqual(0);
            expect(ship.pos.x).toBeLessThan(world.arena.width);
            expect(ship.pos.y).toBeGreaterThanOrEqual(0);
            expect(ship.pos.y).toBeLessThan(world.arena.height);
          });
        },
      ),
      { numRuns: 25 },
    );
  });

  // ---------- парсер повідомлень ----------
  const nameArb = fc.stringMatching(/^[A-Za-z0-9 _.-]{1,16}$/).filter((s) => s.trim().length > 0);
  const validMsgArb = fc.oneof(
    fc.record({
      v: fc.constant(1),
      type: fc.constant("join"),
      room: fc.stringMatching(/^[a-z0-9-]{1,32}$/),
      name: nameArb,
    }),
    fc.record({
      v: fc.constant(1),
      type: fc.constant("chat"),
      text: fc.string({ minLength: 1, maxLength: 200 }).filter((t) => t.trim().length > 0),
    }),
    fc.record({
      v: fc.constant(1),
      type: fc.constant("ping"),
      t: fc.double({ noNaN: true, noDefaultInfinity: true }),
    }),
    fc.record({
      v: fc.constant(1),
      type: fc.constant("input"),
      seq: fc.integer({ min: 1, max: 0xffffffff }),
      cmds: fc.array(commandArb, { minLength: 1, maxLength: 3 }),
    }),
    fc.record({ v: fc.constant(1), type: fc.constant("leave") }),
  );

  test("P6: the parser accepts every generated valid message", () => {
    fc.assert(
      fc.property(validMsgArb, (msg) => {
        expect(ClientMessageSchema.safeParse(msg).success).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("P7: …and rejects every mutation of one (extra field, wrong version, wrong field type)", () => {
    const mutation = fc.constantFrom("extra", "version", "type", "dropType");
    fc.assert(
      fc.property(validMsgArb, mutation, (msg, how) => {
        const bad: Record<string, unknown> =
          how === "extra"
            ? { ...msg, hacked: true }
            : how === "version"
              ? { ...msg, v: 2 }
              : how === "type"
                ? { ...msg, type: `${msg.type}!` }
                : Object.fromEntries(Object.entries(msg).filter(([k]) => k !== "type"));
        expect(ClientMessageSchema.safeParse(bad).success).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
