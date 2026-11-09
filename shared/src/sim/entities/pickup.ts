import { Entity } from "../entity.ts";
import type { Vector2 } from "../vector.ts";
import type { World } from "../world.ts";

export const PICKUP_TYPES: readonly ["shield", "rapid", "homing"] = ["shield", "rapid", "homing"];
export type PickupType = (typeof PICKUP_TYPES)[number];

/** Тривалість ефектів, с. */
export const PICKUP_EFFECTS: Readonly<Record<PickupType, number>> = Object.freeze({
  shield: 6,
  rapid: 8,
  homing: 8,
});

export type Effects = Record<PickupType, number>;

/** Будь-що з компонентом «ефекти» (структурна типізація: клас не важливий). */
export interface HasEffects {
  effects: Effects;
}

export function isPickupType(x: unknown): x is PickupType {
  return PICKUP_TYPES.some((t) => t === x);
}

/** Підсилювач: нерухомий, з колізією, але НЕ корабель. */
export class Pickup extends Entity {
  readonly kind: "pickup" = "pickup";
  readonly type: PickupType;
  ttl: number;
  age = 0;

  constructor({ pos, type, ttl = 15 }: { pos: Vector2; type: PickupType; ttl?: number }) {
    super({ pos, radius: 12 });
    this.type = type;
    this.ttl = ttl;
  }

  override update(dt: number, world: World): void {
    this.age += dt;
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }

  applyTo(target: Partial<HasEffects>): boolean {
    if (!target.effects) return false;
    target.effects[this.type] = PICKUP_EFFECTS[this.type];
    return true;
  }
}
