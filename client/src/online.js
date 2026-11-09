/**
 * Мережева гра (Лаба 5). Сервер — авторитет; клієнт:
 *   - свій корабель ПЕРЕДБАЧАЄ (та сама integrate, що й на сервері) і звіряє зі знімками;
 *   - свої кулі передбачає локально й прив'язує до серверних за номером вводу (seq);
 *   - усе інше ІНТЕРПОЛЮЄ між знімками з затримкою interpDelay;
 *   - події зі знімків (постріли, вибухи, рахунок) передає в аудіо і HUD через EventTarget.
 */

import { encodeInput } from "@dogfight/shared/codec/binary.js";
import { INPUT_REDUNDANCY, TICK_DT } from "@dogfight/shared/protocol/messages.js";
import {
  EVENT_NAME,
  KIND,
  KIND_NAME,
  PICKUP_TYPES,
  SHIP_FLAG,
  SKINS,
} from "@dogfight/shared/protocol/snapshot.js";
import { createArena } from "@dogfight/shared/sim/arena.js";
import { Explosion } from "@dogfight/shared/sim/entities/explosion.js";
import { SHIP_RULES } from "@dogfight/shared/sim/entities/ship.js";
import { chaos, SHIP } from "@dogfight/shared/sim/physics.js";
import { createRng } from "@dogfight/shared/sim/rng.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";
import { attachAudio } from "./audio.js";
import { createHud } from "./hud.js";
import { createInput, readCommand } from "./input.js";
import { createLoop } from "./loop.js";
import { interpolateEntities, SnapshotBuffer } from "./net/interpolation.js";
import { createNetgraph } from "./net/netgraph.js";
import { predictStep, reconcile } from "./net/prediction.js";
import { createStarfield, drawBackground, drawBanner, drawHud, drawWorld } from "./render/draw.js";

const STEP_MS = TICK_DT * 1000;
const NETSIM_PRESETS = [
  { latency: 0, jitter: 0, drop: 0 },
  { latency: 100, jitter: 30, drop: 0.02 },
  { latency: 200, jitter: 50, drop: 0.05 },
];
const SMOOTH_MS = 100; // корекцію «розмазуємо» на ~100 мс

export function startOnlineGame({ view, conn, welcome, config, params }) {
  const arena = createArena(welcome.arena.width, welcome.arena.height);
  view.setArena(arena);
  const stars = createStarfield(arena, Math.round((arena.width * arena.height) / 5500));
  const input = createInput(window);
  const bus = new EventTarget(); // події з сервера → аудіо, HUD
  const netgraph = createNetgraph();
  const codec = welcome.codec;
  const buffer = new SnapshotBuffer({ stepMs: STEP_MS });
  const fxRng = createRng(1234);

  const myShipId = welcome.shipId & 0xffff;
  const names = new Map(); // shipId → name
  conn.on("roster", ({ players }) => {
    names.clear();
    for (const p of players) names.set(p.shipId & 0xffff, p.name);
  });

  // ---- стан передбачення ----
  let predicted = null; // { pos, vel, angle, thrust }
  let prevPredicted = null;
  let pending = []; // [{ seq, cmd }]
  let seq = 0;
  let cooldown = 0;
  let myServer = null; // останній відомий серверний стан мого корабля
  const offset = { x: 0, y: 0 }; // візуальна корекція, що згасає
  let predict = params.get("predict") !== "0";
  let interpDelay = Math.round(Number(params.get("delay") ?? 2 * STEP_MS + 33)); // ≈ 2 інтервали + запас
  let netsimIndex = 0;
  const localBullets = []; // передбачені свої кулі
  const effects = []; // косметичні вибухи
  const pendingEvents = []; // події, що чекають свого часу (renderTime)
  let showNet = true;
  // Замір «натиснув газ → корабель зрушив на екрані» (перше натискання після спокою)
  const motionProbe = { t0: 0, from: null, result: null };
  let showHud = true;

  const netsimFromUrl = {
    latency: Number(params.get("lag") ?? 0),
    jitter: Number(params.get("jitter") ?? 0),
    drop: Number(params.get("drop") ?? 0) / 100,
  };
  conn.netsim = netsimFromUrl;
  // ЕКСПЕРИМЕНТ «зламаний детермінізм»: Math.random() у integrate лише на клієнті
  chaos.amount = Number(params.get("chaos") ?? 0);

  attachAudio(bus, { isLocal: (id) => id === myShipId });
  const scores = new Map();
  const hud = createHud(bus, {
    nameOf: (id) => names.get(id) ?? `#${id}`,
    localId: () => myShipId,
  });

  // ---- RTT ----
  const pingTimer = setInterval(() => conn.send({ type: "ping", t: performance.now() }), 1000);
  conn.on("pong", ({ t }) => {
    const rtt = performance.now() - t;
    netgraph.stats.rtt = netgraph.stats.rtt ? netgraph.stats.rtt * 0.8 + rtt * 0.2 : rtt;
  });

  // ---- знімки ----
  let lastArrival = 0;
  conn.on("snapshot", (snap) => {
    const now = performance.now();
    if (!buffer.push(snap, now)) return;
    lastArrival = now;
    netgraph.stats.snapshotBytes = estimateSize(snap, codec);
    for (const [id, score] of snap.scores) scores.set(id, score);
    for (const ev of snap.events) pendingEvents.push({ tick: snap.tick, ev });

    const mine = snap.entities.find((e) => e.kind === KIND.ship && e.id === myShipId);
    myServer = mine ?? null;
    if (!mine || mine.flags & SHIP_FLAG.destroyed) {
      predicted = null;
      pending = pending.filter((p) => p.seq > snap.ack);
    } else if (!predicted || !predict) {
      predicted = {
        pos: new Vector2(mine.x, mine.y),
        vel: new Vector2(mine.vx, mine.vy),
        angle: mine.angle,
      };
      prevPredicted = predicted;
      pending = pending.filter((p) => p.seq > snap.ack);
    } else {
      const r = reconcile(predicted, mine, snap.ack, pending, TICK_DT, arena);
      pending = r.pending;
      const px = r.correction.length();
      netgraph.recordCorrection(px);
      if (px > 150) {
        // телепорт (респавн тощо) — без згладжування
        offset.x = 0;
        offset.y = 0;
      } else {
        offset.x += r.correction.x;
        offset.y += r.correction.y;
      }
      predicted = r.state;
      if (px > 0.01)
        console.debug(`[net] tick ${snap.tick} ack ${snap.ack} correction ${px.toFixed(2)} px`);
    }
    reconcileBullets(snap, now);
  });

  /** Свої кулі: зв'язати з серверними за seq; прибрати ті, яких сервер більше не має. */
  function reconcileBullets(snap, now) {
    const serverMine = new Map();
    for (const e of snap.entities) {
      if (e.kind === KIND.bullet && e.owner === myShipId) serverMine.set(e.seq, e.id);
    }
    for (let i = localBullets.length - 1; i >= 0; i--) {
      const b = localBullets[i];
      const sid = serverMine.get(b.seq & 0xffff);
      if (sid !== undefined) b.serverId = sid;
      else if (b.serverId !== null || now - b.born > netgraph.stats.rtt + 250) {
        localBullets.splice(i, 1); // влучила / сервер її не створив
      }
    }
  }

  // ---- цикл ----
  function simulate(dt) {
    if (input.justPressed("BracketLeft")) interpDelay = Math.max(0, interpDelay - 16);
    if (input.justPressed("BracketRight")) interpDelay = Math.min(400, interpDelay + 16);
    if (input.justPressed("KeyL")) {
      netsimIndex = (netsimIndex + 1) % NETSIM_PRESETS.length;
      conn.netsim = { ...NETSIM_PRESETS[netsimIndex] };
    }
    if (input.justPressed("KeyP")) predict = !predict;
    if (input.justPressed("KeyN")) showNet = !showNet;
    if (input.justPressed("KeyH")) showHud = !showHud;

    const raw = readCommand(input);
    if (raw.thrust && !motionProbe.t0 && myServer && Math.hypot(myServer.vx, myServer.vy) < 1) {
      motionProbe.t0 = performance.now();
    }
    const cmd = { turn: raw.turn, thrust: raw.thrust, brake: raw.brake, fire: raw.fire };
    seq += 1;
    pending.push({ seq, cmd });
    if (pending.length > 120) pending.shift();
    // останні N команд у кожному повідомленні — втрата одного пакета нічого не губить
    const tail = pending.slice(-INPUT_REDUNDANCY).map((p) => p.cmd);
    if (codec === "binary") conn.sendBinary(encodeInput(seq, tail));
    else conn.send({ type: "input", seq, cmds: tail });

    if (predicted && predict) {
      prevPredicted = predicted;
      predicted = predictStep(predicted, cmd, dt, arena);
      // передбачення пострілу: та сама логіка cooldown, що в Ship.fire()
      cooldown = Math.max(0, cooldown - dt);
      if (cmd.fire && cooldown === 0) {
        const rapid = myServer && myServer.flags & SHIP_FLAG.rapid;
        cooldown = rapid ? SHIP_RULES.rapidFireCooldown : SHIP_RULES.fireCooldown;
        const dir = Vector2.fromAngle(predicted.angle);
        localBullets.push({
          seq,
          serverId: null,
          born: performance.now(),
          pos: predicted.pos.add(dir.scale(SHIP.radius + 6)),
          prevPos: null,
          vel: predicted.vel.add(dir.scale(SHIP_RULES.bulletSpeed)),
          ttl: 1.1,
          homing: !!(myServer && myServer.flags & SHIP_FLAG.homing),
        });
        bus.dispatchEvent(new CustomEvent("fired", { detail: { ownerId: myShipId } }));
      }
    } else if (predicted) {
      prevPredicted = predicted;
    }
    for (let i = localBullets.length - 1; i >= 0; i--) {
      const b = localBullets[i];
      b.prevPos = b.pos;
      b.pos = b.pos.add(b.vel.scale(dt));
      b.pos = new Vector2(
        ((b.pos.x % arena.width) + arena.width) % arena.width,
        ((b.pos.y % arena.height) + arena.height) % arena.height,
      );
      b.ttl -= dt;
      if (b.ttl <= 0) localBullets.splice(i, 1);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      effects[i].update(dt, { despawn: () => effects.splice(i, 1) });
    }
    // згасання візуальної корекції: за SMOOTH_MS залишається ~e^-3 ≈ 5%
    const k = Math.exp((-3 * dt * 1000) / SMOOTH_MS);
    offset.x *= k;
    offset.y *= k;
    hud.update(dt);
    input.endStep();
  }

  /** Події зі знімків програються тоді, коли інтерпольований час до них дійде. */
  function flushEvents(renderTime) {
    while (pendingEvents.length && pendingEvents[0].tick * STEP_MS <= renderTime) {
      const { ev } = pendingEvents.shift();
      const name = EVENT_NAME[ev.type];
      const pos = { x: ev.x, y: ev.y };
      if (name === "fired" && ev.a === myShipId) continue; // свій постріл уже прозвучав
      if (name === "exploded") {
        effects.push(
          new Explosion({
            pos: new Vector2(ev.x, ev.y),
            rng: fxRng,
            color: ev.b === KIND.ship ? "#ffb020" : "#b9a68a",
          }),
        );
      }
      const detail =
        name === "fired"
          ? { ownerId: ev.a, pos }
          : name === "hit"
            ? { targetId: ev.a, pos }
            : name === "exploded"
              ? { id: ev.a, kind: KIND_NAME[ev.b], byId: null, pos }
              : name === "picked"
                ? { id: ev.a, type: PICKUP_TYPES[ev.b], pos }
                : { id: ev.a, points: ev.b, total: scores.get(ev.a) ?? ev.b, pos };
      bus.dispatchEvent(new CustomEvent(name, { detail }));
    }
    if (pendingEvents.length > 500) pendingEvents.splice(0, pendingEvents.length - 500);
  }

  function toRenderEntity(e, time) {
    const pos = { x: e.x, y: e.y };
    const base = {
      id: e.id,
      kind: KIND_NAME[e.kind],
      alive: true,
      pos,
      prevPos: pos,
      angle: e.angle,
      prevAngle: e.angle,
    };
    switch (e.kind) {
      case KIND.ship:
        return {
          ...base,
          radius: SHIP.radius,
          skin: SKINS[e.skin] ?? "blue",
          thrust: !!(e.flags & SHIP_FLAG.thrust),
          destroyed: !!(e.flags & SHIP_FLAG.destroyed),
          hp: e.hp,
          effects: { shield: e.flags & SHIP_FLAG.shield ? 1 : 0 },
        };
      case KIND.bullet:
        return { ...base, radius: 3, homing: e.homing };
      case KIND.asteroid:
        return { ...base, radius: e.radius, shapeSeed: e.variant, homing: e.homing };
      case KIND.pickup:
        return { ...base, radius: 12, type: PICKUP_TYPES[e.ptype] ?? "shield", age: time / 1000 };
      default:
        return null;
    }
  }

  let renderList = [];
  const renderWorld = {
    arena,
    [Symbol.iterator]: () => renderList[Symbol.iterator](),
  };

  function render(alpha, stats) {
    const now = performance.now();
    const rt = buffer.renderTime(now, interpDelay);
    flushEvents(rt);
    const br = buffer.bracket(rt);
    const list = [];
    if (br) {
      const skip = (e) =>
        (e.kind === KIND.ship && e.id === myShipId && predicted) ||
        (e.kind === KIND.bullet && e.owner === myShipId);
      for (const e of interpolateEntities(br, arena, skip)) {
        const r = toRenderEntity(e, now);
        if (r) list.push(r);
      }
      netgraph.stats.starved = br.starved ? 1 : 0;
      if (br.starved) netgraph.stats.starvedFrames += 1;
      netgraph.stats.frames += 1;
    }
    // свій корабель: передбачений стан + згасаюча корекція
    if (predicted && myServer) {
      const cur = predicted;
      const prev = prevPredicted ?? predicted;
      const ship = toRenderEntity(
        { ...myServer, x: cur.pos.x, y: cur.pos.y, angle: cur.angle },
        now,
      );
      ship.pos = {
        x: wrap(cur.pos.x + offset.x, arena.width),
        y: wrap(cur.pos.y + offset.y, arena.height),
      };
      ship.prevPos = {
        x: wrap(prev.pos.x + offset.x, arena.width),
        y: wrap(prev.pos.y + offset.y, arena.height),
      };
      ship.prevAngle = prev.angle;
      ship.thrust = !!cur.thrust;
      list.push(ship);
      if (motionProbe.t0 && !motionProbe.result) {
        motionProbe.from ??= { ...ship.pos };
        if (Math.hypot(ship.pos.x - motionProbe.from.x, ship.pos.y - motionProbe.from.y) > 0.5) {
          motionProbe.result = now - motionProbe.t0;
          netgraph.stats.inputToMotion = motionProbe.result;
        }
      }
    }
    for (const b of localBullets) {
      list.push({
        kind: "bullet",
        alive: true,
        radius: 3,
        homing: b.homing,
        pos: b.pos,
        prevPos: b.prevPos ?? b.pos,
        angle: b.vel.angle(),
        prevAngle: b.vel.angle(),
      });
    }
    for (const fx of effects) list.push(fx);
    renderList = list;

    drawBackground(view, arena, stars);
    drawWorld(view, renderWorld, alpha, now);
    hud.draw(view, (x, y) => ({
      x: view.offsetX + x * view.scale,
      y: view.offsetY + y * view.scale,
    }));

    Object.assign(netgraph.stats, {
      snapshotAge: lastArrival ? now - lastArrival : 0,
      pending: pending.length,
      interpDelay,
      buffer: buffer.items.length,
      codec,
      predict,
      netsim:
        conn.netsim.latency || conn.netsim.drop
          ? `${conn.netsim.latency}±${conn.netsim.jitter} ms, ${(conn.netsim.drop * 100).toFixed(0)}% drop`
          : "",
    });
    netgraph.update(now, conn.bytes);
    if (showNet) netgraph.draw(view);
    if (config.exp !== "none") drawBanner(view, `EXPERIMENT: ${config.exp}`);
    if (showHud) {
      const me = myServer;
      drawHud(view, stats, {
        targetSteps: 1 / TICK_DT,
        lines: [
          {
            text: `${welcome.room.name} · hp ${me?.hp ?? "—"} · ship #${myShipId}`,
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

function wrap(v, size) {
  return ((v % size) + size) % size;
}

function estimateSize(snap, codec) {
  if (codec === "json") return JSON.stringify(snap).length;
  let size = 14 + snap.events.length * 13 + snap.scores.length * 6;
  const extra = { 1: 11, 2: 5, 3: 3, 4: 1 };
  for (const e of snap.entities) size += 13 + (extra[e.kind] ?? 0);
  return size;
}
