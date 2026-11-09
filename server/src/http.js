/**
 * HTTP на голому node:http — без фреймворків.
 *   GET  /health               — живий?
 *   GET  /api/rooms            — список кімнат
 *   POST /api/rooms            — створити кімнату (тіло ≤ 4 КБ, JSON, валідація)
 *   GET  /api/replays          — список журналів матчів
 *   GET  /api/replays/:id      — стрім NDJSON-файлу (pipeline, без буферизації всього файлу)
 *   GET  /api/slow             — лише з ENABLE_DEBUG_ROUTES=1: блокує event loop на 300 мс
 *   GET  /*                    — статика з client/dist (MIME + захист від path traversal)
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { REPLAY_ID_RE } from "./log/replay.js";
import { RoomError } from "./rooms.js";

const MIME = {
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

const ARENAS = new Set(["classic", "rockfield", "duel"]);
const MAX_BODY = 4096;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": MIME[".json"],
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

/** Читає тіло з лімітом розміру — інакше POST на 2 ГБ з'їсть пам'ять. */
async function readJsonBody(req, limit = MAX_BODY) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "body too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/**
 * Безпечне зіставлення URL → файл. normalize + resolve, а потім перевірка,
 * що результат лежить УСЕРЕДИНІ root: "/../../etc/passwd" і "%2e%2e%2f" не пройдуть.
 */
export function safeJoin(root, urlPath) {
  let decoded;
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

async function serveStatic(req, res, root) {
  const url = new URL(req.url, "http://x");
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
  if (req.method === "HEAD") return res.end();
  await pipeline(createReadStream(file), res);
}

export function createHttpHandler({ config, rooms, stats, log = console }) {
  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    if (path === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        players: rooms.playerCount,
      });
    }

    if (path === "/api/rooms") {
      if (req.method === "GET") return sendJson(res, 200, rooms.list());
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const arena = body?.arena ?? "classic";
        if (name.length < 1 || name.length > 32) throw new HttpError(422, "name: 1..32 chars");
        if (!ARENAS.has(arena)) throw new HttpError(422, `arena: one of ${[...ARENAS]}`);
        try {
          const room = rooms.create({ name, arena });
          return sendJson(res, 201, room.toJSON());
        } catch (err) {
          if (err instanceof RoomError) throw new HttpError(409, err.message);
          throw err;
        }
      }
      throw new HttpError(405, "method not allowed");
    }

    if (path === "/api/replays") {
      const files = await readdir(config.logDir).catch(() => []);
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
      res.writeHead(200, { "content-type": MIME[".ndjson"], "content-length": info.size });
      if (mode === "buffer") {
        // АНТИПРИКЛАД (лише для заміру): весь файл у пам'ять, потім відправити
        res.end(await readFile(file));
        return;
      }
      if (mode === "nopipe") {
        // АНТИПРИКЛАД (лише для заміру): ігноруємо false від res.write() — backpressure не працює,
        // усе, що клієнт не встиг забрати, накопичується в буфері сокета в пам'яті процесу
        await new Promise((resolve, reject) => {
          createReadStream(file)
            .on("data", (chunk) => res.write(chunk))
            .on("end", () => res.end(resolve))
            .on("error", reject);
        });
        return;
      }
      // pipeline: читаємо файл рівно з тією швидкістю, з якою клієнт забирає дані
      await pipeline(createReadStream(file), res);
      return;
    }

    if (path === "/api/stats") return sendJson(res, 200, stats());

    if (path === "/api/slow" && config.debugRoutes) {
      // НАВМИСНО погано: синхронний цикл блокує event loop на 300 мс для ВСІХ клієнтів
      const end = performance.now() + 300;
      while (performance.now() < end) {
        /* busy-wait */
      }
      return sendJson(res, 200, { blockedMs: 300 });
    }

    if (path.startsWith("/api/")) throw new HttpError(404, "not found");
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "method not allowed");
    return serveStatic(req, res, config.staticDir);
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) {
        // помилка посеред стріму (клієнт закрив з'єднання тощо)
        if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") log.warn?.(`stream error: ${err.message}`);
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error?.(err);
      sendJson(res, status, { error: status === 500 ? "internal error" : err.message });
    }
  };
}
