import { beforeEach, describe, expect, test } from "vitest";
import { ARENAS, isArenaId } from "../src/arenas.ts";
import { binaryCodec, CodecError, codecs, frameSize, jsonCodec } from "../src/codec/index.ts";
import { buildSnapshot, entityState, eventState, SHIP_FLAG } from "../src/protocol/snapshot.ts";
import {
  encodeServerMessage,
  KIND,
  parseClientMessage,
  parseServerMessage,
} from "../src/protocol.ts";
import { Asteroid } from "../src/sim/entities/asteroid.ts";
import { Bullet } from "../src/sim/entities/bullet.ts";
import { Explosion } from "../src/sim/entities/explosion.ts";
import { Pickup } from "../src/sim/entities/pickup.ts";
import { Ship } from "../src/sim/entities/ship.ts";
import { Entity } from "../src/sim/entity.ts";
import { createRng } from "../src/sim/rng.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import { assertNever, EntityId, PlayerId, Seq, Tick } from "../src/types.ts";

beforeEach(() => Entity.resetIds());

describe("World → Snapshot", () => {
  test("every entity kind maps to its state; explosions are not sent", () => {
    const world = new World({ director: () => {} });
    const ship = world.spawn(new Ship({ pos: new Vector2(10, 20), skin: "green" }));
    ship.thrust = true;
    ship.effects.shield = 1;
    world.spawn(new Bullet({ pos: new Vector2(1, 1), vel: new Vector2(5, 0), ownerId: ship.id }));
    world.spawn(
      new Asteroid({ pos: new Vector2(300, 300), vel: Vector2.ZERO, radius: 30.4, shapeSeed: 513 }),
    );
    world.spawn(new Pickup({ pos: new Vector2(500, 500), type: "homing" }));
    world.spawn(new Explosion({ pos: new Vector2(0, 0), rng: createRng(1) }));
    const snap = buildSnapshot(world, []);
    expect(snap.entities.map((e) => e.kind)).toEqual([
      KIND.ship,
      KIND.bullet,
      KIND.asteroid,
      KIND.pickup,
    ]);
    const [s, , a, p] = snap.entities;
    expect(s?.kind === KIND.ship && s.flags).toBe(SHIP_FLAG.thrust | SHIP_FLAG.shield);
    expect(s?.kind === KIND.ship && s.skin).toBe(2);
    expect(a?.kind === KIND.asteroid && [a.radius, a.variant]).toEqual([30, 513 & 0xff]);
    expect(p?.kind === KIND.pickup && p.ptype).toBe(2);
    expect(entityState(new Explosion({ pos: Vector2.ZERO, rng: createRng(2) }))).toBeNull();
  });

  test("every world event maps to a compact event", () => {
    const pos = new Vector2(1, 2);
    const id = EntityId(7);
    const events = [
      eventState({ type: "fired", detail: { ownerId: id, bulletId: id, pos }, tick: 1 }),
      eventState({ type: "hit", detail: { targetId: id, byId: null, pos }, tick: 1 }),
      eventState({ type: "exploded", detail: { id, kind: "asteroid", byId: null, pos }, tick: 1 }),
      eventState({ type: "picked", detail: { id, type: "rapid", pos }, tick: 1 }),
      eventState({ type: "scored", detail: { id, points: 100, total: 300, pos }, tick: 1 }),
    ];
    expect(events.map((e) => [e.type, e.b])).toEqual([
      [1, 0],
      [2, 0],
      [3, KIND.asteroid],
      [4, 1],
      [5, 100],
    ]);
  });

  test("snapshot of a real world survives both codecs", () => {
    const world = new World({ seed: 4 });
    world.spawn(new Ship({ pos: new Vector2(100, 100) }));
    for (let i = 0; i < 30; i++) world.step(1 / 30);
    const snap = buildSnapshot(world, world.drainEvents());
    for (const codec of [binaryCodec, jsonCodec]) {
      const back = codec.decodeSnapshot(codec.encodeSnapshot(snap));
      expect(back.tick).toBe(snap.tick);
      expect(back.entities.length).toBe(snap.entities.length);
    }
    expect(codecs.binary).toBe(binaryCodec);
    expect(frameSize(binaryCodec.encodeSnapshot(snap))).toBeLessThan(
      frameSize(jsonCodec.encodeSnapshot(snap)),
    );
    expect(frameSize("ї")).toBe(2);
  });

  test("codecs refuse frames of the wrong kind", () => {
    expect(() => binaryCodec.decodeSnapshot("{}")).toThrow(CodecError);
    expect(() => jsonCodec.decodeSnapshot(new ArrayBuffer(4))).toThrow(CodecError);
    expect(() => jsonCodec.decodeSnapshot("not json")).toThrow(CodecError);
    expect(() => jsonCodec.decodeSnapshot('{"type":"snapshot"}')).toThrow(CodecError);
    expect(
      typeof jsonCodec.encodeInput(1, [{ turn: 0, thrust: true, brake: false, fire: false }]),
    ).toBe("string");
  });
});

describe("server messages", () => {
  test("encode → parse round trip for every server message type", () => {
    const room = { id: "alpha", name: "A", arena: "classic", players: 1, maxPlayers: 8 };
    const msgs = [
      encodeServerMessage({
        type: "welcome",
        playerId: 1,
        shipId: 2,
        room,
        arena: ARENAS.classic,
        tickRate: 30,
        codec: "binary",
      }),
      encodeServerMessage({
        type: "roster",
        players: [{ id: 1, name: "Ann", shipId: 2, skin: "blue" }],
      }),
      encodeServerMessage({ type: "chat", from: 1, name: "Ann", text: "hi", t: 5 }),
      encodeServerMessage({ type: "pong", t: 1.5 }),
      encodeServerMessage({ type: "error", code: "X", message: "y" }),
      encodeServerMessage({ type: "shutdown" }),
    ];
    for (const m of msgs) expect(parseServerMessage(m).ok).toBe(true);
  });

  test("bad server frames are rejected, not trusted", () => {
    expect(parseServerMessage('{"v":1,"type":"roster","players":"all"}').ok).toBe(false);
    expect(parseServerMessage(42).ok).toBe(false);
    expect(parseServerMessage(new TextEncoder().encode('{"v":1,"type":"shutdown"}')).ok).toBe(true);
    expect(parseClientMessage(new ArrayBuffer(3)).ok).toBe(false);
  });
});

describe("types and arenas", () => {
  test("brand constructors validate input", () => {
    expect(EntityId(3)).toBe(3);
    expect(Tick(0)).toBe(0);
    expect(Seq(10)).toBe(10);
    expect(PlayerId(1)).toBe(1);
    expect(() => EntityId(-1)).toThrow(RangeError);
    expect(() => Seq(1.5)).toThrow(RangeError);
  });

  test("assertNever throws with a readable message", () => {
    expect(() => assertNever("oops" as never, "thing")).toThrow(/Unhandled thing/);
  });

  test("arena ids", () => {
    expect(isArenaId("duel")).toBe(true);
    expect(isArenaId("moon")).toBe(false);
  });
});
