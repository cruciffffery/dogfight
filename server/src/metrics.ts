/**
 * /metrics у форматі Prometheus (prom-client) — Лаба 8.
 *
 * Значення не дублюємо: метрики ЗЧИТУЮТЬ наявні лічильники (`Counters` з ws.ts, `Match.stats()`)
 * у момент скрейпу (`collect`). msg/s і bytes/s Prometheus рахує сам: rate(dogfight_messages_in_total[1m]).
 */
import { performance } from "node:perf_hooks";
import { Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";
import type { MatchStats } from "./match.ts";
import type { Counters } from "./ws.ts";

export interface MetricsSource {
  counters: Counters;
  rooms: () => number;
  players: () => number;
  matches: () => MatchStats[];
  version: string;
}

/** Counter, значення якого береться з зовнішнього лічильника під час скрейпу. */
function mirroredCounter(registry: Registry, name: string, help: string, read: () => number): void {
  new Counter({
    name,
    help,
    registers: [registry],
    collect() {
      this.reset();
      this.inc(read());
    },
  });
}

export function createMetrics(src: MetricsSource): Registry {
  const registry = new Registry();
  // процесні: RSS (process_resident_memory_bytes), CPU, heap, GC, event loop lag
  collectDefaultMetrics({ register: registry, prefix: "dogfight_" });

  new Gauge({
    name: "dogfight_build_info",
    help: "Version stamp (git SHA / tag) of the running build",
    labelNames: ["version"],
    registers: [registry],
    collect() {
      this.set({ version: src.version }, 1);
    },
  });
  new Gauge({
    name: "dogfight_players",
    help: "Players currently in rooms",
    registers: [registry],
    collect() {
      this.set(src.players());
    },
  });
  new Gauge({
    name: "dogfight_rooms",
    help: "Open rooms",
    registers: [registry],
    collect() {
      this.set(src.rooms());
    },
  });
  new Gauge({
    name: "dogfight_connections",
    help: "Open WebSocket connections",
    registers: [registry],
    collect() {
      this.set(src.counters.connections);
    },
  });

  const c = src.counters;
  mirroredCounter(registry, "dogfight_messages_in_total", "Messages received", () => c.messagesIn);
  mirroredCounter(registry, "dogfight_messages_out_total", "Messages sent", () => c.messagesOut);
  mirroredCounter(registry, "dogfight_bytes_in_total", "Bytes received", () => c.bytesIn);
  mirroredCounter(registry, "dogfight_bytes_out_total", "Bytes sent", () => c.bytesOut);
  mirroredCounter(registry, "dogfight_bad_messages_total", "Invalid frames", () => c.badMessages);
  mirroredCounter(
    registry,
    "dogfight_dropped_total",
    "Snapshots dropped (slow clients)",
    () => c.dropped,
  );

  new Counter({
    name: "dogfight_rejections_total",
    help: "Connections rejected or closed by the server, by reason",
    labelNames: ["reason"],
    registers: [registry],
    collect() {
      this.reset();
      for (const [reason, n] of Object.entries(c.rejected)) this.inc({ reason }, n);
    },
  });

  const tick = new Gauge({
    name: "dogfight_tick_ms",
    help: "Server tick duration per room over the last window (ms)",
    labelNames: ["room", "quantile"],
    registers: [registry],
    collect() {
      this.reset();
      for (const m of src.matches()) {
        tick.set({ room: m.room, quantile: "0.5" }, m.tickMs.p50);
        tick.set({ room: m.room, quantile: "0.99" }, m.tickMs.p99);
      }
    },
  });

  let prev = performance.eventLoopUtilization();
  new Gauge({
    name: "dogfight_event_loop_utilization",
    help: "Event loop utilization (0..1) since the previous scrape",
    registers: [registry],
    collect() {
      const now = performance.eventLoopUtilization();
      this.set(performance.eventLoopUtilization(now, prev).utilization);
      prev = now;
    },
  });

  return registry;
}
