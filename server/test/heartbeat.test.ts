import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type HeartbeatState, startHeartbeat } from "../src/heartbeat.ts";

interface FakeSocket extends HeartbeatState {
  name: string;
  answers: boolean;
  pings: number;
  dead: boolean;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(intervalMs = 15_000) {
  const sockets: FakeSocket[] = [
    { name: "alive", answers: true, pings: 0, dead: false, missedPongs: 0 },
    { name: "ghost", answers: false, pings: 0, dead: false, missedPongs: 0 },
  ];
  const stop = startHeartbeat<FakeSocket>({
    intervalMs,
    clients: () => sockets.filter((s) => !s.dead),
    state: (s) => s,
    ping: (s) => {
      s.pings += 1;
      if (s.answers) queueMicrotask(() => (s.missedPongs = 0)); // «pong» приходить одразу
    },
    kill: (s) => {
      s.dead = true;
    },
  });
  return { sockets, stop };
}

describe("heartbeat (fake timers)", () => {
  test("a socket that answers pongs is never killed", async () => {
    const { sockets, stop } = setup();
    await vi.advanceTimersByTimeAsync(15_000 * 20);
    stop();
    expect(sockets[0]?.dead).toBe(false);
    expect(sockets[0]?.pings).toBe(20);
  });

  test("a silent socket is terminated after missing two pongs (third interval)", async () => {
    const { sockets, stop } = setup();
    await vi.advanceTimersByTimeAsync(15_000 * 2);
    expect(sockets[1]?.dead).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[1]?.dead).toBe(true);
    expect(sockets[1]?.pings).toBe(2);
    stop();
  });

  test("stop() halts pinging", async () => {
    const { sockets, stop } = setup(1000);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]?.pings).toBe(0);
  });
});
