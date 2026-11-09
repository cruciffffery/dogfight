import { withHoming } from "../behaviors.js";
import { Entity } from "../entity.js";
import { integrate, SHIP } from "../physics.js";
import { Vector2 } from "../vector.js";
import { Bullet } from "./bullet.js";

const NO_INPUT = Object.freeze({ turn: 0, thrust: false, brake: false, fire: false });

export const SHIP_RULES = Object.freeze({
  maxHp: 100,
  fireCooldown: 0.22, // с між пострілами
  rapidFireCooldown: 0.08,
  bulletSpeed: 760,
  respawnDelay: 2,
});

export class Ship extends Entity {
  // Здоров'я приватне: змінити його можна тільки через damage()/heal(),
  // тож ніхто не напише ship.hp = 9999 з консолі чи іншого модуля
  #hp = SHIP_RULES.maxHp;

  constructor({ pos, angle = -Math.PI / 2, name = "pilot", color = "#e8edf7", ai = null }) {
    super({ kind: "ship", pos, angle, radius: SHIP.radius });
    this.name = name;
    this.color = color;
    this.thrust = false;
    this.command = NO_INPUT;
    this.cooldown = 0;
    this.destroyed = false;
    this.respawnIn = 0;
    // компонент «активні ефекти» — заповнюється підсилювачами (Pickup)
    this.effects = { shield: 0, rapid: 0, homing: 0 };
    this.ai = ai; // для тренувального манекена (не людина)
  }

  get hp() {
    return this.#hp;
  }

  /** @returns {boolean} true, якщо цей удар знищив корабель */
  damage(amount) {
    if (this.destroyed) return false;
    if (this.effects.shield > 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.destroyed = true;
      this.collidable = false;
      this.respawnIn = SHIP_RULES.respawnDelay;
      return true;
    }
    return false;
  }

  respawn(pos) {
    this.#hp = SHIP_RULES.maxHp;
    this.destroyed = false;
    this.collidable = true;
    this.pos = pos;
    this.prevPos = pos;
    this.vel = Vector2.ZERO;
    this.effects = { shield: 1.5, rapid: 0, homing: 0 }; // короткий захист після респавну
  }

  /** Постріл з носа корабля з успадкованою швидкістю. */
  fire(world) {
    if (this.destroyed || this.cooldown > 0) return null;
    this.cooldown = this.effects.rapid > 0 ? SHIP_RULES.rapidFireCooldown : SHIP_RULES.fireCooldown;
    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(SHIP.radius + 6)),
      vel: this.vel.add(dir.scale(SHIP_RULES.bulletSpeed)),
      ownerId: this.id,
    });
    if (this.effects.homing > 0) {
      withHoming(bullet, { targetKind: "ship", turnRate: 4.5, range: 420, ignoreId: this.id });
    }
    world.spawn(bullet);
    return bullet;
  }

  update(dt, world) {
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
    for (const key of Object.keys(this.effects)) {
      this.effects[key] = Math.max(0, this.effects[key] - dt);
    }
    if (cmd.fire) this.fire(world);
  }
}
