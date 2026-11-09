import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientMessage } from "@dogfight/shared/protocol.ts";
import { PlayerId } from "@dogfight/shared/types.ts";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { safeJoin } from "../src/http.ts";
import { startMatchLog } from "../src/log/matchlog.ts";
import { readReplay } from "../src/log/replay.ts";
import { createTokenBucket } from "../src/ratelimit.ts";
import { type Player, Room, RoomManager } from "../src/rooms.ts";

const player = (id: number): Player => ({
  id: PlayerId(id),
  name: `p${id}`,
  send() {},
  shipId: id,
  skin: "blue",
});

describe("protocol (zod)", () => {
  const parse = (obj: unknown) => parseClientMessage(JSON.stringify(obj));

  test("accepts valid join / chat / leave / ping / input", () => {
    expect(parse({ v: 1, type: "join", room: "alpha", name: " Ann " })).toEqual({
      ok: true,
      value: { v: 1, type: "join", room: "alpha", name: "Ann", codec: "binary" },
    });
    expect(parse({ v: 1, type: "chat", text: "hi" }).ok).toBe(true);
    expect(parse({ v: 1, type: "leave" }).ok).toBe(true);
    expect(parse({ v: 1, type: "ping", t: 12.5 }).ok).toBe(true);
    const cmd = { turn: -1, thrust: true, brake: false, fire: false };
    expect(parse({ v: 1, type: "input", seq: 5, cmds: [cmd, cmd] }).ok).toBe(true);
  });

  test.each([
    ["not json", "not json"],
    ["array", "[]"],
    ["null", "null"],
    ["old version", JSON.stringify({ v: 0, type: "chat", text: "x" })],
    ["unknown type", JSON.stringify({ v: 1, type: "fly" })],
    ["empty chat", JSON.stringify({ v: 1, type: "chat", text: "  " })],
    ["chat not string", JSON.stringify({ v: 1, type: "chat", text: 5 })],
    ["chat too long", JSON.stringify({ v: 1, type: "chat", text: "x".repeat(201) })],
    ["room traversal", JSON.stringify({ v: 1, type: "join", room: "../etc", name: "a" })],
    ["html name", JSON.stringify({ v: 1, type: "join", room: "alpha", name: "<script>" })],
    ["extra field", JSON.stringify({ v: 1, type: "join", room: "alpha", name: "a", admin: true })],
    ["prototype type", JSON.stringify({ v: 1, type: "__proto__" })],
    [
      "turn 0.6",
      JSON.stringify({
        v: 1,
        type: "input",
        seq: 1,
        cmds: [{ turn: 0.6, thrust: true, brake: false, fire: false }],
      }),
    ],
    [
      "4 cmds",
      JSON.stringify({
        v: 1,
        type: "input",
        seq: 1,
        cmds: Array(4).fill({ turn: 0, thrust: true, brake: false, fire: false }),
      }),
    ],
    [
      "seq 0",
      JSON.stringify({
        v: 1,
        type: "input",
        seq: 0,
        cmds: [{ turn: 0, thrust: true, brake: false, fire: false }],
      }),
    ],
  ])("rejects %s without throwing", (_name, raw) => {
    const r = parseClientMessage(raw);
    expect(r.ok).toBe(false);
  });

  test("rejects oversized messages and invalid UTF-8", () => {
    const big = parseClientMessage(JSON.stringify({ v: 1, type: "chat", text: "x" }), {
      maxBytes: 10,
    });
    expect(big).toEqual({ ok: false, error: "message too large" });
    expect(parseClientMessage(new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      error: "invalid UTF-8",
    });
  });
});

describe("token bucket", () => {
  test("allows a burst, then refills at the given rate", () => {
    const b = createTokenBucket({ perSecond: 10, burst: 3 }, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true]);
    expect(b.take(0)).toBe(false);
    expect(b.take(50)).toBe(false);
    expect(b.take(100)).toBe(true);
    expect(b.take(10_000)).toBe(true);
    expect(b.tokens).toBeLessThanOrEqual(3);
  });
});

describe("rooms", () => {
  test("Room emits join / leave / chat / empty", () => {
    const room = new Room({ id: "r", name: "R", maxPlayers: 2 });
    const seen: string[] = [];
    room.on("join", () => seen.push("join"));
    room.on("leave", () => seen.push("leave"));
    room.on("chat", () => seen.push("chat"));
    room.on("empty", () => seen.push("empty"));
    room.join(player(1));
    room.chat(PlayerId(1), "hello");
    room.leave(PlayerId(1));
    expect(seen).toEqual(["join", "chat", "leave", "empty"]);
  });

  test("Room refuses players over capacity", () => {
    const room = new Room({ id: "r", name: "R", maxPlayers: 1 });
    room.join(player(1));
    expect(() => room.join(player(2))).toThrowError(expect.objectContaining({ code: "ROOM_FULL" }));
  });

  test("RoomManager deletes non-persistent rooms when they become empty", () => {
    const rooms = new RoomManager({ maxRooms: 3 });
    const keep = rooms.create({ id: "keep", name: "Keep", persistent: true });
    const temp = rooms.create({ name: "Temp Room!" });
    expect(temp.id).toBe("temp-room");
    for (const r of [keep, temp]) {
      r.join(player(1));
      r.leave(PlayerId(1));
    }
    expect(rooms.get("keep")).toBeDefined();
    expect(rooms.get("temp-room")).toBeUndefined();
  });

  test("RoomManager caps the number of rooms and keeps ids unique", () => {
    const rooms = new RoomManager({ maxRooms: 2 });
    expect(rooms.create({ name: "a" }).id).toBe("a");
    expect(rooms.create({ name: "a" }).id).toBe("a-2");
    expect(() => rooms.create({ name: "b" })).toThrowError(
      expect.objectContaining({ code: "SERVER_FULL" }),
    );
  });
});

describe("static path guard", () => {
  const root = "/srv/app/dist";
  test("keeps paths inside root", () => {
    expect(safeJoin(root, "/index.html")).toBe("/srv/app/dist/index.html");
    expect(safeJoin(root, "/assets/a.js")).toBe("/srv/app/dist/assets/a.js");
  });
  test.each([
    "/../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..%2f..%2fetc/passwd",
    "/a/../../../etc",
    "/%00",
  ])("blocks %s", (evil) => {
    const r = safeJoin(root, evil);
    expect(r === null || r === root || r.startsWith(`${root}/`)).toBe(true);
  });
  test("malformed escape → null", () => {
    expect(safeJoin(root, "/%E0%A4%A")).toBeNull();
  });
});

describe("config (zod)", () => {
  test("defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.maxPlayersPerRoom).toBe(8);
    expect(c.debugRoutes).toBe(false);
  });
  test("validation names the variable", () => {
    expect(() => loadConfig({ PORT: "http" })).toThrow(/PORT/);
    expect(() => loadConfig({ MAX_ROOMS: "0" })).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ ENABLE_DEBUG_ROUTES: "maybe" })).toThrow(/ENABLE_DEBUG_ROUTES/);
  });
  test("empty strings fall back to defaults", () => {
    expect(loadConfig({ PORT: "" }).port).toBe(8080);
  });
});

describe("match log", () => {
  test("room events → NDJSON file → replay generator", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matchlog-"));
    const room = new Room({ id: "log-test", name: "L" });
    const { file, done } = startMatchLog(room, dir);
    room.join(player(1));
    room.chat(PlayerId(1), 'line with "quotes" and \n newline');
    room.leave(PlayerId(1));
    room.close();
    await done;
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(4);
    const types: unknown[] = [];
    for await (const ev of readReplay(file)) {
      if (typeof ev === "object" && ev !== null && "type" in ev) types.push(ev.type);
    }
    expect(types).toEqual(["join", "chat", "leave", "close"]);
  });
});
