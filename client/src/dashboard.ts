/**
 * Живий дашборд сервера (Лаба 8): /dashboard.html читає /api/stats кожні 2 с і малює
 * спарклайни за останні 5 хвилин. Для Prometheus/Grafana є /metrics — це «дашборд без інфраструктури».
 */
import { z } from "zod";

const StatsSchema = z.object({
  players: z.number(),
  rooms: z.number(),
  connections: z.number(),
  messagesIn: z.number(),
  messagesOut: z.number(),
  bytesIn: z.number(),
  bytesOut: z.number(),
  rss: z.number(),
  elu: z.number(),
  uptime: z.number(),
  version: z.string().optional(),
  rejected: z.record(z.string(), z.number()),
  matches: z.array(
    z.object({
      room: z.string(),
      players: z.number(),
      entities: z.number(),
      tickMs: z.object({ p50: z.number(), p99: z.number() }),
      jitterMs: z.object({ p99: z.number() }),
    }),
  ),
});
type Stats = z.infer<typeof StatsSchema>;

const PERIOD_MS = 2000;
const HISTORY = 150; // 5 хв

interface Series {
  label: string;
  unit: string;
  value: (s: Stats, prev: Stats | null, dt: number) => number;
  warnAbove?: number;
}

const series: Series[] = [
  { label: "Гравців", unit: "", value: (s) => s.players },
  { label: "З'єднань", unit: "", value: (s) => s.connections },
  {
    label: "Повідомлень/с (вхід)",
    unit: "",
    value: (s, p, dt) => (p ? (s.messagesIn - p.messagesIn) / dt : 0),
  },
  {
    label: "Вихідний трафік",
    unit: "КБ/с",
    value: (s, p, dt) => (p ? (s.bytesOut - p.bytesOut) / dt / 1024 : 0),
  },
  {
    label: "Tick p99 (макс. по кімнатах)",
    unit: "мс",
    value: (s) => Math.max(0, ...s.matches.map((m) => m.tickMs.p99)),
    warnAbove: 16,
  },
  { label: "Event loop utilization", unit: "%", value: (s) => s.elu * 100, warnAbove: 70 },
  { label: "RSS", unit: "МБ", value: (s) => s.rss / 2 ** 20 },
];

const tiles = document.getElementById("tiles");
const meta = document.getElementById("meta");
const roomsBody = document.getElementById("rooms");
const rejectedBody = document.getElementById("rejected");
const history = series.map(() => [] as number[]);
const views = series.map((s) => {
  const tile = document.createElement("div");
  tile.className = "tile";
  const value = document.createElement("b");
  const label = document.createElement("span");
  label.textContent = s.unit ? `${s.label}, ${s.unit}` : s.label;
  const canvas = document.createElement("canvas");
  tile.append(value, label, canvas);
  tiles?.append(tile);
  return { value, canvas };
});

function spark(canvas: HTMLCanvasElement, data: readonly number[], warn?: number): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx || data.length < 2) return;
  const max = Math.max(...data, warn ?? 0, 1e-9);
  ctx.strokeStyle = warn !== undefined && (data.at(-1) ?? 0) > warn ? "#ffb020" : "#4da3ff";
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * canvas.width;
    const y = canvas.height - (v / max) * (canvas.height - 2 * dpr) - dpr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function row(cells: (string | number)[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = String(c);
    tr.append(td);
  }
  return tr;
}

let prev: Stats | null = null;
let prevAt = 0;
async function poll(): Promise<void> {
  try {
    const res = await fetch("/api/stats", { signal: AbortSignal.timeout(1500), cache: "no-store" });
    const stats = StatsSchema.parse(await res.json());
    const now = performance.now();
    const dt = prev ? (now - prevAt) / 1000 : 1;
    series.forEach((s, i) => {
      const v = s.value(stats, prev, dt);
      const h = history[i];
      const view = views[i];
      if (!h || !view) return;
      h.push(v);
      if (h.length > HISTORY) h.shift();
      view.value.textContent = Number.isInteger(v) || v >= 100 ? v.toFixed(0) : v.toFixed(1);
      spark(view.canvas, h, s.warnAbove);
    });
    if (meta) {
      meta.className = "meta";
      meta.textContent = `версія ${stats.version ?? "?"} · працює ${Math.round(stats.uptime / 60)} хв · кімнат ${stats.rooms} · оновлення кожні ${PERIOD_MS / 1000} с`;
    }
    roomsBody?.replaceChildren(
      ...stats.matches.map((m) =>
        row([
          m.room,
          m.players,
          m.entities,
          m.tickMs.p50.toFixed(2),
          m.tickMs.p99.toFixed(2),
          m.jitterMs.p99.toFixed(2),
        ]),
      ),
    );
    const rejected = Object.entries(stats.rejected).sort((a, b) => b[1] - a[1]);
    rejectedBody?.replaceChildren(
      ...(rejected.length ? rejected.map(([k, v]) => row([k, v])) : [row(["—", 0])]),
    );
    prev = stats;
    prevAt = now;
  } catch (err: unknown) {
    if (meta) {
      meta.className = "meta down";
      meta.textContent = `сервер не відповідає: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

void poll();
setInterval(() => void poll(), PERIOD_MS);
