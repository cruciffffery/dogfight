import { Entity } from "../entity.js";

export class Asteroid extends Entity {
  constructor({ pos, vel, radius, spin = 0, shapeSeed = 1 }) {
    super({ kind: "asteroid", pos, vel, radius });
    this.spin = spin;
    this.shapeSeed = shapeSeed; // форма для рендеру — детермінована
    this.hp = Math.round(radius * 1.5);
    this.mass = radius * radius;
  }

  update(dt, world) {
    super.update(dt, world);
    this.angle += this.spin * dt;
  }
}
