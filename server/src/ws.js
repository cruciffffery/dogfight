/**
 * Життєвий цикл WebSocket-з'єднання:
 *   upgrade → таймер join (5 с) → join → повідомлення … → close / heartbeat timeout
 *
 * Кожен сокет має:
 *   - слухача "error" (інакше перша ж помилка сокета обвалить увесь процес);
 *   - token bucket на вхідні повідомлення;
 *   - валідацію кожного повідомлення (protocol.js);
 *   - політику для повільних клієнтів (bufferedAmount).
 */
import { WebSocket, WebSocketServer } from "ws";
import { CLOSE, encode, parseClientMessage } from "./protocol.js";
import { createTokenBucket } from "./ratelimit.js";
import { RoomError } from "./rooms.js";

export function attachWebSockets({ server, config, rooms, log = console, counters }) {
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
      counters.bytesOut += data.length;
      socket.send(data);
    }

    function handleJoin(msg) {
      if (state.room) {
        return send(encode("error", { code: "ALREADY_JOINED", message: "already in a room" }));
      }
      const room = rooms.get(msg.room);
      if (!room) return close(CLOSE.NO_ROOM, "no such room");
      if (room.isFull) return close(CLOSE.ROOM_FULL, "room full");
      const player = { id: nextPlayerId++, name: msg.name, send };
      clearTimeout(joinTimer);
      state.player = player;
      state.room = room;
      // Спочатку welcome (клієнт дізнається свій id), потім join → roster усім, включно з ним
      send(encode("welcome", { playerId: player.id, room: room.toJSON() }), { critical: true });
      try {
        room.join(player);
      } catch (err) {
        state.room = null;
        if (err instanceof RoomError) return close(CLOSE.ROOM_FULL, err.message);
        throw err;
      }
    }

    socket.on("message", (data, isBinary) => {
      counters.messagesIn += 1;
      counters.bytesIn += data.length;
      if (!state.bucket.take()) {
        counters.rateLimited += 1;
        return close(CLOSE.RATE_LIMITED, "rate limit");
      }
      if (isBinary) return close(CLOSE.BAD_MESSAGE, "binary not supported in v0");
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
      state.room?.leave(state.player.id, `close ${code}`);
      state.room = null;
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
