/**
 * Життєвий цикл WebSocket-з'єднання: join-таймаут, валідація (zod), rate limit,
 * heartbeat, політика повільних клієнтів, слухач "error" на кожному сокеті.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  CodecError,
  decodeInput,
  type Frame,
  frameSize,
  MSG,
} from "@dogfight/shared/codec/index.ts";
import {
  CLOSE,
  type ClientMessage,
  CommandSchema,
  encodeServerMessage,
  INPUT_REDUNDANCY,
  parseClientMessage,
} from "@dogfight/shared/protocol.ts";
import { assertNever, type Command, PlayerId } from "@dogfight/shared/types.ts";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";
import { startHeartbeat } from "./heartbeat.ts";
import type { Logger } from "./logger.ts";
import type { Match } from "./match.ts";
import { createTokenBucket, type TokenBucket } from "./ratelimit.ts";
import type { Player, Room, RoomManager, SendOptions } from "./rooms.ts";

export interface Counters {
  connections: number;
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
  badMessages: number;
  rateLimited: number;
  dropped: number;
  slowClosed: number;
  heartbeatKills: number;
  socketErrors: number;
  rejected: Record<string, number>;
}

export interface MatchRegistry {
  forRoom(room: Room): Match;
  all(): Match[];
}

interface ConnState {
  player: Player | null;
  room: Room | null;
  match: Match | null;
  missedPongs: number;
  bucket: TokenBucket;
}

/** Бінарний input після декодування проходить ту саму zod-перевірку команд. */
const BinaryCommandsSchema = z.array(CommandSchema).min(1).max(INPUT_REDUNDANCY);

/** RawData від ws (Buffer | ArrayBuffer | Buffer[]) → один Uint8Array. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

export interface WsDeps {
  server: Server;
  config: ServerConfig;
  rooms: RoomManager;
  matches: MatchRegistry;
  log: Logger;
  counters: Counters;
  /** Лаба 8: перевірка Origin і ліміт з'єднань на IP; false → 403. */
  acceptUpgrade?: (req: IncomingMessage) => { ok: true } | { ok: false; reason: string };
}

export function attachWebSockets({
  server,
  config,
  rooms,
  matches,
  log,
  counters,
  acceptUpgrade,
}: WsDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  const states = new WeakMap<WebSocket, ConnState>();
  let nextPlayerId = 1;

  const reject = (reason: string): void => {
    counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const verdict = acceptUpgrade?.(req) ?? { ok: true };
    if (!verdict.ok) {
      reject(verdict.reason);
      log.warn({ ip: req.socket.remoteAddress, reason: verdict.reason }, "upgrade rejected");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  function wireRoom(room: Room): void {
    const roster = (): void =>
      room.broadcast(encodeServerMessage({ type: "roster", players: room.roster() }), {
        critical: true,
      });
    room.on("join", roster);
    room.on("leave", roster);
    room.on("chat", (player, text) => {
      room.broadcast(
        encodeServerMessage({
          type: "chat",
          from: player.id,
          name: player.name,
          text,
          t: Date.now(),
        }),
      );
    });
  }
  for (const room of rooms) wireRoom(room);
  rooms.on("created", wireRoom);

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? "?";
    const state: ConnState = {
      player: null,
      room: null,
      match: null,
      missedPongs: 0,
      bucket: createTokenBucket(config.rateLimit),
    };
    states.set(socket, state);
    counters.connections += 1;

    const close = (code: number, reason: string): void => {
      log.info(
        { ip, playerId: state.player?.id, roomId: state.room?.id, code, reason },
        "ws close",
      );
      socket.close(code, reason);
    };

    if (!config.demoNoErrorListener) {
      socket.on("error", (err: Error) => {
        counters.socketErrors += 1;
        reject("socket_error");
        log.warn({ ip, playerId: state.player?.id, err }, "socket error");
      });
    }

    const joinTimer = setTimeout(() => {
      reject("join_timeout");
      close(CLOSE.JOIN_TIMEOUT, "join timeout");
    }, config.joinTimeoutMs);

    function send(data: Frame, { critical = false }: SendOptions = {}): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      const buffered = socket.bufferedAmount;
      if (buffered > config.slowClient.closeAbove) {
        counters.slowClosed += 1;
        reject("slow_client");
        close(CLOSE.SLOW_CLIENT, "client too slow");
        return;
      }
      if (buffered > config.slowClient.dropAbove && !critical) {
        counters.dropped += 1;
        return;
      }
      counters.messagesOut += 1;
      counters.bytesOut += frameSize(data);
      socket.send(data);
    }

    function handleJoin(msg: Extract<ClientMessage, { type: "join" }>): void {
      if (state.room) {
        send(
          encodeServerMessage({
            type: "error",
            code: "ALREADY_JOINED",
            message: "already in a room",
          }),
        );
        return;
      }
      const room = rooms.get(msg.room);
      if (!room) {
        reject("no_room");
        close(CLOSE.NO_ROOM, "no such room");
        return;
      }
      if (room.isFull) {
        reject("room_full");
        close(CLOSE.ROOM_FULL, "room full");
        return;
      }
      const player: Player = {
        id: PlayerId(nextPlayerId++),
        name: msg.name,
        send,
        shipId: 0,
        skin: "blue",
      };
      clearTimeout(joinTimer);
      const match = matches.forRoom(room);
      const ship = match.addPlayer(player, { codec: msg.codec });
      player.shipId = ship.id & 0xffff;
      player.skin = ship.skin;
      state.player = player;
      state.room = room;
      state.match = match;
      send(
        encodeServerMessage({
          type: "welcome",
          playerId: player.id,
          shipId: player.shipId,
          room: room.toJSON(),
          arena: match.arenaConfig,
          tickRate: 30,
          codec: msg.codec,
        }),
        { critical: true },
      );
      room.join(player);
    }

    function handleInput(seq: number, cmds: readonly Command[]): void {
      if (!state.match || !state.player) {
        close(CLOSE.BAD_MESSAGE, "input before join");
        return;
      }
      state.match.onInput(state.player.id, seq, cmds);
    }

    function handle(msg: ClientMessage): void {
      switch (msg.type) {
        case "join":
          handleJoin(msg);
          return;
        case "chat":
          if (!state.room || !state.player) {
            close(CLOSE.BAD_MESSAGE, "chat before join");
            return;
          }
          state.room.chat(state.player.id, msg.text);
          return;
        case "input":
          handleInput(msg.seq, msg.cmds);
          return;
        case "ping":
          send(encodeServerMessage({ type: "pong", t: msg.t }), { critical: true });
          return;
        case "leave":
          close(1000, "bye");
          return;
        default:
          assertNever(msg, "client message");
      }
    }

    socket.on("message", (data: RawData, isBinary: boolean) => {
      // Після close() сокет ще дочитує буфер: такі повідомлення ігноруємо, інакше один флудер
      // давав би десятки «відмов» у метриках і повторні close().
      if (socket.readyState !== WebSocket.OPEN) return;
      const bytes = toBytes(data);
      counters.messagesIn += 1;
      counters.bytesIn += bytes.byteLength;
      if (!state.bucket.take()) {
        counters.rateLimited += 1;
        reject("rate_limit");
        return close(CLOSE.RATE_LIMITED, "rate limit");
      }
      if (isBinary) {
        try {
          if (bytes[0] !== MSG.input) throw new CodecError(`unexpected binary type ${bytes[0]}`);
          const { seq, cmds } = decodeInput(bytes);
          const checked = BinaryCommandsSchema.safeParse(cmds);
          if (!checked.success || seq < 1) throw new CodecError("bad input");
          return handleInput(seq, checked.data);
        } catch (err: unknown) {
          counters.badMessages += 1;
          reject("bad_message");
          return close(
            CLOSE.BAD_MESSAGE,
            (err instanceof Error ? err.message : "bad frame").slice(0, 100),
          );
        }
      }
      const parsed = parseClientMessage(bytes, { maxBytes: config.maxPayload });
      if (!parsed.ok) {
        counters.badMessages += 1;
        reject("bad_message");
        return close(CLOSE.BAD_MESSAGE, parsed.error.slice(0, 100));
      }
      handle(parsed.value);
    });

    socket.on("pong", () => {
      state.missedPongs = 0;
    });

    socket.on("close", (code: number) => {
      clearTimeout(joinTimer);
      counters.connections -= 1;
      if (state.room && state.player) {
        state.match?.removePlayer(state.player.id);
        state.room.leave(state.player.id, `close ${code}`);
      }
      state.room = null;
      state.match = null;
    });
  });

  const stopHeartbeat = startHeartbeat({
    intervalMs: config.heartbeatMs,
    clients: () => wss.clients,
    state: (socket) => states.get(socket),
    ping: (socket) => socket.ping(),
    kill: (socket) => {
      log.info({ playerId: states.get(socket)?.player?.id }, "heartbeat timeout");
      counters.heartbeatKills += 1;
      reject("heartbeat");
      socket.terminate();
    },
  });

  function closeAll(): Promise<void> {
    stopHeartbeat();
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeServerMessage({ type: "shutdown" }));
        socket.close(CLOSE.SHUTDOWN, "server shutting down");
      }
    }
    return new Promise((resolveClosed) => wss.close(() => resolveClosed()));
  }

  return { wss, closeAll };
}
