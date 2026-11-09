/**
 * World → Snapshot. Типи знімка беруться з protocol.ts (zod), тож будь-яке нове поле
 * в схемі одразу вимагає його заповнити тут — інакше помилка компіляції.
 */
import {
  type EntityState,
  EVENT,
  type EventState,
  KIND,
  type ShipState,
  type Snapshot,
} from "../protocol.ts";
import { PICKUP_TYPES } from "../sim/entities/pickup.ts";
import { type Ship, SKINS } from "../sim/entities/ship.ts";
import type { GameEntity, World, WorldEvent } from "../sim/world.ts";
import { assertNever } from "../types.ts";

export { EVENT, KIND, PICKUP_TYPES, SKINS };

export const KIND_NAME = {
  [KIND.ship]: "ship",
  [KIND.bullet]: "bullet",
  [KIND.asteroid]: "asteroid",
  [KIND.pickup]: "pickup",
} satisfies Record<EntityState["kind"], GameEntity["kind"]>;

export const SHIP_FLAG = Object.freeze({
  thrust: 1,
  destroyed: 2,
  shield: 4,
  rapid: 8,
  homing: 16,
});

function shipFlags(e: Ship): number {
  let flags = 0;
  if (e.thrust) flags |= SHIP_FLAG.thrust;
  if (e.destroyed) flags |= SHIP_FLAG.destroyed;
  if (e.effects.shield > 0) flags |= SHIP_FLAG.shield;
  if (e.effects.rapid > 0) flags |= SHIP_FLAG.rapid;
  if (e.effects.homing > 0) flags |= SHIP_FLAG.homing;
  return flags;
}

/** Стан сутності для мережі; вибухи — косметика, не передаються (null). */
export function entityState(e: GameEntity): EntityState | null {
  const base = { id: e.id & 0xffff, x: e.pos.x, y: e.pos.y, angle: e.angle };
  switch (e.kind) {
    case "ship": {
      const s: ShipState = {
        ...base,
        kind: KIND.ship,
        vx: e.vel.x,
        vy: e.vel.y,
        hp: Math.round(e.hp),
        flags: shipFlags(e),
        skin: Math.max(0, SKINS.indexOf(e.skin)),
      };
      return s;
    }
    case "bullet":
      return {
        ...base,
        kind: KIND.bullet,
        owner: e.ownerId & 0xffff,
        seq: e.seq & 0xffff,
        homing: e.homing !== null,
      };
    case "asteroid":
      return {
        ...base,
        kind: KIND.asteroid,
        radius: Math.round(e.radius),
        variant: e.shapeSeed & 0xff,
        homing: e.homing !== null,
      };
    case "pickup":
      return { ...base, kind: KIND.pickup, ptype: PICKUP_TYPES.indexOf(e.type) };
    case "explosion":
      return null;
    default:
      return assertNever(e, "entity kind");
  }
}

export function eventState(ev: WorldEvent): EventState {
  switch (ev.type) {
    case "fired":
      return {
        type: EVENT.fired,
        x: ev.detail.pos.x,
        y: ev.detail.pos.y,
        a: ev.detail.ownerId & 0xffff,
        b: 0,
      };
    case "hit":
      return {
        type: EVENT.hit,
        x: ev.detail.pos.x,
        y: ev.detail.pos.y,
        a: ev.detail.targetId & 0xffff,
        b: 0,
      };
    case "exploded":
      return {
        type: EVENT.exploded,
        x: ev.detail.pos.x,
        y: ev.detail.pos.y,
        a: ev.detail.id & 0xffff,
        b: ev.detail.kind === "ship" ? KIND.ship : KIND.asteroid,
      };
    case "picked":
      return {
        type: EVENT.picked,
        x: ev.detail.pos.x,
        y: ev.detail.pos.y,
        a: ev.detail.id & 0xffff,
        b: PICKUP_TYPES.indexOf(ev.detail.type),
      };
    case "scored":
      return {
        type: EVENT.scored,
        x: ev.detail.pos.x,
        y: ev.detail.pos.y,
        a: ev.detail.id & 0xffff,
        b: Math.min(0xffff, ev.detail.points),
      };
    default:
      return assertNever(ev, "world event");
  }
}

/** Повний знімок світу (ack = 0; кодек підставляє ack кожного отримувача). */
export function buildSnapshot(world: World, events: readonly WorldEvent[]): Snapshot {
  const entities: EntityState[] = [];
  for (const e of world) {
    if (!e.alive) continue;
    const s = entityState(e);
    if (s) entities.push(s);
  }
  return {
    tick: world.tick,
    ack: 0,
    entities,
    events: events.map(eventState),
    scores: [...world.scores].map(([id, score]): [number, number] => [id & 0xffff, score]),
  };
}
