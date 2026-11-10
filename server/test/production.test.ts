/**
 * Лаба 8: продакшн-поведінка — Origin, ліміт на IP, /ready, /metrics, версія, ізоляція від флуду.
 */
import { afterEach, describe, expect, test } from "vitest";
import { connect, startTestServer } from "./helpers.ts";

type Srv = Awaited<ReturnType<typeof startTestServer>>;
const servers: Srv[] = [];
async function start(env: Record<string, string> = {}): Promise<Srv> {
  const s = await startTestServer({ STATIC_DIR: `${import.meta.dirname}/fixtures/static`, ...env });
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** Чекає на результат рукостискання: "open" або HTTP-статус відмови. */
function handshake(c: ReturnType<typeof connect>): Promise<"open" | number> {
  return new Promise((resolve) => {
    c.ws.once("open", () => resolve("open"));
    c.ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
  });
}

describe("origin check", () => {
  test("same host and no Origin are accepted, a foreign site is rejected", async () => {
    const srv = await start();
    const host = new URL(srv.url).host;
    expect(await handshake(connect(srv.wsUrl, { headers: { origin: `http://${host}` } }))).toBe(
      "open",
    );
    expect(await handshake(connect(srv.wsUrl))).toBe("open"); // не браузер
    expect(
      await handshake(connect(srv.wsUrl, { headers: { origin: "https://evil.example" } })),
    ).toBe(403);
    expect(srv.counters.rejected.bad_origin).toBe(1);
  });

  test("ALLOWED_ORIGINS is an exact allow-list", async () => {
    const srv = await start({ ALLOWED_ORIGINS: "https://dogfight.fly.dev" });
    expect(
      await handshake(connect(srv.wsUrl, { headers: { origin: "https://dogfight.fly.dev" } })),
    ).toBe("open");
    const host = new URL(srv.url).host;
    expect(await handshake(connect(srv.wsUrl, { headers: { origin: `http://${host}` } }))).toBe(
      403,
    );
  });
});

describe("per-IP connection cap", () => {
  test("the (N+1)-th socket from one IP gets 403; a slot frees up after close", async () => {
    const srv = await start({ MAX_CONNECTIONS_PER_IP: "3" });
    const open = [connect(srv.wsUrl), connect(srv.wsUrl), connect(srv.wsUrl)];
    for (const c of open) expect(await handshake(c)).toBe("open");
    expect(await handshake(connect(srv.wsUrl))).toBe(403);
    expect(srv.counters.rejected.ip_limit).toBe(1);
    open[0]?.ws.close();
    await open[0]?.closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(await handshake(connect(srv.wsUrl))).toBe("open");
  });

  test("behind a trusted proxy the cap is per X-Forwarded-For client", async () => {
    const srv = await start({ MAX_CONNECTIONS_PER_IP: "1", TRUST_PROXY: "1" });
    const as = (ip: string) =>
      connect(srv.wsUrl, { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
    expect(await handshake(as("203.0.113.1"))).toBe("open");
    expect(await handshake(as("203.0.113.2"))).toBe("open");
    expect(await handshake(as("203.0.113.1"))).toBe(403);
  });
});

describe("per-IP connect rate", () => {
  test("a reconnect loop from one IP is cut off after the burst", async () => {
    const srv = await start({ CONNECT_BURST_PER_IP: "5", CONNECT_RATE_PER_IP: "1" });
    const results: ("open" | number)[] = [];
    for (let i = 0; i < 7; i++) {
      const c = connect(srv.wsUrl);
      results.push(await handshake(c));
      c.ws.terminate();
    }
    expect(results.slice(0, 5)).toEqual(["open", "open", "open", "open", "open"]);
    expect(results.slice(5)).toEqual([403, 403]);
    expect(srv.counters.rejected.ip_rate).toBe(2);
  });
});

describe("health, readiness, metrics", () => {
  test("/health has the version; /ready flips to 503 when shutdown starts", async () => {
    const srv = await start({ APP_VERSION: "v1.0.0-abc1234" });
    const health = await (await fetch(`${srv.url}/health`)).json();
    expect(health).toMatchObject({ status: "ok", version: "v1.0.0-abc1234" });
    expect((await fetch(`${srv.url}/ready`)).status).toBe(200);
    const closing = srv.close();
    expect(srv.isReady()).toBe(false);
    await closing;
  });

  test("/ready is 503 when the client build is missing", async () => {
    const srv = await start({ STATIC_DIR: "/nonexistent" });
    expect((await fetch(`${srv.url}/ready`)).status).toBe(503);
  });

  test("/metrics exposes players, rooms, bytes, rejections, tick p99, ELU, RSS", async () => {
    const srv = await start({ APP_VERSION: "test" });
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "alpha", name: "M" });
    await c.waitFor("welcome");
    await c.waitFor("snapshot");
    await handshake(connect(srv.wsUrl, { headers: { origin: "https://evil.example" } }));
    const text = await (await fetch(`${srv.url}/metrics`)).text();
    expect(text).toMatch(/^dogfight_players 1$/m);
    expect(text).toMatch(/^dogfight_rooms 3$/m);
    expect(text).toMatch(/^dogfight_build_info\{version="test"\} 1$/m);
    expect(text).toMatch(/^dogfight_rejections_total\{reason="bad_origin"\} 1$/m);
    expect(text).toMatch(/^dogfight_bytes_out_total [1-9]\d*$/m);
    expect(text).toMatch(/^dogfight_tick_ms\{room="alpha",quantile="0.99"\} [\d.]+$/m);
    expect(text).toMatch(/^dogfight_event_loop_utilization [\d.e-]+$/m);
    expect(text).toMatch(/^dogfight_process_resident_memory_bytes \d+$/m);
  });
});

describe("chaos: garbage flood", () => {
  test("a garbage sender is closed and counted; a match in another room keeps ticking", async () => {
    const srv = await start({ MAX_CONNECTIONS_PER_IP: "100", CONNECT_BURST_PER_IP: "100" });
    const player = connect(srv.wsUrl);
    await player.opened;
    player.send({ type: "join", room: "rocks", name: "Calm" });
    await player.waitFor("welcome");
    const firstTick = Number((await player.waitFor("snapshot")).tick);

    const garbage: ReturnType<typeof connect>[] = [];
    for (let i = 0; i < 20; i++) {
      const g = connect(srv.wsUrl);
      await g.opened;
      g.ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef, i]));
      garbage.push(g);
    }
    const codes = await Promise.all(garbage.map((g) => g.closed));
    expect(codes.every((c) => c.code === 4001)).toBe(true);
    expect(srv.counters.rejected.bad_message).toBe(20);

    await new Promise((r) => setTimeout(r, 300));
    const later = player.inbox.filter((m) => m.type === "snapshot").at(-1);
    expect(Number(later?.tick) - firstTick).toBeGreaterThanOrEqual(8); // 30 Гц: ≈ 9+ тіків
  });
});
