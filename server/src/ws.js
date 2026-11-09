/**
 * Життєвий цикл WebSocket-з'єднання:
 *   upgrade → таймер join (5 с) → join → повідомлення … → close / heartbeat timeout
 *
 * Кожен сокет має:
 *   - слухача "error" (інакше перша ж помилка сокета обвалить увесь процес);
 *   - token bucket на вхідні повідомлення;
 *   - валідацію кожного повідомлення (@dogfight/shared/protocol/messages.js);
 *   - політику для повільних клієнтів (bufferedAmount).
 */

import { CodecError, decodeInput, MSG } from "@dogfight/shared/codec/index.js";
import {
  CLOSE,
  encode,
  parseClientMessage,
  validateInput,
} from "@dogfight/shared/protocol/messages.js";
import { WebSocket, WebSocketServer } from "ws";
import { createTokenBucket } from "./ratelimit.js";
import { RoomError } from "./rooms.js";

export function attachWebSockets({ server, config, rooms, matches, log = console, counters }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload });
  let nextPlayerId = 1;

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Розсилка подій кімнат — підписуємось один раз на кожну кімнату
  function wireRoom(room) {
    const roster = () =>
      room.broadcast(encode("roster", { players: room.roster() }), { critical: true });
    room.on("join", roster);
    room.on("leave", roster);
    room.on("chat", (player, text) => {
      room.broadcast(encode("chat", { from: player.id, name: player.name, text, t: Date.now() }));
    });
  }
  for (const room of rooms) wireRoom(room);
  rooms.on("created", wireRoom);

  wss.on("connection", (socket, req) => {
    const ip = req.socket.remoteAddress;
    const state = {
      player: null,
      room: null,
      missedPongs: 0,
      bucket: createTokenBucket(config.rateLimit),
    };
    socket.state = state;
    counters.connections += 1;

    const close = (code, reason) => {
      log.info?.(
        `[ws] close ${ip} player=${state.player?.id ?? "-"} code=${code} reason=${reason}`,
      );
      socket.close(code, reason);
    };

    // Без цього рядка будь-яка помилка сокета (напр. перевищено maxPayload, битий кадр)
    // стає подією "error" без слухача → EventEmitter кидає виняток → процес падає.
    if (!config.demoNoErrorListener) {
      socket.on("error", (err) => {
        counters.socketErrors += 1;
        log.warn?.(`[ws] socket error ${ip}: ${err.message}`);
      });
    }

    const joinTimer = setTimeout(
      () => close(CLOSE.JOIN_TIMEOUT, "join timeout"),
      config.joinTimeoutMs,
    );

    function send(data, { critical = false } = {}) {
      if (socket.readyState !== WebSocket.OPEN) return;
      const buffered = socket.bufferedAmount;
      if (buffered > config.slowClient.closeAbove) {
        counters.slowClosed += 1;
        close(CLOSE.SLOW_CLIENT, "client too slow");
        return;
      }
      if (buffered > config.slowClient.dropAbove && !critical) {
        counters.dropped += 1; // повільний клієнт: відкидаємо некритичне (чат, у Лабі 5 — знімки)
        return;
      }
      counters.messagesOut += 1;
      counters.bytesOut += typeof data === "string" ? data.length : data.byteLength;
      socket.send(data);
    }

    function handleJoin(msg) {
      if (state.room) {
        return send(encode("error", { code: "ALREADY_JOINED", message: "already in a room" }));
      }
      const room = rooms.get(msg.room);
      if (!room) return close(CLOSE.NO_ROOM, "no such room");
      if (room.isFull) return close(CLOSE.ROOM_FULL, "room full");
      const player = { id: nextPlayerId++, name: msg.name, send, shipId: 0, skin: "blue" };
      clearTimeout(joinTimer);
      const match = matches.forRoom(room);
      const ship = match.addPlayer(player, { codec: msg.codec });
      player.shipId = ship.id;
      player.skin = ship.skin;
      state.player = player;
      state.room = room;
      state.match = match;
      // Спочатку welcome (клієнт дізнається свій id і корабель), потім roster усім
      send(
        encode("welcome", {
          playerId: player.id,
          shipId: ship.id,
          room: room.toJSON(),
          arena: match.arenaConfig,
          tickRate: 30,
          codec: msg.codec,
        }),
        { critical: true },
      );
      room.join(player);
    }

    function handleInput(seq, cmds) {
      if (!state.match) return close(CLOSE.BAD_MESSAGE, "input before join");
      state.match.onInput(state.player.id, seq, cmds);
    }

    socket.on("message", (data, isBinary) => {
      counters.messagesIn += 1;
      counters.bytesIn += data.length;
      if (!state.bucket.take()) {
        counters.rateLimited += 1;
        return close(CLOSE.RATE_LIMITED, "rate limit");
      }
      if (isBinary) {
        try {
          if (data[0] !== MSG.input) throw new CodecError(`unexpected binary type ${data[0]}`);
          const { seq, cmds } = decodeInput(data);
          const msg = validateInput(seq, cmds);
          return handleInput(msg.seq, msg.cmds);
        } catch (err) {
          counters.badMessages += 1;
          return close(CLOSE.BAD_MESSAGE, String(err.message).slice(0, 100));
        }
      }
      const parsed = parseClientMessage(data, { maxBytes: config.maxPayload });
      if (!parsed.ok) {
        counters.badMessages += 1;
        return close(CLOSE.BAD_MESSAGE, parsed.error.slice(0, 100));
      }
      const { msg } = parsed;
      switch (msg.type) {
        case "join":
          return handleJoin(msg);
        case "chat":
          if (!state.room) return close(CLOSE.BAD_MESSAGE, "chat before join");
          return state.room.chat(state.player.id, msg.text);
        case "input":
          return handleInput(msg.seq, msg.cmds);
        case "ping":
          return send(encode("pong", { t: msg.t }), { critical: true });
        case "leave":
          return close(1000, "bye");
      }
    });

    socket.on("pong", () => {
      state.missedPongs = 0;
    });

    socket.on("close", (code) => {
      clearTimeout(joinTimer);
      counters.connections -= 1;
      if (state.room) {
        state.match?.removePlayer(state.player.id);
        state.room.leave(state.player.id, `close ${code}`);
      }
      state.room = null;
      state.match = null;
    });
  });

  // Heartbeat: ping кожні N мс; два пропущені pong поспіль → terminate (мертве з'єднання)
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.state.missedPongs >= 2) {
        log.info?.(`[ws] heartbeat timeout player=${socket.state.player?.id ?? "-"}`);
        counters.heartbeatKills += 1;
        socket.terminate();
        continue;
      }
      socket.state.missedPongs += 1;
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  /** Graceful shutdown: попередити клієнтів і закрити з кодом 1001. */
  function closeAll() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encode("shutdown"));
        socket.close(CLOSE.SHUTDOWN, "server shutting down");
      }
    }
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return { wss, closeAll };
}
