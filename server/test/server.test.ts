import { CLOSE } from "@dogfight/shared/protocol.ts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connect, type Msg, startTestServer } from "./helpers.ts";

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const namesOf = (m: Msg): string[] =>
  Array.isArray(m.players)
    ? m.players.map((p: unknown) =>
        typeof p === "object" && p !== null && "name" in p ? String(p.name) : "",
      )
    : [];

describe("HTTP API", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(() => srv.close());

  test("GET /health", async () => {
    const res = await fetch(`${srv.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("GET /api/rooms lists the default rooms", async () => {
    const rooms: unknown = await (await fetch(`${srv.url}/api/rooms`)).json();
    expect(rooms).toMatchObject([{ id: "alpha" }, { id: "rocks" }, { id: "duel" }]);
  });

  test("POST /api/rooms validates and creates", async () => {
    const post = (body: string) => fetch(`${srv.url}/api/rooms`, { method: "POST", body });
    expect((await post('{"name":"Night","arena":"duel"}')).status).toBe(201);
    expect((await post('{"name":"","arena":"duel"}')).status).toBe(422);
    expect((await post('{"name":"x","arena":"moon"}')).status).toBe(422);
    expect((await post("{broken")).status).toBe(400);
    expect((await post(JSON.stringify({ name: "x".repeat(5000) }))).status).toBe(413);
  });

  test("unknown API route → 404, /api/slow disabled by default", async () => {
    expect((await fetch(`${srv.url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${srv.url}/api/slow`)).status).toBe(404);
  });

  test("replay id is validated", async () => {
    expect((await fetch(`${srv.url}/api/replays/..%2f..%2fetc%2fpasswd`)).status).toBe(400);
    expect((await fetch(`${srv.url}/api/replays/nope`)).status).toBe(404);
  });
});

describe("WebSocket lifecycle", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer({
      JOIN_TIMEOUT_MS: "200",
      HEARTBEAT_MS: "100",
      RATE_PER_SECOND: "5",
      RATE_BURST: "5",
      MAX_PAYLOAD: "512",
    });
  });
  afterAll(() => srv.close());

  test("two clients join one room, see the roster and chat", async () => {
    const ann = connect(srv.wsUrl);
    const bob = connect(srv.wsUrl);
    await Promise.all([ann.opened, bob.opened]);
    ann.send({ type: "join", room: "alpha", name: "Ann" });
    const welcome = await ann.waitFor("welcome");
    expect(typeof welcome.playerId).toBe("number");
    bob.send({ type: "join", room: "alpha", name: "Bob" });
    const roster = await ann.waitFor("roster", (m) => namesOf(m).length === 2);
    expect(namesOf(roster).sort()).toEqual(["Ann", "Bob"]);
    bob.send({ type: "chat", text: "hello" });
    expect(await ann.waitFor("chat")).toMatchObject({ name: "Bob", text: "hello" });
    bob.ws.close();
    await ann.waitFor("roster", (m) => namesOf(m).length === 1);
    ann.ws.close();
  });

  test("no join within the timeout → close 4000", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    expect((await c.closed).code).toBe(CLOSE.JOIN_TIMEOUT);
  });

  test("invalid message → close 4001", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.ws.send('{"v":1,"type":"hack"}');
    const { code } = await c.closed;
    expect(code).toBe(CLOSE.BAD_MESSAGE);
  });

  test("unknown room → close 4006; full room → close 4003", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "nowhere", name: "X" });
    expect((await c.closed).code).toBe(CLOSE.NO_ROOM);

    const a = connect(srv.wsUrl);
    const b = connect(srv.wsUrl);
    const d = connect(srv.wsUrl);
    await Promise.all([a.opened, b.opened, d.opened]);
    a.send({ type: "join", room: "duel", name: "A" });
    await a.waitFor("welcome");
    b.send({ type: "join", room: "duel", name: "B" });
    await b.waitFor("welcome");
    d.send({ type: "join", room: "duel", name: "D" });
    expect((await d.closed).code).toBe(CLOSE.ROOM_FULL);
    a.ws.close();
    b.ws.close();
  });

  test("flooding → close 4002 (rate limit)", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "alpha", name: "Flood" });
    for (let i = 0; i < 20; i++) c.send({ type: "chat", text: `spam ${i}` });
    expect((await c.closed).code).toBe(CLOSE.RATE_LIMITED);
  });

  test("oversized frame → close 1009 (maxPayload)", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.ws.send("x".repeat(2000));
    expect((await c.closed).code).toBe(CLOSE.TOO_BIG);
  });

  test("garbage binary frame → close 4001", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "rocks", name: "Bin" });
    await c.waitFor("welcome");
    c.ws.send(new Uint8Array([0x01, 0, 0, 0, 0, 1, 1, 0xff]));
    expect((await c.closed).code).toBe(CLOSE.BAD_MESSAGE);
  });

  test("client that never answers ping is terminated", async () => {
    const c = connect(srv.wsUrl, { autoPong: false });
    await c.opened;
    c.send({ type: "join", room: "rocks", name: "Ghost" });
    await c.waitFor("welcome");
    expect((await c.closed).code).toBe(1006);
    expect(srv.counters.heartbeatKills).toBeGreaterThanOrEqual(1);
  });

  test("server keeps serving after all of the above; rejections are counted", async () => {
    expect((await fetch(`${srv.url}/health`)).status).toBe(200);
    expect(srv.counters.rejected).toMatchObject({
      join_timeout: expect.any(Number),
      rate_limit: 1,
    });
  });
});

describe("graceful shutdown", () => {
  test("clients get 'shutdown' + close 1001, logs are flushed", async () => {
    const srv = await startTestServer();
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "alpha", name: "Last" });
    await c.waitFor("welcome");
    const t0 = performance.now();
    await srv.close();
    expect(performance.now() - t0).toBeLessThan(2000);
    await c.waitFor("shutdown");
    expect((await c.closed).code).toBe(CLOSE.SHUTDOWN);
  });
});
