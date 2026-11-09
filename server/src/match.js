/**
 * Авторитетний матч: сервер — єдине джерело правди.
 *
 *   кожні 33.3 мс: по одній команді з черги кожного гравця → World.step(1/30)
 *                  → знімок кожному гравцю (з його lastProcessedSeq) його кодеком
 *
 * Таймер з абсолютною ціллю: наступний тік планується на start + n·33.333 мс, а не
 * «через 33 мс після попереднього». Так похибки setTimeout не накопичуються.
 */
import { codecs } from "@dogfight/shared/codec/index.js";
import { TICK_DT, TICK_RATE } from "@dogfight/shared/protocol/messages.js";
import { buildSnapshot, SKINS } from "@dogfight/shared/protocol/snapshot.js";
import { createArena } from "@dogfight/shared/sim/arena.js";
import { Ship } from "@dogfight/shared/sim/entities/ship.js";
import { spawnAsteroid, World } from "@dogfight/shared/sim/world.js";

const TICK_MS = 1000 / TICK_RATE;
const MAX_QUEUE = 6; // більше — клієнт «забіг уперед»; найстаріші відкидаємо
const MAX_CATCH_UP = 3; // після перевантаження наздоганяємо не більше 3 тіків поспіль
const IDLE = Object.freeze({ seq: 0, turn: 0, thrust: false, brake: false, fire: false });

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export class Match {
  #timer = null;
  #startedAt = 0;
  #tickTimes = []; // тривалість обробки тіку, мс
  #lateness = []; // наскільки тік спізнився відносно цілі, мс
  #skipped = 0;

  constructor({
    room,
    arena,
    seed = Date.now() & 0xffff,
    log = console,
    now = () => performance.now(),
  }) {
    this.room = room;
    this.arenaConfig = arena;
    this.log = log;
    this.now = now;
    this.world = new World({
      arena: createArena(arena.width, arena.height),
      seed,
      rules: { asteroids: arena.asteroids, pickupEvery: arena.pickupEvery },
    });
    for (let i = 0; i < arena.asteroids; i++) spawnAsteroid(this.world, { hunter: i === 0 });
    this.players = new Map(); // playerId → { player, ship, queue, lastSeq, lastCmd, codec }
    this.bytesOut = 0;
  }

  get running() {
    return this.#timer !== null;
  }

  addPlayer(player, { codec = "binary" } = {}) {
    const skin = SKINS[this.players.size % SKINS.length];
    const ship = this.world.spawn(
      new Ship({ pos: this.world.findSafeSpot(150), name: player.name, skin, color: "#ffb020" }),
    );
    ship.playerId = player.id;
    this.players.set(player.id, {
      player,
      ship,
      queue: [],
      lastSeq: 0,
      lastCmd: IDLE,
      codec: codecs[codec] ?? codecs.binary,
    });
    if (!this.running) this.start();
    return ship;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.world.despawn(p.ship.id);
    this.world.scores.delete(p.ship.id);
    this.players.delete(playerId);
    if (this.players.size === 0) this.stop();
  }

  /**
   * Вхідні команди від клієнта. cmds — останні N команд (найстаріша перша), seq — номер найновішої.
   * Дублікати (вже оброблені або вже в черзі) відкидаються — так переживаємо втрату пакетів.
   */
  onInput(playerId, seq, cmds) {
    const p = this.players.get(playerId);
    if (!p) return;
    const queuedMax = p.queue.length ? p.queue[p.queue.length - 1].seq : p.lastSeq;
    const firstSeq = seq - cmds.length + 1;
    cmds.forEach((cmd, i) => {
      const s = firstSeq + i;
      if (s > queuedMax) p.queue.push({ ...cmd, seq: s });
    });
    while (p.queue.length > MAX_QUEUE) p.queue.shift();
  }

  start() {
    this.#startedAt = this.now();
    this.tickIndex = 0;
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule() {
    const target = this.#startedAt + (this.tickIndex + 1) * TICK_MS;
    this.#timer = setTimeout(() => this.#onTimer(target), Math.max(0, target - this.now()));
  }

  #onTimer(target) {
    const late = this.now() - target;
    this.#lateness.push(late);
    let budget = MAX_CATCH_UP;
    // Перевантаження: якщо відстали на кілька тіків — наздоганяємо, але не більше MAX_CATCH_UP
    while (this.now() >= this.#startedAt + (this.tickIndex + 1) * TICK_MS && budget-- > 0) {
      this.tick();
    }
    // Відстали безнадійно (напр. після паузи процесу) — переносимо «нуль» замість спіралі смерті
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

  /** Один тік сервера. Публічний — тести викликають його напряму, без таймерів. */
  tick() {
    const t0 = this.now();
    this.tickIndex += 1;
    const inputs = new Map();
    for (const p of this.players.values()) {
      const cmd = p.queue.shift();
      if (cmd) {
        p.lastCmd = cmd;
        p.lastSeq = cmd.seq;
      } else {
        // Команда не прийшла вчасно: повторюємо попередню, але без пострілу
        p.lastCmd = { ...p.lastCmd, fire: false };
      }
      inputs.set(p.ship.id, p.lastCmd);
    }
    this.world.step(TICK_DT, inputs);
    const snapshot = buildSnapshot(this.world, this.world.drainEvents());
    for (const p of this.players.values()) {
      const data = p.codec.encodeSnapshot({ ...snapshot, ack: p.lastSeq });
      this.bytesOut += typeof data === "string" ? data.length : data.byteLength;
      p.player.send(data, { critical: false }); // повільному клієнту знімок можна пропустити
    }
    this.#tickTimes.push(this.now() - t0);
  }

  stats() {
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
