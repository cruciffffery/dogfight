import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { safeJoin } from "../src/http.js";
import { startMatchLog } from "../src/log/matchlog.js";
import { readReplay } from "../src/log/replay.js";
import { parseClientMessage } from "../src/protocol.js";
import { createTokenBucket } from "../src/ratelimit.js";
import { Room, RoomManager } from "../src/rooms.js";

describe("protocol", () => {
  const parse = (obj) => parseClientMessage(JSON.stringify(obj));

  test("accepts valid join / chat / leave", () => {
    assert.deepEqual(parse({ v: 0, type: "join", room: "alpha", name: " Ann " }), {
      ok: true,
      msg: { type: "join", room: "alpha", name: "Ann" },
    });
    assert.equal(parse({ v: 0, type: "chat", text: "hi" }).ok, true);
    assert.equal(parse({ v: 0, type: "leave" }).ok, true);
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ v: 1, type: "chat", text: "x" }),
      JSON.stringify({ v: 0, type: "fly" }),
      JSON.stringify({ v: 0, type: "chat", text: "" }),
      JSON.stringify({ v: 0, type: "chat", text: 5 }),
      JSON.stringify({ v: 0, type: "chat", text: "x".repeat(201) }),
      JSON.stringify({ v: 0, type: "join", room: "../etc", name: "a" }),
      JSON.stringify({ v: 0, type: "join", room: "alpha", name: "<script>" }),
      JSON.stringify({ v: 0, type: "join", room: "alpha", name: "a", admin: true }),
      JSON.stringify({ v: 0, type: "toString" }),
      JSON.stringify({ v: 0, type: "__proto__" }),
    ]) {
      const r = parseClientMessage(bad);
      assert.equal(r.ok, false, `should reject: ${bad}`);
      assert.equal(typeof r.error, "string");
    }
  });

  test("rejects oversized messages", () => {
    const r = parseClientMessage(JSON.stringify({ v: 0, type: "chat", text: "x" }), {
      maxBytes: 10,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  });
});

describe("token bucket", () => {
  test("allows a burst, then refills at the given rate", () => {
    const b = createTokenBucket({ perSecond: 10, burst: 3 }, 0);
    assert.equal(b.take(0), true);
    assert.equal(b.take(0), true);
    assert.equal(b.take(0), true);
    assert.equal(b.take(0), false, "burst exhausted");
    assert.equal(b.take(50), false, "only 0.5 token after 50 ms");
    assert.equal(b.take(100), true, "1 token after 100 ms");
    assert.equal(b.take(10_000), true);
    assert.ok(b.tokens <= 3, "never above burst");
  });
});

describe("rooms", () => {
  const player = (id) => ({ id, name: `p${id}`, send() {} });

  test("Room emits join / leave / chat / empty", () => {
    const room = new Room({ id: "r", name: "R", maxPlayers: 2 });
    const seen = [];
    for (const ev of ["join", "leave", "chat", "empty"]) room.on(ev, () => seen.push(ev));
    room.join(player(1));
    room.chat(1, "hello");
    room.leave(1);
    assert.deepEqual(seen, ["join", "chat", "leave", "empty"]);
  });

  test("Room refuses players over capacity", () => {
    const room = new Room({ id: "r", name: "R", maxPlayers: 1 });
    room.join(player(1));
    assert.throws(() => room.join(player(2)), { code: "ROOM_FULL" });
  });

  test("RoomManager deletes non-persistent rooms when they become empty", () => {
    const rooms = new RoomManager({ maxRooms: 3 });
    const keep = rooms.create({ id: "keep", name: "Keep", persistent: true });
    const temp = rooms.create({ name: "Temp Room!" });
    assert.equal(temp.id, "temp-room");
    for (const r of [keep, temp]) {
      r.join(player(1));
      r.leave(1);
    }
    assert.ok(rooms.get("keep"));
    assert.equal(rooms.get("temp-room"), undefined);
  });

  test("RoomManager caps the number of rooms", () => {
    const rooms = new RoomManager({ maxRooms: 1 });
    rooms.create({ name: "a" });
    assert.throws(() => rooms.create({ name: "b" }), { code: "SERVER_FULL" });
  });
});

describe("static path guard", () => {
  const root = "/srv/app/dist";
  test("keeps paths inside root", () => {
    assert.equal(safeJoin(root, "/index.html"), "/srv/app/dist/index.html");
    assert.equal(safeJoin(root, "/assets/a.js"), "/srv/app/dist/assets/a.js");
  });
  test("blocks traversal, encoded traversal and NUL bytes", () => {
    for (const evil of [
      "/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc/passwd",
      "/a/../../../etc",
      "/%00",
    ]) {
      const r = safeJoin(root, evil);
      assert.ok(r === null || r.startsWith(`${root}/`) || r === root, `${evil} → ${r}`);
    }
    assert.equal(safeJoin(root, "/%E0%A4%A"), null, "malformed escape");
  });
});

describe("config", () => {
  test("defaults and validation", () => {
    const c = loadConfig({});
    assert.equal(c.port, 8080);
    assert.equal(c.maxPlayersPerRoom, 8);
    assert.throws(() => loadConfig({ PORT: "http" }), /PORT/);
    assert.throws(() => loadConfig({ MAX_ROOMS: "0" }), /MAX_ROOMS/);
    assert.throws(() => loadConfig({ ENABLE_DEBUG_ROUTES: "maybe" }), /ENABLE_DEBUG_ROUTES/);
  });
});

describe("match log", () => {
  test("room events → NDJSON file → replay generator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matchlog-"));
    const room = new Room({ id: "log-test", name: "L" });
    const { file, done } = startMatchLog(room, dir);
    room.join({ id: 1, name: "Ann", send() {} });
    room.chat(1, 'line with "quotes" and \n newline');
    room.leave(1);
    room.close();
    await done;
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 4, "join, chat, leave, close");
    const events = [];
    for await (const ev of readReplay(file)) events.push(ev.type);
    assert.deepEqual(events, ["join", "chat", "leave", "close"]);
  });
});
