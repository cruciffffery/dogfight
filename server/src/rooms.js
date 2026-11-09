/**
 * Кімнати на EventEmitter.
 *
 * Room подій: "join" (player), "leave" (player, reason), "chat" (player, text), "empty",
 * і узагальнена "record" — кожна подія у вигляді запису для журналу матчу (NDJSON).
 */
import { EventEmitter } from "node:events";

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

export class Room extends EventEmitter {
  constructor({ id, name, arena = "classic", maxPlayers = 8, persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent; // кімнати «за замовчуванням» не видаляються, коли порожні
    this.players = new Map(); // id → { id, name, send }
    this.createdAt = Date.now();
  }

  #record(type, data) {
    this.emit("record", { t: Date.now(), room: this.id, type, ...data });
  }

  get isFull() {
    return this.players.size >= this.maxPlayers;
  }

  join(player) {
    if (this.isFull) throw new RoomError("ROOM_FULL", `room ${this.id} is full`);
    this.players.set(player.id, player);
    this.emit("join", player);
    this.#record("join", { player: player.id, name: player.name });
  }

  leave(playerId, reason = "left") {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit("leave", player, reason);
    this.#record("leave", { player: playerId, reason });
    if (this.players.size === 0) this.emit("empty", this);
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.emit("chat", player, text);
    this.#record("chat", { player: playerId, text });
  }

  roster() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  /** Розіслати всім (крім except). `critical` — не можна відкидати для повільних клієнтів. */
  broadcast(data, { except = null, critical = false } = {}) {
    for (const p of this.players.values()) {
      if (p.id !== except) p.send(data, { critical });
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      arena: this.arena,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
    };
  }

  close() {
    this.#record("close", {});
    this.emit("close");
    this.removeAllListeners();
  }
}

export class RoomManager extends EventEmitter {
  #rooms = new Map();

  constructor({ maxRooms = 50, maxPlayersPerRoom = 8 } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  create({ id, name, arena, persistent = false, maxPlayers = this.maxPlayersPerRoom }) {
    if (this.#rooms.size >= this.maxRooms) throw new RoomError("SERVER_FULL", "too many rooms");
    const roomId = id ?? this.#uniqueId(name);
    if (this.#rooms.has(roomId)) throw new RoomError("EXISTS", `room ${roomId} exists`);
    const room = new Room({
      id: roomId,
      name,
      arena,
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

  #uniqueId(name) {
    const base =
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "room";
    let id = base;
    for (let i = 2; this.#rooms.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.toJSON());
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    room.close();
    this.emit("deleted", room);
    return true;
  }

  get size() {
    return this.#rooms.size;
  }

  get playerCount() {
    let n = 0;
    for (const r of this.#rooms.values()) n += r.players.size;
    return n;
  }

  [Symbol.iterator]() {
    return this.#rooms.values();
  }
}
