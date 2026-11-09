/**
 * Передбачення і звірка — чисті функції, без DOM і мережі.
 */
import type { ShipState } from "@dogfight/shared/protocol.ts";
import { type Arena, torusDelta, wrapPos } from "@dogfight/shared/sim/arena.ts";
import { integrate, type KinematicsWithThrust } from "@dogfight/shared/sim/physics.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { Command } from "@dogfight/shared/types.ts";

export type Predicted = KinematicsWithThrust;

export interface PendingInput {
  readonly seq: number;
  readonly cmd: Command;
}

export function predictStep(state: Predicted, cmd: Command, dt: number, arena: Arena): Predicted {
  const next = integrate(state, cmd, dt);
  return { pos: wrapPos(next.pos, arena), vel: next.vel, angle: next.angle, thrust: next.thrust };
}

export interface Reconciled {
  state: Predicted;
  pending: PendingInput[];
  /** Наскільки стрибнула позиція (стара − нова); рендер плавно «з'їдає» її. */
  correction: Vector2;
}

export function reconcile(
  predicted: Predicted,
  server: Pick<ShipState, "x" | "y" | "vx" | "vy" | "angle">,
  ack: number,
  pending: readonly PendingInput[],
  dt: number,
  arena: Arena,
): Reconciled {
  const remaining = pending.filter((p) => p.seq > ack);
  let state: Predicted = {
    pos: new Vector2(server.x, server.y),
    vel: new Vector2(server.vx, server.vy),
    angle: server.angle,
    thrust: false,
  };
  for (const { cmd } of remaining) state = predictStep(state, cmd, dt, arena);
  return { state, pending: remaining, correction: torusDelta(state.pos, predicted.pos, arena) };
}
