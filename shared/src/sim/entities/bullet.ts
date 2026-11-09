import type { EntityId } from "../../types.ts";
import { Entity } from "../entity.ts";
import type { Vector2 } from "../vector.ts";
import type { World } from "../world.ts";

export interface BulletInit {
  pos: Vector2;
  vel: Vector2;
  ownerId: EntityId;
  ttl?: number;
  damage?: number;
}

export class Bullet extends Entity {
  readonly kind: "bullet" = "bullet";
  readonly ownerId: EntityId;
  ttl: number;
  readonly damage: number;
  /** Номер вводу, що породив кулю (клієнт зіставляє передбачену кулю з серверною). */
  seq = 0;

  constructor({ pos, vel, ownerId, ttl = 1.1, damage = 20 }: BulletInit) {
    super({ pos, vel, angle: vel.angle(), radius: 3 });
    this.ownerId = ownerId;
    this.ttl = ttl;
    this.damage = damage;
  }

  override update(dt: number, world: World): void {
    super.update(dt, world);
    this.angle = this.vel.angle();
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
