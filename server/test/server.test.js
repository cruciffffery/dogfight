import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CLOSE } from "@dogfight/shared/protocol/messages.js";
import { connect, startTestServer } from "./helpers.js";

describe("HTTP API", () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(() => srv.close());

  test("GET /health", async () => {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });

  test("GET /api/rooms lists the default rooms", async () => {
    const rooms = await (await fetch(`${srv.url}/api/rooms`)).json();
    assert.deepEqual(
      rooms.map((r) => r.id),
      ["alpha", "rocks", "duel"],
    );
  });

  test("POST /api/rooms validates and creates", async () => {
    const post = (body, headers = {}) =>
      fetch(`${srv.url}/api/rooms`, { method: "POST", body, headers });
    assert.equal((await post('{"name":"Night","arena":"duel"}')).status, 201);
    assert.equal((await post('{"name":"","arena":"duel"}')).status, 422);
    assert.equal((await post('{"name":"x","arena":"moon"}')).status, 422);
    assert.equal((await post("{broken")).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x".repeat(5000) }))).status, 413);
  });

  test("unknown API route → 404 JSON, /api/slow disabled by default", async () => {
    assert.equal((await fetch(`${srv.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/slow`)).status, 404);
  });

  test("replay id is validated", async () => {
    assert.equal((await fetch(`${srv.url}/api/replays/..%2f..%2fetc%2fpasswd`)).status, 400);
    assert.equal((await fetch(`${srv.url}/api/replays/nope`)).status, 404);
  });
});

describe("WebSocket lifecycle", () => {
  let srv;
  before(async () => {
    srv = await startTestServer({
      JOIN_TIMEOUT_MS: "200",
      HEARTBEAT_MS: "100",
      RATE_PER_SECOND: "5",
      RATE_BURST: "5",
      MAX_PAYLOAD: "512",
    });
  });
  after(() => srv.close());

  test("two clients join one room, see the roster and chat", async () => {
    const ann = connect(srv.wsUrl);
    const bob = connect(srv.wsUrl);
    await Promise.all([ann.opened, bob.opened]);
    ann.send({ type: "join", room: "alpha", name: "Ann" });
    const welcome = await ann.waitFor("welcome");
    assert.equal(typeof welcome.playerId, "number");
    bob.send({ type: "join", room: "alpha", name: "Bob" });
    const roster = await ann.waitFor("roster", (m) => m.players.length === 2);
    assert.deepEqual(roster.players.map((p) => p.name).sort(), ["Ann", "Bob"]);
    bob.send({ type: "chat", text: "hello" });
    const chat = await ann.waitFor("chat");
    assert.equal(chat.name, "Bob");
    assert.equal(chat.text, "hello");
    bob.ws.close();
    await ann.waitFor("roster", (m) => m.players.length === 1);
    ann.ws.close();
  });

  test("no join within the timeout → close 4000", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    assert.equal((await c.closed).code, CLOSE.JOIN_TIMEOUT);
  });

  test("invalid message → close 4001", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.ws.send('{"v":1,"type":"hack"}');
    const { code, reason } = await c.closed;
    assert.equal(code, CLOSE.BAD_MESSAGE);
    assert.match(reason, /unknown type/);
  });

  test("unknown room → close 4006; full room → close 4003", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "nowhere", name: "X" });
    assert.equal((await c.closed).code, CLOSE.NO_ROOM);

    const a = connect(srv.wsUrl);
    const b = connect(srv.wsUrl);
    const d = connect(srv.wsUrl);
    await Promise.all([a.opened, b.opened, d.opened]);
    a.send({ type: "join", room: "duel", name: "A" });
    await a.waitFor("welcome");
    b.send({ type: "join", room: "duel", name: "B" });
    await b.waitFor("welcome");
    d.send({ type: "join", room: "duel", name: "D" });
    assert.equal((await d.closed).code, CLOSE.ROOM_FULL);
    a.ws.close();
    b.ws.close();
  });

  test("flooding → close 4002 (rate limit)", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send({ type: "join", room: "alpha", name: "Flood" });
    for (let i = 0; i < 20; i++) c.send({ type: "chat", text: `spam ${i}` });
    assert.equal((await c.closed).code, CLOSE.RATE_LIMITED);
  });

  test("oversized frame → close 1009 (maxPayload)", async () => {
    const c = connect(srv.wsUrl);
    await c.opened;
    c.ws.send("x".repeat(2000));
    assert.equal((await c.closed).code, CLOSE.TOO_BIG);
  });

  test("client that never answers ping is terminated", async () => {
    const c = connect(srv.wsUrl, { autoPong: false });
    await c.opened;
    c.send({ type: "join", room: "rocks", name: "Ghost" });
    await c.waitFor("welcome");
    const { code } = await c.closed;
    assert.equal(code, 1006, "terminate() → abnormal closure");
    assert.ok(srv.counters.heartbeatKills >= 1);
  });

  test("server keeps serving other rooms after all of the above", async () => {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
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
    assert.ok(performance.now() - t0 < 2000);
    await c.waitFor("shutdown");
    assert.equal((await c.closed).code, CLOSE.SHUTDOWN);
  });
});
