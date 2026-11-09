/**
 * Dev/preview-сервер Vite + middleware для тестування збоїв завантаження (Лаба 3).
 *
 *   /assets/sounds/ambient.wav  — завжди віддається з затримкою 1.5 с («повільний ресурс»)
 *   /__test/hang                — ніколи не відповідає (перевірка таймауту)
 *   /__test/corrupt.json        — зіпсований JSON
 *   LATENCY_MS=150 npm run dev  — штучна затримка для всіх /assets/* (заміри Promise.all)
 *   SLOW_MS=0                   — вимкнути «повільний» ambient.wav
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const SLOW = Number(process.env.SLOW_MS ?? 1500);

function failureLab() {
  const middleware = (req, res, next) => {
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
    const path = url.split("?")[0];
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

export default defineConfig({
  plugins: [failureLab()],
});
