/**
 * Мережева гра (Лаба 5): передбачення + звірка свого корабля, локальні кулі,
 * інтерполяція решти, події зі знімків → аудіо/HUD через типізовану шину.
 */
import { Bus } from "@dogfight/shared/bus.ts";
import { encodeInput } from "@dogfight/shared/codec/binary.ts";
import {
  EVENT,
  KIND,
  KIND_NAME,
  PICKUP_TYPES,
  SHIP_FLAG,
  SKINS,
} from "@dogfight/shared/protocol/snapshot.ts";
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
import type { PickupType } from "@dogfight/shared/sim/entities/pickup.ts";
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
import { forEachInterpolated, SnapshotBuffer } from "./net/interpolation.ts";
import { createNetgraph, type Netgraph } from "./net/netgraph.ts";
import { type PendingInput, type Predicted, predictStep, reconcile } from "./net/prediction.ts";
import { measure, measured } from "./perf.ts";
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
import { createLayer } from "./render/layer.ts";

const STEP_MS = TICK_DT * 1000;
const NETSIM_PRESETS: readonly NetSim[] = [
  { latency: 0, jitter: 0, drop: 0 },
  { latency: 100, jitter: 30, drop: 0.02 },
  { latency: 200, jitter: 50, drop: 0.05 },
];
const SMOOTH_MS = 100;

/** Передбачена своя куля; одночасно є готовим об'єктом для рендера (RenderBullet). */
interface LocalBullet {
  readonly kind: "bullet";
  readonly alive: true;
  readonly radius: number;
  seq: number;
  serverId: number | null;
  born: number;
  pos: Vector2;
  prevPos: Vector2;
  angle: number;
  prevAngle: number;
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
  // 12 знімків = 400 мс — більше за максимальну затримку інтерполяції. Раніше було 64 (2 с):
  // знімки «доживали» до старого покоління купи, і кожні ~2.5 с запускався повний (major) GC.
  const buffer = new SnapshotBuffer({ stepMs: STEP_MS, capacity: 12 });
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
      const current = predicted;
      const r = measure("reconcile", () =>
        reconcile(current, mine, snap.ack, pending, TICK_DT, arena),
      );
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
        const angle = predicted.vel.add(dir.scale(SHIP_RULES.bulletSpeed)).angle();
        localBullets.push({
          kind: "bullet",
          alive: true,
          radius: 3,
          angle,
          prevAngle: angle,
          seq,
          serverId: null,
          born: performance.now(),
          pos,
          prevPos: pos,
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

  // ---------- рендер без алокацій у кадрі (Лаба 7) ----------
  // Об'єкт для малювання кожної сутності створюється ОДИН раз і далі лише оновлюється.
  interface Pooled {
    r: MutableRender;
    frame: number;
  }
  // Писні (mutable) версії типів рендера: draw.ts бачить їх як readonly, тут — оновлюємо на місці.
  interface MVec {
    x: number;
    y: number;
  }
  interface MBase {
    alive: boolean;
    pos: MVec;
    prevPos: MVec;
    angle: number;
    prevAngle: number;
    radius: number;
  }
  type MShip = MBase & {
    kind: "ship";
    skin: string;
    thrust: boolean;
    destroyed: boolean;
    hp: number;
    effects: { shield: number };
  };
  type MBullet = MBase & { kind: "bullet"; homing: boolean };
  type MAsteroid = MBase & { kind: "asteroid"; shapeSeed: number; homing: boolean };
  type MPickup = MBase & { kind: "pickup"; type: PickupType; age: number };
  type MutableRender = MShip | MBullet | MAsteroid | MPickup;
  const pool = new Map<number, Pooled>();
  let frameNo = 0;
  let nowMs = 0;
  const renderList: RenderEntity[] = [];
  const scene: RenderScene = { arena, [Symbol.iterator]: () => renderList[Symbol.iterator]() };

  function createRender(e: EntityState): MutableRender {
    const pos = { x: e.x, y: e.y };
    const base = { alive: true, pos, prevPos: pos, angle: e.angle, prevAngle: e.angle };
    switch (e.kind) {
      case KIND.ship:
        return {
          ...base,
          kind: "ship",
          radius: SHIP.radius,
          skin: "blue",
          thrust: false,
          destroyed: false,
          hp: 100,
          effects: { shield: 0 },
        };
      case KIND.bullet:
        return { ...base, kind: "bullet", radius: 3, homing: false };
      case KIND.asteroid:
        return { ...base, kind: "asteroid", radius: e.radius, shapeSeed: e.variant, homing: false };
      case KIND.pickup:
        return { ...base, kind: "pickup", radius: 12, type: "shield", age: 0 };
      default:
        return assertNever(e, "entity state");
    }
  }

  /** Оновити пул-об'єкт станом зі знімка (створюється один раз, тут лише записи полів). */
  function visitEntity(e: EntityState, x: number, y: number, angle: number): void {
    let slot = pool.get(e.id);
    if (!slot || slot.r.kind !== KIND_NAME[e.kind]) {
      slot = { r: createRender(e), frame: 0 };
      pool.set(e.id, slot);
    }
    slot.frame = frameNo;
    const r = slot.r;
    r.pos.x = x;
    r.pos.y = y;
    r.angle = angle;
    r.prevAngle = angle;
    switch (r.kind) {
      case "ship":
        if (e.kind === KIND.ship) {
          r.skin = SKINS[e.skin] ?? "blue";
          r.thrust = (e.flags & SHIP_FLAG.thrust) !== 0;
          r.destroyed = (e.flags & SHIP_FLAG.destroyed) !== 0;
          r.hp = e.hp;
          r.effects.shield = e.flags & SHIP_FLAG.shield ? 1 : 0;
        }
        break;
      case "bullet":
        if (e.kind === KIND.bullet) r.homing = e.homing;
        break;
      case "asteroid":
        if (e.kind === KIND.asteroid) r.homing = e.homing;
        break;
      case "pickup":
        if (e.kind === KIND.pickup) {
          r.type = PICKUP_TYPES[e.ptype] ?? "shield";
          r.age = nowMs / 1000;
        }
        break;
    }
    renderList.push(r);
  }

  const skipInterpolated = (e: EntityState): boolean =>
    (e.kind === KIND.ship && e.id === myShipId && predicted !== null) ||
    (e.kind === KIND.bullet && e.owner === myShipId);

  const myShip: MShip = {
    kind: "ship",
    alive: true,
    radius: SHIP.radius,
    pos: { x: 0, y: 0 },
    prevPos: { x: 0, y: 0 },
    angle: 0,
    prevAngle: 0,
    skin: "blue",
    thrust: false,
    destroyed: false,
    hp: 100,
    effects: { shield: 0 },
  };

  const hudLayer = createLayer(view, 100);
  const netLayer = createLayer(view, 100);
  let lastStats: LoopStats | null = null;
  const hudInfo = {
    targetSteps: 1 / TICK_DT,
    lines: [
      { text: "", color: "#cfe0ff" },
      { text: "←/→ ↑ ↓ Space — політ і вогонь, Enter — чат" },
    ],
  };
  const paintHud = (lv: View): void => {
    const line = hudInfo.lines[0];
    if (line)
      line.text = `${welcome.room.name} · hp ${myServer?.hp ?? "—"} · ship #${myShipId} · ${__APP_VERSION__}`;
    if (lastStats) drawHud(lv, lastStats, hudInfo);
  };
  const paintNet = (lv: View): void => netgraph.draw(lv);
  const toScreen = (x: number, y: number) => ({
    x: view.offsetX + x * view.scale,
    y: view.offsetY + y * view.scale,
  });

  function render(alpha: number, stats: LoopStats): void {
    const now = performance.now();
    nowMs = now;
    frameNo += 1;
    lastStats = stats;
    const rt = buffer.renderTime(now, interpDelay);
    flushEvents(rt);
    const br = buffer.bracket(rt);
    renderList.length = 0;
    if (br) {
      forEachInterpolated(br, arena, skipInterpolated, visitEntity);
      netgraph.stats.starved = br.starved ? 1 : 0;
      if (br.starved) netgraph.stats.starvedFrames += 1;
      netgraph.stats.frames += 1;
    }
    // сутності, що зникли зі знімків, прибираємо з пулу (раз на секунду, щоб не обходити щокадру)
    if (frameNo % 60 === 0) {
      for (const [id, slot] of pool) if (frameNo - slot.frame > 30) pool.delete(id);
    }
    const cur = predicted;
    if (cur && myServer) {
      const prev = prevPredicted ?? cur;
      myShip.pos.x = wrap(cur.pos.x + offset.x, arena.width);
      myShip.pos.y = wrap(cur.pos.y + offset.y, arena.height);
      myShip.prevPos.x = wrap(prev.pos.x + offset.x, arena.width);
      myShip.prevPos.y = wrap(prev.pos.y + offset.y, arena.height);
      myShip.angle = cur.angle;
      myShip.prevAngle = prev.angle;
      myShip.skin = SKINS[myServer.skin] ?? "blue";
      myShip.thrust = cur.thrust;
      myShip.hp = myServer.hp;
      myShip.effects.shield = myServer.flags & SHIP_FLAG.shield ? 1 : 0;
      renderList.push(myShip);
      if (motionProbe.t0 && motionProbe.result === null) {
        motionProbe.from ??= { ...myShip.pos };
        if (
          Math.hypot(myShip.pos.x - motionProbe.from.x, myShip.pos.y - motionProbe.from.y) > 0.5
        ) {
          motionProbe.result = now - motionProbe.t0;
          netgraph.stats.inputToMotion = motionProbe.result;
        }
      }
    }
    for (const b of localBullets) renderList.push(b);
    for (const fx of effects) renderList.push(fx);

    drawBackground(view, arena, stars);
    drawWorld(view, scene, alpha, now);
    hud.draw(view, toScreen);

    const st = netgraph.stats;
    st.snapshotAge = lastArrival ? now - lastArrival : 0;
    st.pending = pending.length;
    st.interpDelay = interpDelay;
    st.buffer = buffer.items.length;
    st.predict = predict;
    netgraph.update(now, conn.bytes);
    if (showNet) {
      const ns = conn.netsim;
      st.netsim =
        ns.latency || ns.drop
          ? `${ns.latency}±${ns.jitter} ms, ${(ns.drop * 100).toFixed(0)}% drop`
          : "";
      netLayer.draw(now, paintNet);
    } else netLayer.hide();
    if (config.exp !== "none") drawBanner(view, `EXPERIMENT: ${config.exp}`);
    if (showHud) hudLayer.draw(now, paintHud);
    else hudLayer.hide();
  }

  const loop = createLoop({
    step: TICK_DT,
    simulate: measured("simulate", simulate),
    render: measured("render", render),
  });
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
      hudLayer.destroy();
      netLayer.destroy();
    },
  };
}
