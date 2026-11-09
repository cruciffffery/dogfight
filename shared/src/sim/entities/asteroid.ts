import { Entity } from "../entity.ts";
import type { Vector2 } from "../vector.ts";
import type { World } from "../world.ts";

export interface AsteroidInit {
  pos: Vector2;
  vel: Vector2;
  radius: number;
  spin?: number;
  shapeSeed?: number;
}

export class Asteroid extends Entity {
  readonly kind: "asteroid" = "asteroid";
  spin: number;
  readonly shapeSeed: number;
  hp: number;
  readonly mass: number;

  constructor({ pos, vel, radius, spin = 0, shapeSeed = 1 }: AsteroidInit) {
    super({ pos, vel, radius });
    this.spin = spin;
    this.shapeSeed = shapeSeed;
    this.hp = Math.round(radius * 1.5);
    this.mass = radius * radius;
  }

  override update(dt: number, world: World): void {
    super.update(dt, world);
    this.angle += this.spin * dt;
  }
}
