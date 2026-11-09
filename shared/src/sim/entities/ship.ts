import { IDLE_COMMAND, type PlayerId, type SeqCommand } from "../../types.ts";
import { withHoming } from "../behaviors.ts";
import { Entity } from "../entity.ts";
import { integrate, SHIP } from "../physics.ts";
import { Vector2 } from "../vector.ts";
import type { World } from "../world.ts";
import { Bullet } from "./bullet.ts";
import type { Effects } from "./pickup.ts";

export const SHIP_RULES = Object.freeze({
  maxHp: 100,
  fireCooldown: 0.22,
  rapidFireCooldown: 0.08,
  bulletSpeed: 760,
  respawnDelay: 2,
});

export const SKINS: readonly ["blue", "red", "green", "gold"] = ["blue", "red", "green", "gold"];
export type Skin = (typeof SKINS)[number];

/** «Пілот» без людини: (корабель, світ) → команда. */
export type Pilot = (ship: Ship, world: World, dt: number) => SeqCommand;

export interface ShipInit {
  pos: Vector2;
  angle?: number;
  name?: string;
  skin?: Skin;
  color?: string;
  ai?: Pilot | null;
}

export class Ship extends Entity {
  readonly kind: "ship" = "ship";
  #hp: number = SHIP_RULES.maxHp;
  name: string;
  skin: Skin;
  color: string;
  thrust = false;
  command: SeqCommand = IDLE_COMMAND;
  cooldown = 0;
  destroyed = false;
  respawnIn = 0;
  effects: Effects = { shield: 0, rapid: 0, homing: 0 };
  ai: Pilot | null;
  playerId: PlayerId | null = null;

  constructor({
    pos,
    angle = -Math.PI / 2,
    name = "pilot",
    skin = "blue",
    color = "#7fa2ff",
    ai = null,
  }: ShipInit) {
    super({ pos, angle, radius: SHIP.radius });
    this.name = name;
    this.skin = skin;
    this.color = color;
    this.ai = ai;
  }

  get hp(): number {
    return this.#hp;
  }

  /** @returns true, якщо цей удар знищив корабель */
  damage(amount: number): boolean {
    if (this.destroyed || this.effects.shield > 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.destroyed = true;
      this.collidable = false;
      this.respawnIn = SHIP_RULES.respawnDelay;
      return true;
    }
    return false;
  }

  respawn(pos: Vector2): void {
    this.#hp = SHIP_RULES.maxHp;
    this.destroyed = false;
    this.collidable = true;
    this.pos = pos;
    this.prevPos = pos;
    this.vel = Vector2.ZERO;
    this.effects = { shield: 1.5, rapid: 0, homing: 0 };
  }

  fire(world: World): Bullet | null {
    if (this.destroyed || this.cooldown > 0) return null;
    this.cooldown = this.effects.rapid > 0 ? SHIP_RULES.rapidFireCooldown : SHIP_RULES.fireCooldown;
    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(SHIP.radius + 6)),
      vel: this.vel.add(dir.scale(SHIP_RULES.bulletSpeed)),
      ownerId: this.id,
    });
    bullet.seq = this.command.seq;
    if (this.effects.homing > 0) {
      withHoming(bullet, { targetKind: "ship", turnRate: 4.5, range: 420, ignoreId: this.id });
    }
    world.spawn(bullet);
    world.emit("fired", { ownerId: this.id, bulletId: bullet.id, pos: bullet.pos });
    return bullet;
  }

  override update(dt: number, world: World): void {
    if (this.destroyed) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) this.respawn(world.findSafeSpot(120));
      return;
    }
    const cmd = this.ai ? this.ai(this, world, dt) : this.command;
    const next = integrate(this, cmd, dt);
    this.pos = next.pos;
    this.vel = next.vel;
    this.angle = next.angle;
    this.thrust = next.thrust;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.effects.shield = Math.max(0, this.effects.shield - dt);
    this.effects.rapid = Math.max(0, this.effects.rapid - dt);
    this.effects.homing = Math.max(0, this.effects.homing - dt);
    if (cmd.fire) this.fire(world);
  }
}
