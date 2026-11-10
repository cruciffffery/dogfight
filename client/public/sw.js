/**
 * Мінімальний service worker (Лаба 8, PWA). Мета — встановлюваність і швидкий повторний старт,
 * а НЕ офлайн-мультиплеєр (без сервера грати однаково нема з ким).
 *
 * - навігація (/) — спершу мережа (щоб нова версія підхоплювалась одразу), кеш — запасний варіант;
 * - /assets/* з хешем в імені — cache-first (файл з таким іменем ніколи не змінюється);
 * - /api, /ws, /health, /ready, /metrics — повз SW, завжди мережа.
 */
const CACHE = "dogfight-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const BYPASS = /^\/(api|ws|health|ready|metrics|__test)(\/|$)/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || BYPASS.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r ?? Response.error())),
    );
    return;
  }

  if (/^\/assets\/.+-[\w-]{8,}\.\w+$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
