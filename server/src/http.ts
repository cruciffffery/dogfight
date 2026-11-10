/**
 * HTTP на голому node:http — без фреймворків. Маршрути описані в README (Лаба 4).
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { isArenaId } from "@dogfight/shared/arenas.ts";
import { z } from "zod";
import type { ServerConfig } from "./config.ts";
import { REPLAY_ID_RE } from "./log/replay.ts";
import type { Logger } from "./logger.ts";
import { RoomError, type RoomManager } from "./rooms.ts";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
  ".ndjson": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
};
const JSON_TYPE = "application/json; charset=utf-8";
const MAX_BODY = 4096;

const CreateRoomSchema = z.object({
  name: z.string().trim().min(1, "name: 1..32 chars").max(32, "name: 1..32 chars"),
  arena: z.string().default("classic").refine(isArenaId, "arena: one of classic,rockfield,duel"),
});

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": JSON_TYPE,
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/** URL → файл усередині root; null, якщо шлях виходить за межі. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = resolve(root, `.${normalize(`/${decoded}`)}`);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return full === root || full.startsWith(rootWithSep) ? full : null;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  let file = safeJoin(root, url.pathname);
  if (!file) throw new HttpError(403, "forbidden");
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) throw new HttpError(404, "not found");
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = url.pathname.startsWith("/assets/") && /-[\w]{8,}\./.test(url.pathname);
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(file), res);
}

export interface HttpDeps {
  config: ServerConfig;
  rooms: RoomManager;
  stats: () => unknown;
  log: Logger;
  /** Боти (Лаба 7): додати N у кімнату / прибрати всіх. */
  bots?: { add(roomId: string, count: number): number; remove(roomId: string): number };
  /** Додаткові маршрути (Лаба 8: /ready, /metrics). Повертає true, якщо обробив. */
  extraRoutes?: (
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ) => Promise<boolean> | boolean;
}

export function createHttpHandler({ config, rooms, stats, log, extraRoutes, bots }: HttpDeps) {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (extraRoutes && (await extraRoutes(req, res, path))) return;

    if (path === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        version: config.version,
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        players: rooms.playerCount,
      });
    }

    if (path === "/api/rooms") {
      if (req.method === "GET") return sendJson(res, 200, rooms.list());
      if (req.method === "POST") {
        const parsed = CreateRoomSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "invalid");
        try {
          const room = rooms.create(parsed.data);
          return sendJson(res, 201, room.toJSON());
        } catch (err: unknown) {
          if (err instanceof RoomError) throw new HttpError(409, err.message);
          throw err;
        }
      }
      throw new HttpError(405, "method not allowed");
    }

    const botsMatch = /^\/api\/rooms\/([a-z0-9-]{1,32})\/bots$/.exec(path);
    if (botsMatch && bots) {
      const roomId = botsMatch[1] ?? "";
      if (!rooms.get(roomId)) throw new HttpError(404, "no such room");
      if (req.method === "POST") {
        const parsed = z
          .object({ count: z.number().int().min(1).max(64) })
          .safeParse(await readJsonBody(req));
        if (!parsed.success) throw new HttpError(422, "count: 1..64");
        return sendJson(res, 201, { added: bots.add(roomId, parsed.data.count) });
      }
      if (req.method === "DELETE") return sendJson(res, 200, { removed: bots.remove(roomId) });
      throw new HttpError(405, "method not allowed");
    }

    if (path === "/api/replays") {
      const files = await readdir(config.logDir).catch((): string[] => []);
      return sendJson(
        res,
        200,
        files.filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(/\.ndjson$/, "")),
      );
    }

    if (path.startsWith("/api/replays/")) {
      const id = path.slice("/api/replays/".length);
      if (!REPLAY_ID_RE.test(id)) throw new HttpError(400, "bad replay id");
      const file = join(config.logDir, `${id}.ndjson`);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "replay not found");
      const mode = config.debugRoutes ? url.searchParams.get("mode") : null;
      res.writeHead(200, {
        "content-type": MIME[".ndjson"] ?? JSON_TYPE,
        "content-length": info.size,
      });
      if (mode === "buffer") {
        res.end(await readFile(file)); // АНТИПРИКЛАД для заміру
        return;
      }
      if (mode === "nopipe") {
        // АНТИПРИКЛАД для заміру: ігноруємо false від res.write()
        await new Promise<void>((resolveDone, reject) => {
          createReadStream(file)
            .on("data", (chunk) => res.write(chunk))
            .on("end", () => res.end(() => resolveDone()))
            .on("error", reject);
        });
        return;
      }
      await pipeline(createReadStream(file), res);
      return;
    }

    if (path === "/api/stats") return sendJson(res, 200, stats());

    if (path === "/api/slow" && config.debugRoutes) {
      const end = performance.now() + 300;
      while (performance.now() < end) {
        /* busy-wait: навмисно блокуємо event loop */
      }
      return sendJson(res, 200, { blockedMs: 300 });
    }

    if (path.startsWith("/api/")) throw new HttpError(404, "not found");
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "method not allowed");
    return serveStatic(req, res, config.staticDir);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (err: unknown) {
      if (res.headersSent) {
        const code = err instanceof Error && "code" in err ? err.code : undefined;
        if (code !== "ERR_STREAM_PREMATURE_CLOSE") log.warn({ err }, "stream error");
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error({ err }, "unhandled HTTP error");
      sendJson(res, status, {
        error: status === 500 || !(err instanceof Error) ? "internal error" : err.message,
      });
    }
  };
}
