/**
 * Незмінний 2D-вектор. Усі методи повертають НОВИЙ вектор: `a.add(b)` ніколи не змінює `a`.
 * Це робить код фізики передбачуваним (немає «прихованого» спільного стану між сутностями).
 * Ціна — алокації в гарячому циклі; міряти й оптимізувати будемо в Лабі 7.
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static ZERO = new Vector2(0, 0);

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  normalize() {
    const len = this.length();
    return len === 0 ? Vector2.ZERO : new Vector2(this.x / len, this.y / len);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  angle() {
    return Math.atan2(this.y, this.x);
  }

  clampLength(max) {
    const len = this.length();
    return len > max ? this.scale(max / len) : this;
  }

  toString() {
    return `Vector2(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
  }
}
