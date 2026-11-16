/**
 * Dev/preview-сервер Vite + middleware для тестування збоїв завантаження (Лаба 3).
 *
 *   /assets/sounds/ambient.wav  — завжди віддається з затримкою 1.5 с («повільний ресурс»)
 *   /__test/hang                — ніколи не відповідає (перевірка таймауту)
 *   /__test/corrupt.json        — зіпсований JSON
 *   LATENCY_MS=150 npm run dev  — штучна затримка для всіх /assets/* (заміри Promise.all)
 *   SLOW_MS=0                   — вимкнути «повільний» ambient.wav
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type Connect, defineConfig, type Plugin } from "vite";

const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const SLOW = Number(process.env.SLOW_MS ?? 1500);

function failureLab(): Plugin {
  const middleware: Connect.NextHandleFunction = (
    req: IncomingMessage,
    res: ServerResponse,
    next,
  ) => {
    const url = req.url ?? "";
    if (url.startsWith("/__test/hang")) {
      // тримаємо з'єднання, поки клієнт не здасться
      req.on("close", () => res.end());
      return;
    }
    if (url.startsWith("/__test/corrupt.json")) {
      res.setHeader("content-type", "application/json");
      res.end('{ "cell": 96, "frames": { "ship-blue": { "x": 0, ');
      return;
    }
    // Vite для невідомих шляхів віддає index.html (SPA fallback) зі статусом 200.
    // Для ресурсів це шкідливо: картинка «завантажиться», але не декодується. Віддаємо чесний 404.
    const path = url.split("?")[0] ?? "";
    if (path.startsWith("/assets/") && !existsSync(join(import.meta.dirname, "public", path))) {
      const isBuilt = existsSync(join(import.meta.dirname, "dist", path));
      if (!isBuilt) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
    }
    let delay = url.startsWith("/assets/") ? LATENCY : 0;
    if (url.startsWith("/assets/sounds/ambient.wav")) delay += SLOW;
    if (delay) setTimeout(next, delay);
    else next();
  };
  return {
    name: "dogfight-failure-lab",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

const SERVER = process.env.SERVER_URL ?? "http://localhost:8080";

/**
 * Версія збірки (Лаба 8): APP_VERSION з CI/Docker; на Render — SHA коміту з RENDER_GIT_COMMIT;
 * локально — короткий git SHA; інакше "dev".
 */
function appVersion(): string {
  const v = process.env.APP_VERSION;
  if (v && v !== "dev") return v;
  const render = process.env.RENDER_GIT_COMMIT;
  if (render) return render.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [failureLab()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  build: {
    // PROFILE=1 npm run build — без мініфікації, щоб у профілі були справжні імена функцій
    minify: process.env.PROFILE ? false : "esbuild",
    sourcemap: Boolean(process.env.PROFILE),
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        determinism: new URL("./determinism.html", import.meta.url).pathname,
        dashboard: new URL("./dashboard.html", import.meta.url).pathname,
      },
    },
  },
  server: {
    // У dev клієнт і сервер на різних портах: Vite проксіює API і WebSocket на ігровий сервер
    proxy: {
      "/api": SERVER,
      "/health": SERVER,
      "/ws": { target: SERVER.replace(/^http/, "ws"), ws: true },
    },
  },
});
