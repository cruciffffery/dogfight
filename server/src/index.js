/**
 * Ігровий сервер dogfight: node:http + ws.
 *
 *   npm start -w server          (production: віддає client/dist)
 *   npm run dev -w server        (node --watch, разом з Vite, який проксіює /api і /ws)
 */
import { createServer } from "node:http";
import { ARENAS } from "@dogfight/shared/arenas.js";
import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http.js";
import { startMatchLog } from "./log/matchlog.js";
import { Match } from "./match.js";
import { RoomManager } from "./rooms.js";
import { attachWebSockets } from "./ws.js";

export function createGameServer(config = loadConfig(), log = console) {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });

  // Журнал матчу для кожної кімнати. Проміси завершення — для graceful shutdown.
  const logsDone = new Set();
  rooms.on("created", (room) => {
    const { done } = startMatchLog(room, config.logDir, { onError: (e) => log.error(e) });
    logsDone.add(done);
    done.finally(() => logsDone.delete(done));
  });

  const counters = {
    connections: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    badMessages: 0,
    rateLimited: 0,
    dropped: 0,
    slowClosed: 0,
    heartbeatKills: 0,
    socketErrors: 0,
  };
  // Один авторитетний матч на кімнату; створюється з першим гравцем
  const matchByRoom = new Map();
  const matches = {
    forRoom(room) {
      let match = matchByRoom.get(room.id);
      if (!match) {
        match = new Match({ room, arena: ARENAS[room.arena] ?? ARENAS.classic, log });
        matchByRoom.set(room.id, match);
      }
      return match;
    },
    all: () => [...matchByRoom.values()],
  };
  rooms.on("deleted", (room) => {
    matchByRoom.get(room.id)?.stop();
    matchByRoom.delete(room.id);
  });

  const stats = () => ({
    ...counters,
    rooms: rooms.size,
    players: rooms.playerCount,
    rss: process.memoryUsage().rss,
    uptime: process.uptime(),
    matches: matches.all().map((m) => m.stats()),
  });

  const server = createServer(createHttpHandler({ config, rooms, stats, log }));
  const sockets = attachWebSockets({ server, config, rooms, matches, log, counters });

  rooms.create({ id: "alpha", name: "Alpha — classic", arena: "classic", persistent: true });
  rooms.create({ id: "rocks", name: "Rockfield", arena: "rockfield", persistent: true });
  rooms.create({ id: "duel", name: "Duel 1v1", arena: "duel", persistent: true, maxPlayers: 2 });

  let closing = null;
  /** Зупинка: не приймати нових, закрити сокети, дописати журнали. */
  function close() {
    if (closing) return closing;
    closing = (async () => {
      server.close(); // перестати приймати нові з'єднання
      for (const m of matches.all()) m.stop();
      await sockets.closeAll();
      for (const room of [...rooms]) rooms.delete(room.id); // кімната закривається → журнал дописується
      await Promise.all(logsDone);
      server.closeAllConnections?.();
    })();
    return closing;
  }

  return { server, rooms, matches, counters, stats, close, config };
}

function listen(game) {
  return new Promise((resolve) => {
    game.server.listen(game.config.port, game.config.host, () => resolve(game.server.address()));
  });
}

// Запуск лише якщо файл виконали напряму (а не імпортували з тестів)
if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const game = createGameServer(config);
  const addr = await listen(game);
  console.log(
    `[server] listening on http://${addr.address}:${addr.port} (static: ${config.staticDir})`,
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      console.log(`[server] ${signal}: shutting down…`);
      const force = setTimeout(() => {
        console.error("[server] shutdown timed out, forcing exit");
        process.exit(1);
      }, config.shutdownTimeoutMs);
      force.unref();
      await game.close();
      console.log("[server] bye");
      process.exit(0);
    });
  }
}

export { listen };
