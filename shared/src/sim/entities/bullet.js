import { Entity } from "../entity.js";

export class Bullet extends Entity {
  constructor({ pos, vel, ownerId, ttl = 1.1, damage = 20 }) {
    super({ kind: "bullet", pos, vel, angle: vel.angle(), radius: 3 });
    this.ownerId = ownerId;
    this.ttl = ttl; // time-to-live, с
    this.damage = damage;
  }

  update(dt, world) {
    super.update(dt, world); // рух — з базового класу
    this.angle = this.vel.angle();
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
