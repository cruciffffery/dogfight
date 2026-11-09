import { createArena, wrapPos } from "./arena.js";
import { homingSystem, withHoming } from "./behaviors.js";
import { naiveCollisions } from "./collision.js";
import { Asteroid } from "./entities/asteroid.js";
import { Pickup } from "./entities/pickup.js";
import { createRng } from "./rng.js";
import { resolveCollision } from "./rules.js";
import { Vector2 } from "./vector.js";

/**
 * Світ — менеджер сутностей на основі Map.
 *
 * Чому Map, а не {}: ключі-числа без перетворення на рядки, гарантований порядок вставки
 * (детермінізм!), O(1) delete без «дірок», .size, і жодних конфліктів з Object.prototype.
 */
export class World {
  #entities = new Map();
  #despawnQueue = [];
  #events = [];

  constructor({
    arena = createArena(),
    seed = 1,
    collide = naiveCollisions,
    director = defaultDirector,
  } = {}) {
    this.arena = arena;
    this.rng = createRng(seed);
    this.collide = collide; // система колізій підставляється ззовні
    this.director = director;
    this.tick = 0;
    this.time = 0;
    this.scores = new Map();
  }

  spawn(entity) {
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /**
   * Відкладене видалення: сутність лише позначається мертвою, а з Map прибирається
   * в кінці кроку. Видаляти з колекції під час її обходу — класичний джерело багів.
   */
  despawn(id) {
    const e = this.#entities.get(id);
    if (e?.alive) {
      e.alive = false;
      this.#despawnQueue.push(id);
    }
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  [Symbol.iterator]() {
    return this.#entities.values();
  }

  /** Генератор: ліниво віддає сутності певного типу, без проміжного масиву. */
  *ofKind(kind) {
    for (const e of this.#entities.values()) {
      if (e.kind === kind && e.alive) yield e;
    }
  }

  addScore(ownerId, points) {
    if (ownerId == null) return;
    this.scores.set(ownerId, (this.scores.get(ownerId) ?? 0) + points);
  }

  /** Подія симуляції. У Лабі 3 цю чергу слухатиме EventTarget-шина. */
  emit(type, detail) {
    this.#events.push({ type, detail, tick: this.tick });
  }

  /** Забрати події, що накопичились (і очистити чергу). */
  drainEvents() {
    return this.#events.splice(0, this.#events.length);
  }

  /** Випадкова точка, далека від усіх колізійних сутностей. */
  findSafeSpot(clearance = 120) {
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

  /**
   * Один крок симуляції.
   * @param {number} dt
   * @param {Map<number, object>} inputs — команда для кожного корабля за id
   */
  step(dt, inputs = new Map()) {
    this.tick += 1;
    this.time += dt;

    // Знімок списку: сутності, створені під час кроку, почнуть рухатись з наступного
    const current = [...this.#entities.values()];
    for (const e of current) e.savePrev();
    for (const [id, cmd] of inputs) {
      const ship = this.#entities.get(id);
      if (ship) ship.command = cmd;
    }
    for (const e of current) {
      if (!e.alive) continue;
      e.update(dt, this);
      e.pos = wrapPos(e.pos, this.arena);
    }

    homingSystem(this, dt);

    for (const [a, b] of this.collide(this)) resolveCollision(a, b, this);

    this.director(this, dt);
    this.#sweep();
  }

  #sweep() {
    for (const id of this.#despawnQueue) this.#entities.delete(id);
    this.#despawnQueue.length = 0;
  }
}

/**
 * «Режисер» арени: підтримує кількість астероїдів і підкидає підсилювачі.
 * Окрема функція, щоб тести могли запускати світ без випадкових спавнів.
 */
export function defaultDirector(world, _dt) {
  const asteroids = [...world.ofKind("asteroid")].length;
  if (asteroids < 5) spawnAsteroid(world);

  const pickups = [...world.ofKind("pickup")].length;
  if (pickups < 2 && world.tick % (60 * 6) === 0) {
    world.spawn(
      new Pickup({
        pos: world.findSafeSpot(80),
        type: world.rng.pick(["shield", "rapid", "homing"]),
      }),
    );
  }
}

export function spawnAsteroid(world, { hunter = world.rng.next() < 0.2 } = {}) {
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
  // Кожен п'ятий астероїд — «мисливець»: той самий компонент наведення, що й у куль
  if (hunter) withHoming(asteroid, { targetKind: "ship", turnRate: 0.6, range: 500 });
  return world.spawn(asteroid);
}
