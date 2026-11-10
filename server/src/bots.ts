/**
 * Серверні боти. Бот — це Player, який замість WebSocket отримує знімки «в нікуди», а свої
 * команди подає через той самий Match.onInput(playerId, seq, cmds), що й людина.
 * Для матчу бот і людина невідрізненні: та сама черга, той самий ack, ті самі правила.
 *
 * Мозок бота (botBrain) — чиста функція (корабель, світ) → Command:
 *   переслідує найближчого ворога, ухиляється від астероїдів попереду, стріляє, коли прицілився.
 */
import { type Arena, torusDelta } from "@dogfight/shared/sim/arena.ts";
import type { Ship } from "@dogfight/shared/sim/entities/ship.ts";
import type { World } from "@dogfight/shared/sim/world.ts";
import { type Command, PlayerId } from "@dogfight/shared/types.ts";
import type { Match } from "./match.ts";
import type { Player, Room } from "./rooms.ts";

const LOOK_AHEAD = 140;

function angleTo(from: Ship, x: number, y: number, arena: Arena): { angle: number; dist: number } {
  const d = torusDelta(from.pos, { x, y }, arena);
  return { angle: Math.atan2(d.y, d.x), dist: Math.hypot(d.x, d.y) };
}

function steer(diff: number): Command["turn"] {
  const d = Math.atan2(Math.sin(diff), Math.cos(diff));
  return d > 0.06 ? 1 : d < -0.06 ? -1 : 0;
}

export function botBrain(ship: Ship, world: World, tick: number): Command {
  if (ship.destroyed) return { turn: 0, thrust: false, brake: false, fire: false };
  const { arena } = world;

  // 1. Ухилення: найближчий астероїд у секторі попереду
  for (const rock of world.ofKind("asteroid")) {
    const { angle, dist } = angleTo(ship, rock.pos.x, rock.pos.y, arena);
    const off = Math.atan2(Math.sin(angle - ship.angle), Math.cos(angle - ship.angle));
    if (dist - rock.radius < LOOK_AHEAD && Math.abs(off) < 0.6) {
      return { turn: off > 0 ? -1 : 1, thrust: true, brake: dist < 70, fire: true };
    }
  }

  // 2. Переслідування найближчого живого ворога
  let best: { angle: number; dist: number } | null = null;
  for (const other of world.ofKind("ship")) {
    if (other === ship || other.destroyed) continue;
    const t = angleTo(ship, other.pos.x, other.pos.y, arena);
    if (!best || t.dist < best.dist) best = t;
  }
  if (!best)
    return { turn: tick % 120 < 60 ? 1 : -1, thrust: tick % 40 < 20, brake: false, fire: false };

  const diff = Math.atan2(Math.sin(best.angle - ship.angle), Math.cos(best.angle - ship.angle));
  return {
    turn: steer(diff),
    thrust: best.dist > 220 && Math.abs(diff) < 0.8,
    brake: best.dist < 120,
    fire: Math.abs(diff) < 0.15 && best.dist < 650,
  };
}

let nextBotId = 1_000_000; // окремий діапазон, щоб не перетинатись із людьми в журналах

export interface BotHandle {
  readonly player: Player;
  stop(): void;
}

/** Додає бота в кімнату і матч. Команди подаються перед кожним тіком сервера. */
export function addBot(room: Room, match: Match, name: string): BotHandle {
  const player: Player = { id: PlayerId(nextBotId++), name, send() {}, shipId: 0, skin: "blue" };
  const ship = match.addPlayer(player, { codec: "binary" });
  player.shipId = ship.id & 0xffff;
  player.skin = ship.skin;
  room.join(player);
  let seq = 0;
  const stop = match.onBeforeTick(() => {
    seq += 1;
    match.onInput(player.id, seq, [botBrain(ship, match.world, seq)]);
  });
  return {
    player,
    stop() {
      stop();
      match.removePlayer(player.id);
      room.leave(player.id, "bot removed");
    },
  };
}
