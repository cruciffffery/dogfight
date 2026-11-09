/**
 * Ігровий сервер dogfight: node:http + ws.
 *
 *   npm start -w server          (production: віддає client/dist)
 *   npm run dev -w server        (node --watch, разом з Vite, який проксіює /api і /ws)
 */
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http.js";
import { startMatchLog } from "./log/matchlog.js";
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
  const stats = () => ({
    ...counters,
    rooms: rooms.size,
    players: rooms.playerCount,
    rss: process.memoryUsage().rss,
    uptime: process.uptime(),
  });

  const server = createServer(createHttpHandler({ config, rooms, stats, log }));
  const sockets = attachWebSockets({ server, config, rooms, log, counters });

  rooms.create({ id: "alpha", name: "Alpha — classic", arena: "classic", persistent: true });
  rooms.create({ id: "rocks", name: "Rockfield", arena: "rockfield", persistent: true });
  rooms.create({ id: "duel", name: "Duel 1v1", arena: "duel", persistent: true, maxPlayers: 2 });

  let closing = null;
  /** Зупинка: не приймати нових, закрити сокети, дописати журнали. */
  function close() {
    if (closing) return closing;
    closing = (async () => {
      server.close(); // перестати приймати нові з'єднання
      await sockets.closeAll();
      for (const room of [...rooms]) rooms.delete(room.id); // кімната закривається → журнал дописується
      await Promise.all(logsDone);
      server.closeAllConnections?.();
    })();
    return closing;
  }

  return { server, rooms, counters, stats, close, config };
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
