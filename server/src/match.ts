/**
 * Авторитетний матч: 30 Гц, по одній команді з черги кожного гравця на тік,
 * знімок кожному гравцю з його lastProcessedSeq. Таймер — з абсолютною ціллю.
 */
import { ARENAS } from "@dogfight/shared/arenas.ts";
import { type Codec, codecs, frameSize } from "@dogfight/shared/codec/index.ts";
import { buildSnapshot } from "@dogfight/shared/protocol/snapshot.ts";
import { type ArenaConfig, type CodecName, TICK_DT, TICK_RATE } from "@dogfight/shared/protocol.ts";
import { createArena } from "@dogfight/shared/sim/arena.ts";
import { Ship, SKINS } from "@dogfight/shared/sim/entities/ship.ts";
import { spawnAsteroid, World } from "@dogfight/shared/sim/world.ts";
import {
  type Command,
  type EntityId,
  IDLE_COMMAND,
  type PlayerId,
  type SeqCommand,
} from "@dogfight/shared/types.ts";
import type { Player } from "./rooms.ts";

const TICK_MS = 1000 / TICK_RATE;
const MAX_QUEUE = 6;
const MAX_CATCH_UP = 3;

function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

interface MatchPlayer {
  readonly player: Player;
  readonly ship: Ship;
  queue: SeqCommand[];
  lastSeq: number;
  lastCmd: SeqCommand;
  codec: Codec;
}

export interface MatchStats {
  room: string;
  players: number;
  entities: number;
  tick: number;
  tickMs: { p50: number; p99: number };
  jitterMs: { p50: number; p99: number; max: number };
  skippedTicks: number;
  bytesOut: number;
}

export interface MatchOptions {
  room: { id: string };
  arena?: ArenaConfig;
  seed?: number;
  now?: () => number;
}

export class Match {
  #timer: NodeJS.Timeout | null = null;
  #startedAt = 0;
  #tickTimes: number[] = [];
  #lateness: number[] = [];
  #skipped = 0;
  readonly room: { id: string };
  readonly arenaConfig: ArenaConfig;
  readonly now: () => number;
  readonly world: World;
  readonly players = new Map<PlayerId, MatchPlayer>();
  tickIndex = 0;
  bytesOut = 0;
  /** Тести вимикають таймер і викликають tick() самі. */
  autoStart = true;

  constructor({
    room,
    arena = ARENAS.classic,
    seed = Date.now() & 0xffff,
    now = () => performance.now(),
  }: MatchOptions) {
    this.room = room;
    this.arenaConfig = arena;
    this.now = now;
    this.world = new World({
      arena: createArena(arena.width, arena.height),
      seed,
      rules: { asteroids: arena.asteroids, pickupEvery: arena.pickupEvery },
    });
    for (let i = 0; i < arena.asteroids; i++) spawnAsteroid(this.world, { hunter: i === 0 });
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  addPlayer(player: Player, { codec = "binary" }: { codec?: CodecName } = {}): Ship {
    const skin = SKINS[this.players.size % SKINS.length] ?? "blue";
    const ship = this.world.spawn(
      new Ship({ pos: this.world.findSafeSpot(150), name: player.name, skin, color: "#ffb020" }),
    );
    ship.playerId = player.id;
    this.players.set(player.id, {
      player,
      ship,
      queue: [],
      lastSeq: 0,
      lastCmd: IDLE_COMMAND,
      codec: codecs[codec],
    });
    if (!this.running && this.autoStart) this.start();
    return ship;
  }

  removePlayer(playerId: PlayerId): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.ship.id);
    this.world.scores.delete(p.ship.id);
    this.players.delete(playerId);
    if (this.players.size === 0) this.stop();
  }

  /** cmds — останні N команд (найстаріша перша), seq — номер найновішої. */
  onInput(playerId: PlayerId, seq: number, cmds: readonly Command[]): void {
    const p = this.players.get(playerId);
    if (!p) return;
    const queuedMax = p.queue.at(-1)?.seq ?? p.lastSeq;
    const firstSeq = seq - cmds.length + 1;
    cmds.forEach((cmd, i) => {
      const s = firstSeq + i;
      if (s > queuedMax) p.queue.push({ ...cmd, seq: s });
    });
    while (p.queue.length > MAX_QUEUE) p.queue.shift();
  }

  start(): void {
    this.#startedAt = this.now();
    this.tickIndex = 0;
    this.#schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    const target = this.#startedAt + (this.tickIndex + 1) * TICK_MS;
    this.#timer = setTimeout(() => this.#onTimer(target), Math.max(0, target - this.now()));
  }

  #onTimer(target: number): void {
    this.#lateness.push(this.now() - target);
    let budget = MAX_CATCH_UP;
    while (this.now() >= this.#startedAt + (this.tickIndex + 1) * TICK_MS && budget-- > 0) {
      this.tick();
    }
    const behind = this.now() - (this.#startedAt + (this.tickIndex + 1) * TICK_MS);
    if (behind > TICK_MS * MAX_CATCH_UP) {
      const skip = Math.floor(behind / TICK_MS);
      this.#skipped += skip;
      this.#startedAt += skip * TICK_MS;
    }
    if (this.#timer !== null) this.#schedule();
    if (this.#lateness.length > 600) this.#lateness.splice(0, 300);
    if (this.#tickTimes.length > 600) this.#tickTimes.splice(0, 300);
  }

  tick(): void {
    const t0 = this.now();
    this.tickIndex += 1;
    const inputs = new Map<EntityId, SeqCommand>();
    for (const p of this.players.values()) {
      const cmd = p.queue.shift();
      if (cmd) {
        p.lastCmd = cmd;
        p.lastSeq = cmd.seq;
      } else {
        p.lastCmd = { ...p.lastCmd, fire: false };
      }
      inputs.set(p.ship.id, p.lastCmd);
    }
    this.world.step(TICK_DT, inputs);
    const snapshot = buildSnapshot(this.world, this.world.drainEvents());
    for (const p of this.players.values()) {
      const data = p.codec.encodeSnapshot({ ...snapshot, ack: p.lastSeq });
      this.bytesOut += frameSize(data);
      p.player.send(data, { critical: false });
    }
    this.#tickTimes.push(this.now() - t0);
  }

  stats(): MatchStats {
    const times = [...this.#tickTimes].sort((a, b) => a - b);
    const late = [...this.#lateness].sort((a, b) => a - b);
    return {
      room: this.room.id,
      players: this.players.size,
      entities: this.world.size,
      tick: this.world.tick,
      tickMs: { p50: +percentile(times, 50).toFixed(3), p99: +percentile(times, 99).toFixed(3) },
      jitterMs: {
        p50: +percentile(late, 50).toFixed(2),
        p99: +percentile(late, 99).toFixed(2),
        max: +(late.at(-1) ?? 0).toFixed(2),
      },
      skippedTicks: this.#skipped,
      bytesOut: this.bytesOut,
    };
  }
}
