import { Entity } from "../entity.js";

/** Тривалість ефектів, с. Ефект — це дані, які отримує будь-хто з компонентом `effects`. */
export const PICKUP_EFFECTS = Object.freeze({
  shield: 6,
  rapid: 8,
  homing: 8,
});

/**
 * Підсилювач: нерухомий, з колізією, але НЕ корабель.
 * Він не знає, як працює щит чи швидкострільність — лише кладе тривалість у `effects` того,
 * хто його підібрав (див. rules.js). Саму поведінку читають Ship.damage() і Ship.fire().
 */
export class Pickup extends Entity {
  constructor({ pos, type, ttl = 15 }) {
    super({ kind: "pickup", pos, radius: 12 });
    if (!(type in PICKUP_EFFECTS)) throw new RangeError(`Unknown pickup: ${type}`);
    this.type = type;
    this.ttl = ttl;
    this.age = 0;
  }

  update(dt, world) {
    this.age += dt;
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }

  /** Застосувати до будь-якої сутності, що має компонент `effects`. */
  applyTo(target) {
    if (!target.effects) return false;
    target.effects[this.type] = PICKUP_EFFECTS[this.type];
    return true;
  }
}
