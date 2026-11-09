/**
 * Інтерполяція віддалених сутностей: показуємо світ «у минулому» на interpDelay мс,
 * між двома знімками, які вже прийшли. Тоді рух чужих кораблів плавний, хоча знімки
 * приходять 30 разів/с з джитером.
 */
import { lerpAngle } from "@dogfight/shared/sim/physics.js";

export class SnapshotBuffer {
  constructor({ stepMs, capacity = 64 }) {
    this.stepMs = stepMs;
    this.capacity = capacity;
    this.items = []; // { tick, time, byId: Map, snap }
    this.offset = null; // локальний час − серверний час (мс), згладжений
  }

  /** Додати знімок і оновити оцінку годинника сервера. */
  push(snap, arrival) {
    const time = snap.tick * this.stepMs;
    const last = this.items.at(-1);
    if (last && snap.tick <= last.tick) return false; // застарілий / дублікат
    const byId = new Map();
    for (const e of snap.entities) byId.set(e.id, e);
    this.items.push({ tick: snap.tick, time, byId, snap });
    if (this.items.length > this.capacity) this.items.shift();

    // Оцінка зсуву годинників: швидко вниз (знімок прийшов «рано» — це і є найкраща оцінка),
    // повільно вгору (знімок затримався — можливо, це лише джитер)
    const sample = arrival - time;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    return true;
  }

  /** Серверний час, який зараз «показуємо». */
  renderTime(now, delayMs) {
    return this.offset === null ? 0 : now - this.offset - delayMs;
  }

  /**
   * Пара знімків навколо t і коефіцієнт між ними.
   * Якщо t новіший за останній знімок — повертаємо останній (без екстраполяції).
   */
  bracket(t) {
    const items = this.items;
    if (items.length === 0) return null;
    if (t <= items[0].time) return { a: items[0], b: items[0], k: 0 };
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].time <= t) {
        const a = items[i];
        const b = items[i + 1];
        if (!b) return { a, b: a, k: 0, starved: true };
        return { a, b, k: (t - a.time) / (b.time - a.time) };
      }
    }
    return null;
  }
}

/** Позиція з урахуванням тора: між x=1595 і x=5 — коротким шляхом через край. */
export function lerpWrapped(a, b, k, size) {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  let v = a + d * k;
  if (v < 0) v += size;
  else if (v >= size) v -= size;
  return v;
}

/**
 * Стани сутностей на момент між a і b.
 *   є в обох  → інтерполяція;
 *   лише в a  → сутність зникає: показуємо в останній відомій позиції до кінця інтервалу;
 *   лише в b  → з'являється: не показуємо, доки час не дійде до знімка b.
 */
export function interpolateEntities({ a, b, k }, arena, skip = () => false) {
  const out = [];
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
