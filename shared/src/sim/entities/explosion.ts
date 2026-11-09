import { Entity } from "../entity.ts";
import type { Rng } from "../rng.ts";
import type { Vector2 } from "../vector.ts";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Мінімум від світу, потрібний вибуху (клієнт підставляє свій список ефектів). */
export interface Despawner {
  despawn(id: Explosion["id"]): void;
}

export class Explosion extends Entity {
  readonly kind: "explosion" = "explosion";
  ttl: number;
  readonly maxTtl: number;
  readonly color: string;
  readonly particles: Particle[] = [];

  constructor({
    pos,
    rng,
    count = 28,
    speed = 220,
    ttl = 0.9,
    color = "#ffb020",
  }: { pos: Vector2; rng: Rng; count?: number; speed?: number; ttl?: number; color?: string }) {
    super({ pos, radius: 0 });
    this.ttl = ttl;
    this.maxTtl = ttl;
    this.color = color;
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const s = rng.range(0.25, 1) * speed;
      this.particles.push({ x: pos.x, y: pos.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
    }
  }

  override update(dt: number, world: Despawner): void {
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
