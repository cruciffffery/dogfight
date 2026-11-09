/**
 * Правила взаємодії як дані: пара типів (в алфавітному порядку) → обробник.
 * Тип PairHandlers гарантує, що обробник отримує сутності саме тих класів, що в ключі.
 */
import { torusDelta } from "./arena.ts";
import { Asteroid } from "./entities/asteroid.ts";
import type { Bullet } from "./entities/bullet.ts";
import { Explosion } from "./entities/explosion.ts";
import type { Pickup } from "./entities/pickup.ts";
import type { Ship } from "./entities/ship.ts";
import type { Entity } from "./entity.ts";
import type { Vector2 } from "./vector.ts";
import type { GameEntity, World } from "./world.ts";

export const SCORE = Object.freeze({ ship: 100, asteroid: 25 });

interface Massive extends Entity {
  mass?: number;
}

function bounce(a: Massive, b: Massive, world: World, restitution = 0.9): number {
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
  if (rel >= 0) return 0;
  const j = (-(1 + restitution) * rel) / (1 / ma + 1 / mb);
  a.vel = a.vel.sub(n.scale(j / ma));
  b.vel = b.vel.add(n.scale(j / mb));
  return -rel;
}

function explode(world: World, pos: Vector2, color: string): void {
  world.spawn(new Explosion({ pos, rng: world.rng, color }));
}

interface PairHandlers {
  "bullet:ship"(bullet: Bullet, ship: Ship, world: World): void;
  "asteroid:bullet"(asteroid: Asteroid, bullet: Bullet, world: World): void;
  "asteroid:asteroid"(a: Asteroid, b: Asteroid, world: World): void;
  "asteroid:ship"(asteroid: Asteroid, ship: Ship, world: World): void;
  "ship:ship"(a: Ship, b: Ship, world: World): void;
  "pickup:ship"(pickup: Pickup, ship: Ship, world: World): void;
}

const handlers: PairHandlers = {
  "bullet:ship"(bullet, ship, world) {
    if (bullet.ownerId === ship.id) return;
    world.despawn(bullet.id);
    const killed = ship.damage(bullet.damage);
    world.emit("hit", { targetId: ship.id, byId: bullet.ownerId, pos: bullet.pos });
    if (killed) {
      explode(world, ship.pos, ship.color);
      world.addScore(bullet.ownerId, SCORE.ship, ship.pos);
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
    world.addScore(bullet.ownerId, SCORE.asteroid, asteroid.pos);
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

/**
 * Диспетчеризація за парою типів. Звуження через `kind` — замість приведень типів:
 * усередині кожної гілки TypeScript уже знає точні класи обох сутностей.
 */
export function resolveCollision(a: GameEntity, b: GameEntity, world: World): void {
  if (!a.alive || !b.alive) return;
  const [x, y] = a.kind <= b.kind ? [a, b] : [b, a];
  if (x.kind === "bullet" && y.kind === "ship") handlers["bullet:ship"](x, y, world);
  else if (x.kind === "asteroid" && y.kind === "bullet") handlers["asteroid:bullet"](x, y, world);
  else if (x.kind === "asteroid" && y.kind === "asteroid")
    handlers["asteroid:asteroid"](x, y, world);
  else if (x.kind === "asteroid" && y.kind === "ship") handlers["asteroid:ship"](x, y, world);
  else if (x.kind === "ship" && y.kind === "ship") handlers["ship:ship"](x, y, world);
  else if (x.kind === "pickup" && y.kind === "ship") handlers["pickup:ship"](x, y, world);
  // інші пари (куля–куля, підсилювач–астероїд…) навмисно не взаємодіють
}
