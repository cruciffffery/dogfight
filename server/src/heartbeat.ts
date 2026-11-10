/**
 * Heartbeat: кожні intervalMs — ping усім; хто пропустив maxMissed відповідей поспіль,
 * той мертвий (terminate). Окремий модуль — щоб тестувати його фейковими таймерами.
 */
export interface HeartbeatState {
  missedPongs: number;
}

export interface HeartbeatOptions<C> {
  intervalMs: number;
  maxMissed?: number;
  clients: () => Iterable<C>;
  state: (client: C) => HeartbeatState | undefined;
  ping: (client: C) => void;
  kill: (client: C) => void;
}

/** @returns функція зупинки */
export function startHeartbeat<C>({
  intervalMs,
  maxMissed = 2,
  clients,
  state,
  ping,
  kill,
}: HeartbeatOptions<C>): () => void {
  const timer = setInterval(() => {
    for (const client of clients()) {
      const s = state(client);
      if (!s) continue;
      if (s.missedPongs >= maxMissed) {
        kill(client);
        continue;
      }
      s.missedPongs += 1;
      ping(client);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
