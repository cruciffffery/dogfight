import { beforeEach, describe, expect, test } from "vitest";
import { worldHash } from "../src/determinism.ts";
import { dummyPilot } from "../src/sim/ai.ts";
import { createArena, torusDelta, wrapPos } from "../src/sim/arena.ts";
import { homingSystem, withHoming } from "../src/sim/behaviors.ts";
import {
  circlesOverlap,
  naiveCollisions,
  spatialHashCollisions,
  sweptOverlap,
} from "../src/sim/collision.ts";
import { Asteroid } from "../src/sim/entities/asteroid.ts";
import { Bullet } from "../src/sim/entities/bullet.ts";
import { Explosion } from "../src/sim/entities/explosion.ts";
import { isPickupType, Pickup } from "../src/sim/entities/pickup.ts";
import { SHIP_RULES, Ship } from "../src/sim/entities/ship.ts";
import { Entity } from "../src/sim/entity.ts";
import { integrate, lerpAngle, SHIP, wrapAngle } from "../src/sim/physics.ts";
import { createRng } from "../src/sim/rng.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { defaultDirector, spawnAsteroid, World } from "../src/sim/world.ts";
import { EntityId, type SeqCommand } from "../src/types.ts";

const DT = 1 / 30;
const noDirector = () => {};
const idle: SeqCommand = { seq: 0, turn: 0, thrust: false, brake: false, fire: false };
const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

beforeEach(() => Entity.resetIds());

describe("Vector2", () => {
  test("add / sub / scale are pure", () => {
    const a = new Vector2(1, 2);
    const b = new Vector2(3, 4);
    expect(a.add(b)).toEqual(new Vector2(4, 6));
    expect(b.sub(a)).toEqual(new Vector2(2, 2));
    expect(a.scale(3)).toEqual(new Vector2(3, 6));
    expect(a).toEqual(new Vector2(1, 2));
  });
  test("is frozen", () => {
    expect(Object.isFrozen(new Vector2(1, 1))).toBe(true);
  });
  test("length, normalize, zero vector", () => {
    expect(new Vector2(3, 4).length()).toBe(5);
    close(new Vector2(3, 4).normalize().length(), 1);
    expect(Vector2.ZERO.normalize()).toBe(Vector2.ZERO);
  });
  test("rotate 90° and dot", () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    close(r.x, 0);
    close(r.y, 1);
    expect(new Vector2(1, 2).dot(new Vector2(3, 4))).toBe(11);
  });
  test("fromAngle / angle / clampLength", () => {
    const v = Vector2.fromAngle(Math.PI / 4, 2);
    close(v.angle(), Math.PI / 4);
    close(v.length(), 2);
    close(new Vector2(30, 40).clampLength(5).length(), 5);
    const short = new Vector2(1, 1);
    expect(short.clampLength(5)).toBe(short);
  });
});

describe("physics", () => {
  const rest = { pos: Vector2.ZERO, vel: Vector2.ZERO, angle: 0 };
  test("one thrust step from rest", () => {
    const s = integrate(rest, { turn: 0, thrust: true, brake: false, fire: false }, DT);
    const expected = SHIP.thrustAccel * DT * Math.exp(-SHIP.drag * DT);
    close(s.vel.x, expected);
    close(s.pos.x, expected * DT);
    expect(s.thrust).toBe(true);
  });
  test("turn changes heading by turnRate·dt", () => {
    close(
      integrate(rest, { turn: 1, thrust: false, brake: false, fire: false }, DT).angle,
      SHIP.turnRate * DT,
    );
  });
  test("brake slows down faster than drag alone", () => {
    const moving = { pos: Vector2.ZERO, vel: new Vector2(300, 0), angle: 0 };
    const drag = integrate(moving, { turn: 0, thrust: false, brake: false, fire: false }, DT);
    const brake = integrate(moving, { turn: 0, thrust: false, brake: true, fire: false }, DT);
    expect(brake.vel.x).toBeLessThan(drag.vel.x);
  });
  test("speed is clamped to maxSpeed", () => {
    let s = { ...rest, thrust: false };
    for (let i = 0; i < 600; i++)
      s = integrate(s, { turn: 0, thrust: true, brake: false, fire: false }, DT);
    expect(s.vel.length()).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-9);
  });
  test("wrapAngle and lerpAngle take the short way", () => {
    close(wrapAngle(3 * Math.PI), -Math.PI);
    close(lerpAngle(3.1, -3.1, 0.5), Math.PI, 1e-2);
  });
});

describe("arena", () => {
  const arena = createArena(100, 50);
  test("wrapPos keeps the same object when inside", () => {
    const p = new Vector2(10, 10);
    expect(wrapPos(p, arena)).toBe(p);
    expect(wrapPos(new Vector2(-5, 55), arena)).toEqual(new Vector2(95, 5));
  });
  test("torusDelta picks the shortest way through the edge", () => {
    expect(torusDelta(new Vector2(95, 25), new Vector2(5, 25), arena)).toEqual(new Vector2(10, 0));
  });
});

describe("collisions", () => {
  const arena = createArena();
  const at = (x: number, y: number, r: number) =>
    new Asteroid({ pos: new Vector2(x, y), vel: Vector2.ZERO, radius: r });

  test("touching circles do not overlap; overlapping do; far apart do not", () => {
    expect(circlesOverlap(at(0, 0, 10), at(20, 0, 10), arena)).toBe(false);
    expect(circlesOverlap(at(0, 0, 10), at(19, 0, 10), arena)).toBe(true);
    expect(circlesOverlap(at(0, 0, 10), at(300, 0, 10), arena)).toBe(false);
  });
  test("overlap through the arena edge", () => {
    expect(circlesOverlap(at(2, 450, 10), at(1598, 450, 10), arena)).toBe(true);
  });

  test("fast bullet would tunnel through a ship with a point-in-time test; swept test catches it", () => {
    // относна швидкість 1320 px/с → 44 px за тік; сума радіусів 17 (діаметр «цілі» 34 px)
    const ship = new Ship({ pos: new Vector2(800, 450) });
    const bullet = new Bullet({
      pos: new Vector2(730, 450),
      vel: new Vector2(760, 0),
      ownerId: EntityId(999),
    });
    ship.vel = new Vector2(-560, 0);
    const step = () => {
      for (const e of [ship, bullet]) {
        e.savePrev();
        e.pos = e.pos.add(e.vel.scale(DT));
      }
    };
    step(); // 70 → 26 px
    expect(circlesOverlap(bullet, ship, arena)).toBe(false);
    step(); // 26 → −18 px: перескочила
    expect(circlesOverlap(bullet, ship, arena)).toBe(false);
    expect(sweptOverlap(bullet, ship, arena)).toBe(true);
  });

  test("bullet hits the ship in a full World step at 1320 px/s relative speed", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    ship.vel = new Vector2(-560, 0);
    world.spawn(
      new Bullet({ pos: new Vector2(730, 450), vel: new Vector2(760, 0), ownerId: EntityId(999) }),
    );
    for (let i = 0; i < 5; i++) world.step(DT);
    expect(ship.hp).toBe(SHIP_RULES.maxHp - 20);
  });

  test("spatial hash finds exactly the same pairs as the naive O(n²) pass", () => {
    const world = new World({ director: noDirector, seed: 3 });
    const rng = createRng(9);
    for (let i = 0; i < 120; i++) {
      world.spawn(at(rng.range(0, 1600), rng.range(0, 900), rng.range(5, 40)));
    }
    const ids = (pairs: Iterable<readonly [Entity, Entity]>) =>
      [...pairs].map(([a, b]) => `${a.id}-${b.id}`);
    expect(ids(spatialHashCollisions(world))).toEqual(ids(naiveCollisions(world)));
    expect(ids(naiveCollisions(world)).length).toBeGreaterThan(5);
  });
});

describe("World", () => {
  test("Map-backed store: spawn, get, iterate, ofKind generator", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(10, 10) }));
    world.spawn(new Asteroid({ pos: new Vector2(500, 500), vel: Vector2.ZERO, radius: 20 }));
    expect(world.get(ship.id)).toBe(ship);
    expect([...world].length).toBe(2);
    expect([...world.ofKind("ship")]).toEqual([ship]);
    expect(world.size).toBe(2);
  });

  test("despawn is deferred to the end of the step", () => {
    const world = new World({ director: noDirector });
    const a = world.spawn(
      new Asteroid({ pos: new Vector2(500, 500), vel: Vector2.ZERO, radius: 20 }),
    );
    world.despawn(a.id);
    expect(a.alive).toBe(false);
    expect(world.get(a.id)).toBe(a); // ще в Map
    world.step(DT);
    expect(world.get(a.id)).toBeUndefined();
  });

  test("determinism: two worlds with the same seed and inputs end in the same state", () => {
    const run = () => {
      Entity.resetIds();
      const world = new World({ seed: 11 });
      const a = world.spawn(new Ship({ pos: new Vector2(300, 300), ai: dummyPilot }));
      world.spawn(new Ship({ pos: new Vector2(1200, 600), ai: dummyPilot }));
      for (let i = 0; i < 6; i++) spawnAsteroid(world);
      for (let t = 0; t < 900; t++)
        world.step(DT, new Map([[a.id, { ...idle, seq: t, thrust: t % 3 === 0 }]]));
      return {
        hash: worldHash(world),
        state: [...world].map((e) => ({
          id: e.id,
          kind: e.kind,
          x: e.pos.x,
          y: e.pos.y,
          a: e.angle,
        })),
        scores: [...world.scores],
      };
    };
    expect(run()).toEqual(run());
  });

  test("ship is destroyed, explodes, and respawns after 2 s with full hp and a shield", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    const exploded: string[] = [];
    world.on("exploded", (d) => exploded.push(d.kind));
    for (let i = 0; i < 5; i++) {
      world.spawn(
        new Bullet({ pos: new Vector2(790, 450), vel: new Vector2(10, 0), ownerId: EntityId(77) }),
      );
      world.step(DT);
    }
    expect(ship.destroyed).toBe(true);
    expect(exploded).toEqual(["ship"]);
    expect([...world.ofKind("explosion")]).toHaveLength(1);
    expect(world.scores.get(EntityId(77))).toBe(100);
    for (let i = 0; i < 61; i++) world.step(DT);
    expect(ship.destroyed).toBe(false);
    expect(ship.hp).toBe(SHIP_RULES.maxHp);
    expect(ship.effects.shield).toBeGreaterThan(0);
  });

  test("findSafeSpot keeps clear of everything", () => {
    const world = new World({ director: noDirector, seed: 5 });
    for (let i = 0; i < 10; i++) spawnAsteroid(world);
    const spot = world.findSafeSpot(60);
    for (const a of world.ofKind("asteroid"))
      expect(spot.sub(a.pos).length() - a.radius).toBeGreaterThanOrEqual(0);
  });

  test("default director keeps the asteroid count and drops pickups on schedule", () => {
    const world = new World({ seed: 2, rules: { asteroids: 4, pickupEvery: 1 } });
    for (let i = 0; i < 31; i++) world.step(DT);
    expect([...world.ofKind("asteroid")].length).toBeGreaterThanOrEqual(4);
    expect([...world.ofKind("pickup")].length).toBeGreaterThanOrEqual(1);
    defaultDirector(world, DT);
  });
});

describe("rules", () => {
  test("own bullets never hurt their owner", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    world.spawn(new Bullet({ pos: new Vector2(800, 450), vel: Vector2.ZERO, ownerId: ship.id }));
    world.step(DT);
    expect(ship.hp).toBe(SHIP_RULES.maxHp);
  });

  test("shield blocks damage", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    ship.effects.shield = 5;
    world.spawn(
      new Bullet({ pos: new Vector2(800, 450), vel: Vector2.ZERO, ownerId: EntityId(5) }),
    );
    world.step(DT);
    expect(ship.hp).toBe(SHIP_RULES.maxHp);
  });

  test("big asteroid splits in two when destroyed", () => {
    const world = new World({ director: noDirector });
    const rock = world.spawn(
      new Asteroid({ pos: new Vector2(800, 450), vel: Vector2.ZERO, radius: 40 }),
    );
    rock.hp = 1;
    world.spawn(
      new Bullet({ pos: new Vector2(800, 450), vel: new Vector2(1, 0), ownerId: EntityId(5) }),
    );
    world.step(DT);
    world.step(DT);
    const rocks = [...world.ofKind("asteroid")];
    expect(rocks).toHaveLength(2);
    expect(rocks.every((r) => r.radius < 40)).toBe(true);
  });

  test("pickup applies its effect through composition and disappears", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    world.spawn(new Pickup({ pos: new Vector2(805, 450), type: "rapid" }));
    world.step(DT);
    expect(ship.effects.rapid).toBeGreaterThan(7);
    expect([...world.ofKind("pickup")]).toHaveLength(0);
    expect(isPickupType("rapid")).toBe(true);
    expect(isPickupType("laser")).toBe(false);
  });

  test("rapid fire shortens the cooldown; homing effect makes homing bullets", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    ship.effects.rapid = 5;
    ship.effects.homing = 5;
    const b = ship.fire(world);
    expect(ship.cooldown).toBe(SHIP_RULES.rapidFireCooldown);
    expect(b?.homing).not.toBeNull();
    expect(ship.fire(world)).toBeNull(); // ще cooldown
  });

  test("ships and asteroids bounce apart", () => {
    const world = new World({ director: noDirector });
    const ship = world.spawn(new Ship({ pos: new Vector2(800, 450) }));
    ship.vel = new Vector2(200, 0);
    world.spawn(new Asteroid({ pos: new Vector2(830, 450), vel: Vector2.ZERO, radius: 20 }));
    world.step(DT);
    expect(ship.vel.x).toBeLessThan(0);
    expect(ship.hp).toBeLessThan(SHIP_RULES.maxHp);
  });
});

describe("behaviors and AI", () => {
  test("homing turns a bullet towards the nearest target, but not towards its owner", () => {
    const world = new World({ director: noDirector });
    const owner = world.spawn(new Ship({ pos: new Vector2(100, 100) }));
    const target = world.spawn(new Ship({ pos: new Vector2(400, 300) }));
    const bullet = withHoming(
      world.spawn(
        new Bullet({ pos: new Vector2(150, 100), vel: new Vector2(300, 0), ownerId: owner.id }),
      ),
      { targetKind: "ship", turnRate: 10, range: 1000, ignoreId: owner.id },
    );
    homingSystem(world, DT);
    expect(bullet.vel.y).toBeGreaterThan(0); // повернула вниз, до цілі
    close(bullet.vel.length(), 300, 1e-6);
    expect(target.id).not.toBe(owner.id);
  });

  test("dummy pilot aims at the other ship and returns a valid command", () => {
    const world = new World({ director: noDirector });
    const me = world.spawn(new Ship({ pos: new Vector2(100, 450), angle: 0 }));
    world.spawn(new Ship({ pos: new Vector2(400, 450) }));
    const cmd = dummyPilot(me, world);
    expect([-1, 0, 1]).toContain(cmd.turn);
    const alone = new World({ director: noDirector });
    expect(dummyPilot(alone.spawn(new Ship({ pos: new Vector2(1, 1) })), alone).turn).toBe(1);
  });

  test("explosion particles move, slow down and the explosion despawns itself", () => {
    const despawned: number[] = [];
    const ex = new Explosion({ pos: new Vector2(0, 0), rng: createRng(1), count: 4, ttl: 0.1 });
    const first = { ...ex.particles[0] };
    ex.update(0.05, { despawn: (id) => despawned.push(id) });
    expect(ex.particles[0]?.x).not.toBe(first.x);
    ex.update(0.06, { despawn: (id) => despawned.push(id) });
    expect(despawned).toEqual([ex.id]);
  });

  test("rng is deterministic and pick never returns undefined", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.int(0, 10), a.range(5, 6)]).toEqual([
      b.next(),
      b.int(0, 10),
      b.range(5, 6),
    ]);
    for (let i = 0; i < 100; i++) expect(["x", "y"]).toContain(a.pick(["x", "y"]));
    expect(a.state).toBe(a.state);
  });
});
