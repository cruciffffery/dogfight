/**
 * Модель знімка стану — проміжне представлення між World і кодеками.
 *
 * Snapshot = {
 *   tick, ack,                       // ack = lastProcessedSeq для КОНКРЕТНОГО отримувача
 *   entities: EntityState[],
 *   events:   EventState[],          // постріли, влучання, вибухи — для звуку й ефектів
 *   scores:   [shipId, score][],
 * }
 */

export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export const KIND_NAME = Object.freeze(
  Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k])),
);
export const EVENT = Object.freeze({ fired: 1, hit: 2, exploded: 3, picked: 4, scored: 5 });
export const EVENT_NAME = Object.freeze(
  Object.fromEntries(Object.entries(EVENT).map(([k, v]) => [v, k])),
);
export const SKINS = Object.freeze(["blue", "red", "green", "gold"]);
export const PICKUP_TYPES = Object.freeze(["shield", "rapid", "homing"]);

/** Біти поля flags корабля. */
export const SHIP_FLAG = Object.freeze({
  thrust: 1,
  destroyed: 2,
  shield: 4,
  rapid: 8,
  homing: 16,
});

/** Стан однієї сутності для мережі. Вибухи (суто косметика) не передаються. */
export function entityState(e) {
  const base = { id: e.id & 0xffff, kind: KIND[e.kind], x: e.pos.x, y: e.pos.y, angle: e.angle };
  switch (e.kind) {
    case "ship": {
      let flags = 0;
      if (e.thrust) flags |= SHIP_FLAG.thrust;
      if (e.destroyed) flags |= SHIP_FLAG.destroyed;
      if (e.effects.shield > 0) flags |= SHIP_FLAG.shield;
      if (e.effects.rapid > 0) flags |= SHIP_FLAG.rapid;
      if (e.effects.homing > 0) flags |= SHIP_FLAG.homing;
      return {
        ...base,
        vx: e.vel.x,
        vy: e.vel.y,
        hp: e.hp,
        flags,
        skin: Math.max(0, SKINS.indexOf(e.skin)),
      };
    }
    case "bullet":
      return { ...base, owner: e.ownerId & 0xffff, seq: (e.seq ?? 0) & 0xffff, homing: !!e.homing };
    case "asteroid":
      return {
        ...base,
        radius: Math.round(e.radius),
        variant: e.shapeSeed & 0xff,
        homing: !!e.homing,
      };
    case "pickup":
      return { ...base, ptype: PICKUP_TYPES.indexOf(e.type) };
    default:
      return null;
  }
}

/** Події симуляції → компактні записи для мережі. */
export function eventState(ev) {
  const d = ev.detail;
  switch (ev.type) {
    case "fired":
      return { type: EVENT.fired, x: d.pos.x, y: d.pos.y, a: d.ownerId & 0xffff, b: 0 };
    case "hit":
      return { type: EVENT.hit, x: d.pos.x, y: d.pos.y, a: (d.targetId ?? 0) & 0xffff, b: 0 };
    case "exploded":
      return {
        type: EVENT.exploded,
        x: d.pos.x,
        y: d.pos.y,
        a: d.id & 0xffff,
        b: d.kind === "ship" ? KIND.ship : KIND.asteroid,
      };
    case "picked":
      return {
        type: EVENT.picked,
        x: d.pos.x,
        y: d.pos.y,
        a: d.id & 0xffff,
        b: PICKUP_TYPES.indexOf(d.type),
      };
    case "scored":
      return {
        type: EVENT.scored,
        x: d.pos.x,
        y: d.pos.y,
        a: d.id & 0xffff,
        b: Math.min(0xffff, d.points),
      };
    default:
      return null;
  }
}

/** Повний знімок світу (без ack — його додає кодек для кожного отримувача). */
export function buildSnapshot(world, events) {
  const entities = [];
  for (const e of world) {
    if (!e.alive || e.kind === "explosion") continue;
    const s = entityState(e);
    if (s) entities.push(s);
  }
  return {
    tick: world.tick,
    ack: 0,
    entities,
    events: events.map(eventState).filter(Boolean),
    scores: [...world.scores].map(([id, score]) => [id & 0xffff, score]),
  };
}
