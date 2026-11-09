/**
 * Незмінний 2D-вектор. Усі методи повертають НОВИЙ вектор: `a.add(b)` ніколи не змінює `a`.
 * readonly x/y — компілятор забороняє `v.x = 5`; Object.freeze — те саме в рантаймі.
 */
export interface Vec {
  readonly x: number;
  readonly y: number;
}

export class Vector2 implements Vec {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static readonly ZERO = new Vector2(0, 0);

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static from(v: Vec): Vector2 {
    return v instanceof Vector2 ? v : new Vector2(v.x, v.y);
  }

  add(v: Vec): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vec): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle: number): Vector2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  dot(v: Vec): number {
    return this.x * v.x + this.y * v.y;
  }

  angle(): number {
    return Math.atan2(this.y, this.x);
  }

  clampLength(max: number): Vector2 {
    const len = this.length();
    return len > max ? this.scale(max / len) : this;
  }

  toString(): string {
    return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }
}
