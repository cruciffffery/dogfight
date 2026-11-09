import { Bus } from "../bus.ts";
import type { EntityId, SeqCommand } from "../types.ts";
import { type Arena, createArena, wrapPos } from "./arena.ts";
import { homingSystem, withHoming } from "./behaviors.ts";
import { type CollisionSystem, naiveCollisions } from "./collision.ts";
import { Asteroid } from "./entities/asteroid.ts";
import type { Bullet } from "./entities/bullet.ts";
import type { Explosion } from "./entities/explosion.ts";
import { Pickup, type PickupType } from "./entities/pickup.ts";
import type { Ship } from "./entities/ship.ts";
import type { EntityKind } from "./entity.ts";
import { createRng, type Rng } from "./rng.ts";
import { resolveCollision } from "./rules.ts";
import { Vector2 } from "./vector.ts";

/** Дискриміноване об'єднання всіх сутностей: `switch (e.kind)` звужує до класу. */
export type GameEntity = Ship | Bullet | Asteroid | Pickup | Explosion;
export type EntityOfKind<K extends EntityKind> = Extract<GameEntity, { kind: K }>;

/** Події симуляції та їхні payload — один тип на всю програму (аудіо, HUD, мережа). */
export interface WorldEvents {
  fired: { ownerId: EntityId; bulletId: EntityId; pos: Vector2 };
  hit: { targetId: EntityId; byId: EntityId | null; pos: Vector2 };
  exploded: { id: EntityId; kind: "ship" | "asteroid"; byId: EntityId | null; pos: Vector2 };
  picked: { id: EntityId; type: PickupType; pos: Vector2 };
  scored: { id: EntityId; points: number; total: number; pos: Vector2 };
}
export type WorldEventName = keyof WorldEvents;
export type WorldEvent = {
  [K in WorldEventName]: { type: K; detail: WorldEvents[K]; tick: number };
}[WorldEventName];

export interface WorldRules {
  asteroids: number;
  pickupEvery: number;
}

export type Director = (world: World, dt: number) => void;

export interface WorldOptions {
  arena?: Arena;
  seed?: number;
  collide?: CollisionSystem;
  director?: Director;
  rules?: Partial<WorldRules>;
}

function isKind<K extends EntityKind>(e: GameEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind;
}

export class World extends Bus<WorldEvents> {
  readonly #entities = new Map<EntityId, GameEntity>();
  readonly #despawnQueue: EntityId[] = [];
  readonly #events: WorldEvent[] = [];
  readonly arena: Arena;
  readonly rng: Rng;
  readonly rules: WorldRules;
  collide: CollisionSystem;
  director: Director;
  tick = 0;
  time = 0;
  readonly scores = new Map<EntityId, number>();

  constructor({
    arena = createArena(),
    seed = 1,
    collide = naiveCollisions,
    director = defaultDirector,
    rules = {},
  }: WorldOptions = {}) {
    super();
    this.arena = arena;
    this.rng = createRng(seed);
    this.rules = { asteroids: 5, pickupEvery: 6, ...rules };
    this.collide = collide;
    this.director = director;
  }

  spawn<E extends GameEntity>(entity: E): E {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Відкладене видалення: лише позначка; прибирання — у кінці кроку. */
  despawn(id: EntityId): void {
    const e = this.#entities.get(id);
    if (e?.alive) {
      e.alive = false;
      this.#despawnQueue.push(id);
    }
  }

  get(id: EntityId): GameEntity | undefined {
    return this.#entities.get(id);
  }

  get size(): number {
    return this.#entities.size;
  }

  [Symbol.iterator](): IterableIterator<GameEntity> {
    return this.#entities.values();
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityOfKind<K>> {
    for (const e of this.#entities.values()) {
      if (e.alive && isKind(e, kind)) yield e;
    }
  }

  addScore(ownerId: EntityId | null, points: number, pos: Vector2 = Vector2.ZERO): void {
    if (ownerId === null) return;
    const total = (this.scores.get(ownerId) ?? 0) + points;
    this.scores.set(ownerId, total);
    this.emit("scored", { id: ownerId, points, total, pos });
  }

  /** Подія: синхронно слухачам (аудіо, HUD) і в чергу для мережевого шару. */
  override emit<K extends WorldEventName>(type: K, detail: WorldEvents[K]): void {
    // Зберігаємо як об'єднання: TypeScript не може довести зв'язок K ↔ detail для
    // загального K, тому кладемо через допоміжну функцію з тим самим generic.
    this.#events.push(makeEvent(type, detail, this.tick));
    super.emit(type, detail);
  }

  drainEvents(): WorldEvent[] {
    return this.#events.splice(0, this.#events.length);
  }

  findSafeSpot(clearance = 120): Vector2 {
    let best = new Vector2(this.arena.width / 2, this.arena.height / 2);
    let bestScore = -1;
    for (let attempt = 0; attempt < 30; attempt++) {
      const p = new Vector2(
        this.rng.range(40, this.arena.width - 40),
        this.rng.range(40, this.arena.height - 40),
      );
      let nearest = Number.POSITIVE_INFINITY;
      for (const e of this.#entities.values()) {
        if (!e.alive || !e.collidable) continue;
        nearest = Math.min(nearest, p.sub(e.pos).length() - e.radius);
      }
      if (nearest >= clearance) return p;
      if (nearest > bestScore) {
        bestScore = nearest;
        best = p;
      }
    }
    return best;
  }

  /** Один крок симуляції. inputs — команда для кожного корабля за його id. */
  step(dt: number, inputs: ReadonlyMap<EntityId, SeqCommand> = new Map()): void {
    this.tick += 1;
    this.time += dt;

    const current = [...this.#entities.values()];
    for (const e of current) e.savePrev();
    for (const [id, cmd] of inputs) {
      const ship = this.#entities.get(id);
      if (ship?.kind === "ship") ship.command = cmd;
    }
    for (const e of current) {
      if (!e.alive) continue;
      e.update(dt, this);
      e.pos = wrapPos(e.pos, this.arena);
    }

    homingSystem(this, dt);
    for (const [a, b] of this.collide(this)) resolveCollision(a, b, this);
    this.director(this, dt);

    for (const id of this.#despawnQueue) this.#entities.delete(id);
    this.#despawnQueue.length = 0;
  }
}

function makeEvent<K extends WorldEventName>(
  type: K,
  detail: WorldEvents[K],
  tick: number,
): WorldEvent {
  // Відомий обхід: для узагальненого K компілятор не «розподіляє» mapped type.
  // Тут тип справді коректний (type і detail з одного K), тому одне приведення.
  return { type, detail, tick } as WorldEvent; // cast #2
}

export function defaultDirector(world: World, dt: number): void {
  let asteroids = 0;
  for (const _ of world.ofKind("asteroid")) asteroids++;
  if (asteroids < world.rules.asteroids) spawnAsteroid(world);

  let pickups = 0;
  for (const _ of world.ofKind("pickup")) pickups++;
  // БУЛО: world.tick % (60 * pickupEvery) — тіки рахувались як 60 Гц, а сервер іде на 30 Гц,
  // тож підсилювачі з'являлись удвічі рідше. Знайшлось, коли тип Director змусив згадати про dt.
  if (pickups < 2 && world.tick % Math.max(1, Math.round(world.rules.pickupEvery / dt)) === 0) {
    world.spawn(
      new Pickup({
        pos: world.findSafeSpot(80),
        type: world.rng.pick(["shield", "rapid", "homing"]),
      }),
    );
  }
}

export function spawnAsteroid(
  world: World,
  { hunter = world.rng.next() < 0.2 }: { hunter?: boolean } = {},
): Asteroid {
  const edge = world.rng.int(0, 4);
  const { width, height } = world.arena;
  const pos =
    edge === 0
      ? new Vector2(0, world.rng.range(0, height))
      : edge === 1
        ? new Vector2(width, world.rng.range(0, height))
        : edge === 2
          ? new Vector2(world.rng.range(0, width), 0)
          : new Vector2(world.rng.range(0, width), height);
  const asteroid = new Asteroid({
    pos,
    vel: Vector2.fromAngle(world.rng.range(0, Math.PI * 2), world.rng.range(30, 90)),
    radius: world.rng.range(22, 46),
    spin: world.rng.range(-1, 1),
    shapeSeed: world.rng.int(1, 1e6),
  });
  if (hunter) withHoming(asteroid, { targetKind: "ship", turnRate: 0.6, range: 500 });
  return world.spawn(asteroid);
}
