/**
 * Ігровий сервер dogfight: node:http + ws. Запуск TypeScript напряму — вбудоване в Node
 * зрізання типів (type stripping), без кроку збирання.
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { ARENAS, isArenaId } from "@dogfight/shared/arenas.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createHttpHandler } from "./http.ts";
import { type MatchLogResult, startMatchLog } from "./log/matchlog.ts";
import { consoleLogger, type Logger } from "./logger.ts";
import { Match, type MatchStats } from "./match.ts";
import { type Room, RoomManager } from "./rooms.ts";
import { attachWebSockets, type Counters, type MatchRegistry } from "./ws.ts";

export interface GameServer {
  server: Server;
  rooms: RoomManager;
  matches: MatchRegistry;
  counters: Counters;
  stats: () => ServerStats;
  close: () => Promise<void>;
  config: ServerConfig;
}

export interface ServerStats extends Omit<Counters, "rejected"> {
  rejected: Record<string, number>;
  rooms: number;
  players: number;
  rss: number;
  uptime: number;
  matches: MatchStats[];
}

export function createGameServer(
  config: ServerConfig = loadConfig(),
  log: Logger = consoleLogger,
): GameServer {
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
  });

  const logsDone = new Set<Promise<MatchLogResult>>();
  rooms.on("created", (room) => {
    const { done } = startMatchLog(room, config.logDir, {
      onError: (err) => log.error({ err, roomId: room.id }, "match log failed"),
    });
    logsDone.add(done);
    void done.finally(() => logsDone.delete(done));
  });

  const counters: Counters = {
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
    rejected: {},
  };

  const matchByRoom = new Map<string, Match>();
  const matches: MatchRegistry = {
    forRoom(room: Room) {
      let match = matchByRoom.get(room.id);
      if (!match) {
        match = new Match({
          room,
          arena: isArenaId(room.arena) ? ARENAS[room.arena] : ARENAS.classic,
        });
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

  const stats = (): ServerStats => ({
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

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    closing ??= (async () => {
      server.close();
      for (const m of matches.all()) m.stop();
      await sockets.closeAll();
      for (const room of [...rooms]) rooms.delete(room.id);
      await Promise.all(logsDone);
      server.closeAllConnections();
    })();
    return closing;
  }

  return { server, rooms, matches, counters, stats, close, config };
}

export function listen(game: GameServer): Promise<{ address: string; port: number }> {
  return new Promise((resolveListen, reject) => {
    game.server.once("error", reject);
    game.server.listen(game.config.port, game.config.host, () => {
      const addr = game.server.address();
      if (addr === null || typeof addr === "string") reject(new Error("unexpected address"));
      else resolveListen({ address: addr.address, port: addr.port });
    });
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const game = createGameServer(config);
  const addr = await listen(game);
  consoleLogger.info(
    { static: config.staticDir },
    `[server] listening on http://${addr.address}:${addr.port}`,
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      consoleLogger.info({ signal }, "[server] shutting down…");
      const force = setTimeout(() => {
        consoleLogger.error({}, "[server] shutdown timed out, forcing exit");
        process.exit(1);
      }, config.shutdownTimeoutMs);
      force.unref();
      game.close().then(
        () => {
          consoleLogger.info({}, "[server] bye");
          process.exit(0);
        },
        (err: unknown) => {
          consoleLogger.error({ err }, "[server] shutdown failed");
          process.exit(1);
        },
      );
    });
  }
}
