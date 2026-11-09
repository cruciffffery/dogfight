import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ARENAS } from "@dogfight/shared/arenas.js";
import { decodeSnapshot } from "@dogfight/shared/codec/binary.js";
import { Match } from "../src/match.js";

const quiet = { info() {}, warn() {}, error() {} };
const cmd = (o = {}) => ({ turn: 0, thrust: false, brake: false, fire: false, ...o });

function setup() {
  const match = new Match({ room: { id: "t" }, arena: ARENAS.duel, seed: 1, log: quiet });
  match.start = () => {}; // без таймера
  const inbox = [];
  const player = { id: 1, name: "A", send: (data) => inbox.push(decodeSnapshot(data)) };
  const ship = match.addPlayer(player);
  return { match, inbox, ship };
}

describe("Match (authoritative server)", () => {
  test("one queued command per tick; ack = lastProcessedSeq", () => {
    const { match, inbox } = setup();
    match.onInput(1, 3, [cmd({ thrust: true }), cmd({ thrust: true }), cmd({ thrust: true })]);
    match.tick();
    assert.equal(inbox.at(-1).ack, 1);
    match.tick();
    match.tick();
    assert.equal(inbox.at(-1).ack, 3);
    match.tick(); // команд немає — ack не зростає
    assert.equal(inbox.at(-1).ack, 3);
  });

  test("redundant inputs are de-duplicated (packet loss tolerance)", () => {
    const { match } = setup();
    match.onInput(1, 3, [cmd(), cmd(), cmd()]); // seq 1..3
    match.onInput(1, 4, [cmd(), cmd(), cmd()]); // seq 2..4 — нове лише 4
    assert.deepEqual(
      match.players.get(1).queue.map((c) => c.seq),
      [1, 2, 3, 4],
    );
  });

  test("missing input → repeat last command, but never fire", () => {
    const { match, ship } = setup();
    match.onInput(1, 1, [cmd({ thrust: true, fire: true })]);
    match.tick();
    const bulletsAfterFirst = [...match.world.ofKind("bullet")].length;
    assert.equal(bulletsAfterFirst, 1);
    for (let i = 0; i < 10; i++) match.tick();
    assert.equal([...match.world.ofKind("bullet")].length, 1, "no extra bullets");
    assert.ok(ship.vel.length() > 0, "thrust kept going");
  });

  test("stats expose tick duration and jitter", () => {
    const { match } = setup();
    match.tick();
    const s = match.stats();
    assert.equal(s.players, 1);
    assert.ok(s.tickMs.p99 >= 0);
  });
});
