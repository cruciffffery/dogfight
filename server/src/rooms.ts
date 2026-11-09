/**
 * Кімнати на EventEmitter з ТИПІЗОВАНОЮ мапою подій: room.on("chat", (player, text) => …)
 * знає типи аргументів, а room.emit("chta", …) — помилка компіляції.
 */
import { EventEmitter } from "node:events";
import type { Frame } from "@dogfight/shared/codec/index.ts";
import type { PlayerInfo, RoomInfo } from "@dogfight/shared/protocol.ts";
import type { PlayerId } from "@dogfight/shared/types.ts";

export interface SendOptions {
  critical?: boolean;
}

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  send(data: Frame, options?: SendOptions): void;
  shipId: number;
  skin: string;
}

export type MatchRecord = { t: number; room: string; type: string } & Record<string, unknown>;

export interface RoomEvents {
  join: [player: Player];
  leave: [player: Player, reason: string];
  chat: [player: Player, text: string];
  empty: [room: Room];
  record: [record: MatchRecord];
  close: [];
}

export type RoomErrorCode = "ROOM_FULL" | "SERVER_FULL" | "EXISTS";

export class RoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export interface RoomInit {
  id: string;
  name: string;
  arena?: string;
  maxPlayers?: number;
  persistent?: boolean;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly arena: string;
  readonly maxPlayers: number;
  readonly persistent: boolean;
  readonly players = new Map<PlayerId, Player>();
  readonly createdAt = Date.now();

  constructor({ id, name, arena = "classic", maxPlayers = 8, persistent = false }: RoomInit) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
  }

  #record(type: string, data: Record<string, unknown>): void {
    this.emit("record", { t: Date.now(), room: this.id, type, ...data });
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  join(player: Player): void {
    if (this.isFull) throw new RoomError("ROOM_FULL", `room ${this.id} is full`);
    this.players.set(player.id, player);
    this.emit("join", player);
    this.#record("join", { player: player.id, name: player.name });
  }

  leave(playerId: PlayerId, reason = "left"): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit("leave", player, reason);
    this.#record("leave", { player: playerId, reason });
    if (this.players.size === 0) this.emit("empty", this);
  }

  chat(playerId: PlayerId, text: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.emit("chat", player, text);
    this.#record("chat", { player: playerId, text });
  }

  roster(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      shipId: p.shipId,
      skin: p.skin,
    }));
  }

  broadcast(
    data: Frame,
    { except = null, critical = false }: { except?: PlayerId | null } & SendOptions = {},
  ): void {
    for (const p of this.players.values()) {
      if (p.id !== except) p.send(data, { critical });
    }
  }

  toJSON(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
    };
  }

  close(): void {
    this.#record("close", {});
    this.emit("close");
    this.removeAllListeners();
  }
}

export interface RoomManagerEvents {
  created: [room: Room];
  deleted: [room: Room];
}

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;

  constructor({ maxRooms = 50, maxPlayersPerRoom = 8 } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  create({
    id,
    name,
    arena,
    persistent = false,
    maxPlayers = this.maxPlayersPerRoom,
  }: Omit<RoomInit, "id"> & { id?: string }): Room {
    if (this.#rooms.size >= this.maxRooms) throw new RoomError("SERVER_FULL", "too many rooms");
    const roomId = id ?? this.#uniqueId(name);
    if (this.#rooms.has(roomId)) throw new RoomError("EXISTS", `room ${roomId} exists`);
    const room = new Room({
      id: roomId,
      name,
      ...(arena === undefined ? {} : { arena }),
      persistent,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
    });
    room.on("empty", () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.#rooms.set(room.id, room);
    this.emit("created", room);
    return room;
  }

  #uniqueId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "room";
    let id = base;
    for (let i = 2; this.#rooms.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    room.close();
    this.emit("deleted", room);
    return true;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.#rooms.values()) n += r.players.size;
    return n;
  }

  [Symbol.iterator](): IterableIterator<Room> {
    return this.#rooms.values();
  }
}
