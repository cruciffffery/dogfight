/**
 * Мережева гра (Лаба 5): передбачення + звірка свого корабля, локальні кулі,
 * інтерполяція решти, події зі знімків → аудіо/HUD через типізовану шину.
 */
import { Bus } from "@dogfight/shared/bus.ts";
import { encodeInput } from "@dogfight/shared/codec/binary.ts";
import { EVENT, KIND, PICKUP_TYPES, SHIP_FLAG, SKINS } from "@dogfight/shared/protocol/snapshot.ts";
import {
  type EntityState,
  type EventState,
  INPUT_REDUNDANCY,
  type ServerMessageOf,
  type ShipState,
  type Snapshot,
  TICK_DT,
} from "@dogfight/shared/protocol.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { Explosion } from "@dogfight/shared/sim/entities/explosion.ts";
import { SHIP_RULES } from "@dogfight/shared/sim/entities/ship.ts";
import { chaos, SHIP } from "@dogfight/shared/sim/physics.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";
import { assertNever, type Command, EntityId } from "@dogfight/shared/types.ts";
import { attachAudio } from "./audio.ts";
import type { ExperimentConfig } from "./experiments.ts";
import { createHud } from "./hud.ts";
import { createInput, readCommand } from "./input.ts";
import { createLoop, type Loop, type LoopStats } from "./loop.ts";
import type { Connection, NetSim } from "./net/connection.ts";
import { interpolateEntities, SnapshotBuffer } from "./net/interpolation.ts";
import { createNetgraph, type Netgraph } from "./net/netgraph.ts";
import { type PendingInput, type Predicted, predictStep, reconcile } from "./net/prediction.ts";
import type { View } from "./render/canvas.ts";
import {
  createStarfield,
  drawBackground,
  drawBanner,
  drawHud,
  drawWorld,
  type RenderEntity,
  type RenderScene,
} from "./render/draw.ts";

const STEP_MS = TICK_DT * 1000;
const NETSIM_PRESETS: readonly NetSim[] = [
  { latency: 0, jitter: 0, drop: 0 },
  { latency: 100, jitter: 30, drop: 0.02 },
  { latency: 200, jitter: 50, drop: 0.05 },
];
const SMOOTH_MS = 100;

interface LocalBullet {
  seq: number;
  serverId: number | null;
  born: number;
  pos: Vector2;
  prevPos: Vector2 | null;
  vel: Vector2;
  ttl: number;
  homing: boolean;
}

export interface OnlineGame {
  readonly loop: Loop;
  readonly netgraph: Netgraph;
  readonly buffer: SnapshotBuffer;
  readonly predicted: Predicted | null;
  readonly pending: readonly PendingInput[];
  readonly correctionStats: { corrections: number; last: number };
  stop(): void;
}

export interface OnlineOptions {
  view: View;
  conn: Connection;
  welcome: ServerMessageOf<"welcome">;
  config: ExperimentConfig;
  params: URLSearchParams;
}

const wrap = (v: number, size: number): number => ((v % size) + size) % size;

function estimateSize(snap: Snapshot, codec: string): number {
  if (codec === "json") return JSON.stringify(snap).length;
  const extra = { [KIND.ship]: 11, [KIND.bullet]: 5, [KIND.asteroid]: 3, [KIND.pickup]: 1 };
  let size = 14 + snap.events.length * 13 + snap.scores.length * 6;
  for (const e of snap.entities) size += 13 + extra[e.kind];
  return size;
}

export function startOnlineGame({
  view,
  conn,
  welcome,
  config,
  params,
}: OnlineOptions): OnlineGame {
  const arena = createArena(welcome.arena.width, welcome.arena.height);
  view.setArena(arena);
  const stars = createStarfield(arena, Math.round((arena.width * arena.height) / 5500));
  const input = createInput(window);
  const bus = new Bus<WorldEvents>();
  const netgraph = createNetgraph();
  const codec = welcome.codec;
  const buffer = new SnapshotBuffer({ stepMs: STEP_MS });
  const fxRng = createRng(1234);
  const myShipId = welcome.shipId;

  const names = new Map<number, string>();
  conn.on("roster", ({ players }) => {
    names.clear();
    for (const p of players) names.set(p.shipId, p.name);
  });

  let predicted: Predicted | null = null;
  let prevPredicted: Predicted | null = null;
  let pending: PendingInput[] = [];
  let seq = 0;
  let cooldown = 0;
  let myServer: ShipState | null = null;
  const offset = { x: 0, y: 0 };
  let predict = params.get("predict") !== "0";
  let interpDelay = Math.round(Number(params.get("delay") ?? 2 * STEP_MS + 33));
  let netsimIndex = 0;
  const localBullets: LocalBullet[] = [];
  const effects: Explosion[] = [];
  const pendingEvents: { tick: number; ev: EventState }[] = [];
  let showNet = true;
  let showHud = true;
  const motionProbe: { t0: number; from: { x: number; y: number } | null; result: number | null } =
    {
      t0: 0,
      from: null,
      result: null,
    };

  conn.netsim = {
    latency: Number(params.get("lag") ?? 0),
    jitter: Number(params.get("jitter") ?? 0),
    drop: Number(params.get("drop") ?? 0) / 100,
  };
  chaos.amount = Number(params.get("chaos") ?? 0);

  attachAudio(bus, { isLocal: (id) => id === myShipId });
  const scores = new Map<number, number>();
  const hud = createHud(bus, {
    nameOf: (id) => names.get(id) ?? `#${id}`,
    localId: () => myShipId,
  });

  const pingTimer = setInterval(() => conn.send({ type: "ping", t: performance.now() }), 1000);
  conn.on("pong", ({ t }) => {
    const rtt = performance.now() - t;
    netgraph.stats.rtt = netgraph.stats.rtt ? netgraph.stats.rtt * 0.8 + rtt * 0.2 : rtt;
  });

  let lastArrival = 0;
  conn.on("snapshot", (snap) => {
    const now = performance.now();
    if (!buffer.push(snap, now)) return;
    lastArrival = now;
    netgraph.stats.snapshotBytes = estimateSize(snap, codec);
    for (const [id, score] of snap.scores) scores.set(id, score);
    for (const ev of snap.events) pendingEvents.push({ tick: snap.tick, ev });

    const mine = snap.entities.find(
      (e): e is ShipState => e.kind === KIND.ship && e.id === myShipId,
    );
    myServer = mine ?? null;
    if (!mine || mine.flags & SHIP_FLAG.destroyed) {
      predicted = null;
      pending = pending.filter((p) => p.seq > snap.ack);
    } else if (!predicted || !predict) {
      predicted = {
        pos: new Vector2(mine.x, mine.y),
        vel: new Vector2(mine.vx, mine.vy),
        angle: mine.angle,
        thrust: false,
      };
      prevPredicted = predicted;
      pending = pending.filter((p) => p.seq > snap.ack);
    } else {
      const r = reconcile(predicted, mine, snap.ack, pending, TICK_DT, arena);
      pending = r.pending;
      const px = r.correction.length();
      netgraph.recordCorrection(px);
      if (px > 150) {
        offset.x = 0;
        offset.y = 0;
      } else {
        offset.x += r.correction.x;
        offset.y += r.correction.y;
      }
      predicted = r.state;
    }
    reconcileBullets(snap, now);
  });

  function reconcileBullets(snap: Snapshot, now: number): void {
    const serverMine = new Map<number, number>();
    for (const e of snap.entities) {
      if (e.kind === KIND.bullet && e.owner === myShipId) serverMine.set(e.seq, e.id);
    }
    for (let i = localBullets.length - 1; i >= 0; i--) {
      const b = localBullets[i];
      if (!b) continue;
      const sid = serverMine.get(b.seq & 0xffff);
      if (sid !== undefined) b.serverId = sid;
      else if (b.serverId !== null || now - b.born > netgraph.stats.rtt + 250)
        localBullets.splice(i, 1);
    }
  }

  function simulate(dt: number): void {
    if (input.justPressed("BracketLeft")) interpDelay = Math.max(0, interpDelay - 16);
    if (input.justPressed("BracketRight")) interpDelay = Math.min(400, interpDelay + 16);
    if (input.justPressed("KeyL")) {
      netsimIndex = (netsimIndex + 1) % NETSIM_PRESETS.length;
      conn.netsim = {
        ...(NETSIM_PRESETS[netsimIndex] ?? NETSIM_PRESETS[0] ?? { latency: 0, jitter: 0, drop: 0 }),
      };
    }
    if (input.justPressed("KeyP")) predict = !predict;
    if (input.justPressed("KeyN")) showNet = !showNet;
    if (input.justPressed("KeyH")) showHud = !showHud;

    const cmd: Command = readCommand(input);
    if (cmd.thrust && !motionProbe.t0 && myServer && Math.hypot(myServer.vx, myServer.vy) < 1) {
      motionProbe.t0 = performance.now();
    }
    seq += 1;
    pending.push({ seq, cmd });
    if (pending.length > 120) pending.shift();
    const tail = pending.slice(-INPUT_REDUNDANCY).map((p) => p.cmd);
    if (codec === "binary") conn.sendBinary(encodeInput(seq, tail));
    else conn.send({ type: "input", seq, cmds: tail });

    if (predicted && predict) {
      prevPredicted = predicted;
      predicted = predictStep(predicted, cmd, dt, arena);
      cooldown = Math.max(0, cooldown - dt);
      if (cmd.fire && cooldown === 0) {
        const rapid = myServer !== null && (myServer.flags & SHIP_FLAG.rapid) !== 0;
        cooldown = rapid ? SHIP_RULES.rapidFireCooldown : SHIP_RULES.fireCooldown;
        const dir = Vector2.fromAngle(predicted.angle);
        const pos = predicted.pos.add(dir.scale(SHIP.radius + 6));
        localBullets.push({
          seq,
          serverId: null,
          born: performance.now(),
          pos,
          prevPos: null,
          vel: predicted.vel.add(dir.scale(SHIP_RULES.bulletSpeed)),
          ttl: 1.1,
          homing: myServer !== null && (myServer.flags & SHIP_FLAG.homing) !== 0,
        });
        const id = EntityId(myShipId);
        bus.emit("fired", { ownerId: id, bulletId: id, pos });
      }
    } else if (predicted) {
      prevPredicted = predicted;
    }
    for (let i = localBullets.length - 1; i >= 0; i--) {
      const b = localBullets[i];
      if (!b) continue;
      b.prevPos = b.pos;
      const moved = b.pos.add(b.vel.scale(dt));
      b.pos = new Vector2(wrap(moved.x, arena.width), wrap(moved.y, arena.height));
      b.ttl -= dt;
      if (b.ttl <= 0) localBullets.splice(i, 1);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      effects[i]?.update(dt, { despawn: () => effects.splice(i, 1) });
    }
    const k = Math.exp((-3 * dt * 1000) / SMOOTH_MS);
    offset.x *= k;
    offset.y *= k;
    hud.update(dt);
    input.endStep();
  }

  /** Події зі знімків → типізована шина, коли інтерпольований час до них дійде. */
  function emitEvent(ev: EventState): void {
    const pos = new Vector2(ev.x, ev.y);
    const id = EntityId(ev.a);
    switch (ev.type) {
      case EVENT.fired:
        if (ev.a !== myShipId) bus.emit("fired", { ownerId: id, bulletId: id, pos });
        return;
      case EVENT.hit:
        bus.emit("hit", { targetId: id, byId: null, pos });
        return;
      case EVENT.exploded:
        effects.push(
          new Explosion({ pos, rng: fxRng, color: ev.b === KIND.ship ? "#ffb020" : "#b9a68a" }),
        );
        bus.emit("exploded", {
          id,
          kind: ev.b === KIND.ship ? "ship" : "asteroid",
          byId: null,
          pos,
        });
        return;
      case EVENT.picked:
        bus.emit("picked", { id, type: PICKUP_TYPES[ev.b] ?? "shield", pos });
        return;
      case EVENT.scored:
        bus.emit("scored", { id, points: ev.b, total: scores.get(ev.a) ?? ev.b, pos });
        return;
      default:
        assertNever(ev.type, "event type");
    }
  }

  function flushEvents(renderTime: number): void {
    while (pendingEvents[0] && pendingEvents[0].tick * STEP_MS <= renderTime) {
      const next = pendingEvents.shift();
      if (next) emitEvent(next.ev);
    }
    if (pendingEvents.length > 500) pendingEvents.splice(0, pendingEvents.length - 500);
  }

  function toRenderEntity(e: EntityState, time: number): RenderEntity {
    const pos = { x: e.x, y: e.y };
    const base = { alive: true, pos, prevPos: pos, angle: e.angle, prevAngle: e.angle };
    switch (e.kind) {
      case KIND.ship:
        return {
          ...base,
          kind: "ship",
          radius: SHIP.radius,
          skin: SKINS[e.skin] ?? "blue",
          thrust: (e.flags & SHIP_FLAG.thrust) !== 0,
          destroyed: (e.flags & SHIP_FLAG.destroyed) !== 0,
          hp: e.hp,
          effects: { shield: e.flags & SHIP_FLAG.shield ? 1 : 0 },
        };
      case KIND.bullet:
        return { ...base, kind: "bullet", radius: 3, homing: e.homing };
      case KIND.asteroid:
        return {
          ...base,
          kind: "asteroid",
          radius: e.radius,
          shapeSeed: e.variant,
          homing: e.homing,
        };
      case KIND.pickup:
        return {
          ...base,
          kind: "pickup",
          radius: 12,
          type: PICKUP_TYPES[e.ptype] ?? "shield",
          age: time / 1000,
        };
      default:
        return assertNever(e, "entity state");
    }
  }

  let renderList: RenderEntity[] = [];
  const scene: RenderScene = {
    arena,
    [Symbol.iterator]: () => renderList[Symbol.iterator](),
  };

  function render(alpha: number, stats: LoopStats): void {
    const now = performance.now();
    const rt = buffer.renderTime(now, interpDelay);
    flushEvents(rt);
    const br = buffer.bracket(rt);
    const list: RenderEntity[] = [];
    if (br) {
      const skip = (e: EntityState): boolean =>
        (e.kind === KIND.ship && e.id === myShipId && predicted !== null) ||
        (e.kind === KIND.bullet && e.owner === myShipId);
      for (const e of interpolateEntities(br, arena, skip)) list.push(toRenderEntity(e, now));
      netgraph.stats.starved = br.starved ? 1 : 0;
      if (br.starved) netgraph.stats.starvedFrames += 1;
      netgraph.stats.frames += 1;
    }
    const cur = predicted;
    if (cur && myServer) {
      const prev = prevPredicted ?? cur;
      const pos = {
        x: wrap(cur.pos.x + offset.x, arena.width),
        y: wrap(cur.pos.y + offset.y, arena.height),
      };
      list.push({
        kind: "ship",
        alive: true,
        radius: SHIP.radius,
        pos,
        prevPos: {
          x: wrap(prev.pos.x + offset.x, arena.width),
          y: wrap(prev.pos.y + offset.y, arena.height),
        },
        angle: cur.angle,
        prevAngle: prev.angle,
        skin: SKINS[myServer.skin] ?? "blue",
        thrust: cur.thrust,
        destroyed: false,
        hp: myServer.hp,
        effects: { shield: myServer.flags & SHIP_FLAG.shield ? 1 : 0 },
      });
      if (motionProbe.t0 && motionProbe.result === null) {
        motionProbe.from ??= { ...pos };
        if (Math.hypot(pos.x - motionProbe.from.x, pos.y - motionProbe.from.y) > 0.5) {
          motionProbe.result = now - motionProbe.t0;
          netgraph.stats.inputToMotion = motionProbe.result;
        }
      }
    }
    for (const b of localBullets) {
      const angle = b.vel.angle();
      list.push({
        kind: "bullet",
        alive: true,
        radius: 3,
        homing: b.homing,
        pos: b.pos,
        prevPos: b.prevPos ?? b.pos,
        angle,
        prevAngle: angle,
      });
    }
    for (const fx of effects) list.push(fx);
    renderList = list;

    drawBackground(view, arena, stars);
    drawWorld(view, scene, alpha, now);
    hud.draw(view, (x, y) => ({
      x: view.offsetX + x * view.scale,
      y: view.offsetY + y * view.scale,
    }));

    const ns = conn.netsim;
    Object.assign(netgraph.stats, {
      snapshotAge: lastArrival ? now - lastArrival : 0,
      pending: pending.length,
      interpDelay,
      buffer: buffer.items.length,
      codec,
      predict,
      netsim:
        ns.latency || ns.drop
          ? `${ns.latency}±${ns.jitter} ms, ${(ns.drop * 100).toFixed(0)}% drop`
          : "",
    });
    netgraph.update(now, conn.bytes);
    if (showNet) netgraph.draw(view);
    if (config.exp !== "none") drawBanner(view, `EXPERIMENT: ${config.exp}`);
    if (showHud) {
      drawHud(view, stats, {
        targetSteps: 1 / TICK_DT,
        lines: [
          {
            text: `${welcome.room.name} · hp ${myServer?.hp ?? "—"} · ship #${myShipId}`,
            color: "#cfe0ff",
          },
          { text: "←/→ ↑ ↓ Space — політ і вогонь, Enter — чат" },
        ],
      });
    }
  }

  const loop = createLoop({ step: TICK_DT, simulate, render });
  loop.start();

  return {
    loop,
    netgraph,
    buffer,
    get predicted() {
      return predicted;
    },
    get pending() {
      return pending;
    },
    get correctionStats() {
      return { corrections: netgraph.stats.corrections, last: netgraph.stats.correction };
    },
    stop() {
      clearInterval(pingTimer);
      loop.stop();
    },
  };
}
