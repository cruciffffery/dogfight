/**
 * Правила взаємодії як ДАНІ: таблиця «пара типів → обробник».
 * Додати новий тип сутності = додати рядки в таблицю, а не if-и по всьому коду.
 */
import { torusDelta } from "./arena.js";
import { Asteroid } from "./entities/asteroid.js";
import { Explosion } from "./entities/explosion.js";

export const SCORE = Object.freeze({ ship: 100, asteroid: 25 });

/** Пружне відштовхування двох кіл (зберігає імпульс, restitution < 1). */
function bounce(a, b, world, restitution = 0.9) {
  const delta = torusDelta(a.pos, b.pos, world.arena);
  const dist = delta.length() || 0.0001;
  const n = delta.scale(1 / dist);
  const ma = a.mass ?? a.radius * a.radius;
  const mb = b.mass ?? b.radius * b.radius;
  const overlap = a.radius + b.radius - dist;
  if (overlap > 0) {
    a.pos = a.pos.sub(n.scale((overlap * mb) / (ma + mb)));
    b.pos = b.pos.add(n.scale((overlap * ma) / (ma + mb)));
  }
  const rel = b.vel.sub(a.vel).dot(n);
  if (rel >= 0) return 0; // вже розлітаються
  const j = (-(1 + restitution) * rel) / (1 / ma + 1 / mb);
  a.vel = a.vel.sub(n.scale(j / ma));
  b.vel = b.vel.add(n.scale(j / mb));
  return -rel;
}

function explode(world, pos, color) {
  world.spawn(new Explosion({ pos, rng: world.rng, color }));
}

const handlers = {
  "bullet:ship"(bullet, ship, world) {
    if (bullet.ownerId === ship.id) return;
    world.despawn(bullet.id);
    const killed = ship.damage(bullet.damage);
    world.emit("hit", { targetId: ship.id, byId: bullet.ownerId, pos: bullet.pos });
    if (killed) {
      explode(world, ship.pos, ship.color);
      world.addScore(bullet.ownerId, SCORE.ship);
      world.emit("exploded", { id: ship.id, kind: "ship", byId: bullet.ownerId, pos: ship.pos });
    }
  },

  "asteroid:bullet"(asteroid, bullet, world) {
    world.despawn(bullet.id);
    asteroid.hp -= bullet.damage;
    world.emit("hit", { targetId: asteroid.id, byId: bullet.ownerId, pos: bullet.pos });
    if (asteroid.hp > 0) return;
    world.despawn(asteroid.id);
    explode(world, asteroid.pos, "#b9a68a");
    world.addScore(bullet.ownerId, SCORE.asteroid);
    world.emit("exploded", {
      id: asteroid.id,
      kind: "asteroid",
      byId: bullet.ownerId,
      pos: asteroid.pos,
    });
    if (asteroid.radius > 24) {
      for (const side of [-1, 1]) {
        const dir = bullet.vel.normalize().rotate((side * Math.PI) / 2);
        world.spawn(
          new Asteroid({
            pos: asteroid.pos.add(dir.scale(asteroid.radius / 2)),
            vel: asteroid.vel.add(dir.scale(world.rng.range(40, 90))),
            radius: asteroid.radius * 0.6,
            spin: world.rng.range(-1.5, 1.5),
            shapeSeed: world.rng.int(1, 1e6),
          }),
        );
      }
    }
  },

  "asteroid:asteroid"(a, b, world) {
    bounce(a, b, world);
  },

  "asteroid:ship"(asteroid, ship, world) {
    const impact = bounce(asteroid, ship, world, 0.6);
    if (impact > 0) {
      const killed = ship.damage(Math.min(40, Math.max(5, impact / 12)));
      world.emit("hit", { targetId: ship.id, byId: null, pos: ship.pos });
      if (killed) {
        explode(world, ship.pos, ship.color);
        world.emit("exploded", { id: ship.id, kind: "ship", byId: null, pos: ship.pos });
      }
    }
  },

  "ship:ship"(a, b, world) {
    bounce(a, b, world, 0.5);
  },

  "pickup:ship"(pickup, ship, world) {
    if (pickup.applyTo(ship)) {
      world.despawn(pickup.id);
      world.emit("picked", { id: ship.id, type: pickup.type, pos: pickup.pos });
    }
  },
};

/** Знаходить обробник для пари в алфавітному порядку типів. */
export function resolveCollision(a, b, world) {
  if (!a.alive || !b.alive) return; // одна зі сторін уже знищена в цьому кроці
  const [x, y] = a.kind <= b.kind ? [a, b] : [b, a];
  const handler = handlers[`${x.kind}:${y.kind}`];
  if (handler) handler(x, y, world);
}
