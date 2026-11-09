/**
 * Інтерполяція віддалених сутностей «у минулому» на interpDelay мс.
 */
import type { EntityState, Snapshot } from "@dogfight/shared/protocol.ts";
import type { Arena } from "@dogfight/shared/sim/arena.ts";
import { lerpAngle } from "@dogfight/shared/sim/physics.ts";

export interface BufferedSnapshot {
  readonly tick: number;
  readonly time: number;
  readonly byId: ReadonlyMap<number, EntityState>;
  readonly snap: Snapshot;
}

export interface Bracket {
  a: BufferedSnapshot;
  b: BufferedSnapshot;
  k: number;
  starved?: boolean;
}

export class SnapshotBuffer {
  readonly stepMs: number;
  readonly capacity: number;
  readonly items: BufferedSnapshot[] = [];
  offset: number | null = null;

  constructor({ stepMs, capacity = 64 }: { stepMs: number; capacity?: number }) {
    this.stepMs = stepMs;
    this.capacity = capacity;
  }

  push(snap: Snapshot, arrival: number): boolean {
    const time = snap.tick * this.stepMs;
    const last = this.items.at(-1);
    if (last && snap.tick <= last.tick) return false;
    const byId = new Map<number, EntityState>();
    for (const e of snap.entities) byId.set(e.id, e);
    this.items.push({ tick: snap.tick, time, byId, snap });
    if (this.items.length > this.capacity) this.items.shift();
    const sample = arrival - time;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    return true;
  }

  renderTime(now: number, delayMs: number): number {
    return this.offset === null ? 0 : now - this.offset - delayMs;
  }

  bracket(t: number): Bracket | null {
    const first = this.items[0];
    if (!first) return null;
    if (t <= first.time) return { a: first, b: first, k: 0 };
    for (let i = this.items.length - 1; i >= 0; i--) {
      const a = this.items[i];
      if (a && a.time <= t) {
        const b = this.items[i + 1];
        if (!b) return { a, b: a, k: 0, starved: true };
        return { a, b, k: (t - a.time) / (b.time - a.time) };
      }
    }
    return null;
  }
}

export function lerpWrapped(a: number, b: number, k: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  let v = a + d * k;
  if (v < 0) v += size;
  else if (v >= size) v -= size;
  return v;
}

export function interpolateEntities(
  { a, b, k }: Bracket,
  arena: Arena,
  skip: (e: EntityState) => boolean = () => false,
): EntityState[] {
  const out: EntityState[] = [];
  for (const [id, ea] of a.byId) {
    if (skip(ea)) continue;
    const eb = b.byId.get(id);
    if (!eb) {
      out.push(ea);
      continue;
    }
    out.push({
      ...eb,
      x: lerpWrapped(ea.x, eb.x, k, arena.width),
      y: lerpWrapped(ea.y, eb.y, k, arena.height),
      angle: lerpAngle(ea.angle, eb.angle, k),
    });
  }
  return out;
}
