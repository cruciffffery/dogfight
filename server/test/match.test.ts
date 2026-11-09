import { ARENAS } from "@dogfight/shared/arenas.ts";
import { decodeSnapshot } from "@dogfight/shared/codec/binary.ts";
import type { Snapshot } from "@dogfight/shared/protocol.ts";
import { type Command, PlayerId } from "@dogfight/shared/types.ts";
import { describe, expect, test } from "vitest";
import { Match } from "../src/match.ts";
import type { Player } from "../src/rooms.ts";

const cmd = (o: Partial<Command> = {}): Command => ({
  turn: 0,
  thrust: false,
  brake: false,
  fire: false,
  ...o,
});
const P1 = PlayerId(1);

function setup() {
  const match = new Match({ room: { id: "t" }, arena: ARENAS.duel, seed: 1 });
  match.autoStart = false; // без таймера: тікаємо вручну
  const inbox: Snapshot[] = [];
  const player: Player = {
    id: P1,
    name: "A",
    shipId: 0,
    skin: "blue",
    send: (data) => {
      if (typeof data !== "string") inbox.push(decodeSnapshot(data));
    },
  };
  const ship = match.addPlayer(player);
  return { match, inbox, ship };
}

describe("Match (authoritative server)", () => {
  test("one queued command per tick; ack = lastProcessedSeq", () => {
    const { match, inbox } = setup();
    match.onInput(P1, 3, [cmd({ thrust: true }), cmd({ thrust: true }), cmd({ thrust: true })]);
    match.tick();
    expect(inbox.at(-1)?.ack).toBe(1);
    match.tick();
    match.tick();
    expect(inbox.at(-1)?.ack).toBe(3);
    match.tick();
    expect(inbox.at(-1)?.ack).toBe(3);
  });

  test("redundant inputs are de-duplicated (packet loss tolerance)", () => {
    const { match } = setup();
    match.onInput(P1, 3, [cmd(), cmd(), cmd()]);
    match.onInput(P1, 4, [cmd(), cmd(), cmd()]);
    expect(match.players.get(P1)?.queue.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  test("missing input → repeat last command, but never fire", () => {
    const { match, ship } = setup();
    match.onInput(P1, 1, [cmd({ thrust: true, fire: true })]);
    match.tick();
    expect([...match.world.ofKind("bullet")]).toHaveLength(1);
    for (let i = 0; i < 10; i++) match.tick();
    expect([...match.world.ofKind("bullet")]).toHaveLength(1);
    expect(ship.vel.length()).toBeGreaterThan(0);
  });

  test("queue is capped: a client that runs ahead loses its oldest commands", () => {
    const { match } = setup();
    for (let s = 1; s <= 20; s++) match.onInput(P1, s, [cmd()]);
    expect(match.players.get(P1)?.queue.map((c) => c.seq)).toEqual([15, 16, 17, 18, 19, 20]);
  });

  test("removing the last player stops the match", () => {
    const { match } = setup();
    match.removePlayer(P1);
    expect(match.players.size).toBe(0);
    expect(match.running).toBe(false);
  });

  test("stats expose tick duration and jitter", () => {
    const { match } = setup();
    match.tick();
    const s = match.stats();
    expect(s.players).toBe(1);
    expect(s.tickMs.p99).toBeGreaterThanOrEqual(0);
  });
});
