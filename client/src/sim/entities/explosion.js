import { Entity } from "../entity.js";

/**
 * Вибух — короткоживуча сутність з набором частинок.
 * Частинки — звичайні об'єкти, які створюються й викидаються десятками: саме вони
 * стануть головним джерелом сміття для GC у Лабі 7 (пул об'єктів).
 */
export class Explosion extends Entity {
  constructor({ pos, rng, count = 28, speed = 220, ttl = 0.9, color = "#ffb020" }) {
    super({ kind: "explosion", pos, radius: 0 });
    this.ttl = ttl;
    this.maxTtl = ttl;
    this.color = color;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const s = rng.range(0.25, 1) * speed;
      this.particles.push({ x: pos.x, y: pos.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
    }
  }

  update(dt, world) {
    const drag = Math.exp(-2.5 * dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
    }
    this.ttl -= dt;
    if (this.ttl <= 0) world.despawn(this.id);
  }
}
