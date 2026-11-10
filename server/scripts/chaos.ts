/**
 * Хаос-тест (Лаба 8, M2) з метрикою ізоляції.
 *
 *   node server/scripts/chaos.ts      → docs/lab-08/chaos.json
 *
 * Кімната "rocks": 8 серверних ботів + 1 справжній WS-гравець. Три фази по SECONDS:
 *   baseline — тиша;
 *   flood    — 20 «зловмисників» шлють сміттєві кадри (кожен сокет: пачка → закриття 4001 →
 *              одразу перепідключення), ціль ≥ 1000 кадрів/с;
 *   kill     — гравця вбиваємо посеред матчу (terminate без close-кадру).
 * Для кожної фази: tick p99 кімнати rocks з /api/stats, приріст rejections з /metrics, ELU.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const SECONDS = Number(process.env.SECONDS ?? 10);
const PORT = 8300;
const ROOT = join(import.meta.dirname, "..", "..");
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["server/src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_LEVEL: "warn",
    LOG_DIR: "/tmp/dogfight-chaos",
    MAX_CONNECTIONS_PER_IP: "64",
    MAX_PLAYERS_PER_ROOM: "16",
    CONNECT_BURST_PER_IP: "40",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) {
  if (
    await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await sleep(100);
}
await fetch(`${base}/api/rooms/rocks/bots`, { method: "POST", body: JSON.stringify({ count: 8 }) });

const player = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r) => player.once("open", r));
player.send(JSON.stringify({ v: 1, type: "join", room: "rocks", name: "victim", codec: "binary" }));
let snapshots = 0;
player.on("message", (_d, bin) => {
  if (bin) snapshots++;
});

interface Stats {
  elu: number;
  players: number;
  matches: { room: string; tickMs: { p99: number }; tick: number }[];
}
const stats = async () => (await fetch(`${base}/api/stats`)).json() as Promise<Stats>;
const rejections = async () => {
  const text = await (await fetch(`${base}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^dogfight_rejections_total\{reason="(\w+)"\} (\d+)/gm))
    out[m[1] ?? "?"] = Number(m[2]);
  return out;
};

async function phase(name: string, during: (stop: () => boolean) => Promise<unknown>) {
  await stats(); // скинути вікно ELU
  const r0 = await rejections();
  const s0 = await stats();
  let done = false;
  const work = during(() => done);
  await sleep(SECONDS * 1000);
  done = true;
  const extra = await work;
  const s1 = await stats();
  const r1 = await rejections();
  const rocks = s1.matches.find((m) => m.room === "rocks");
  const delta = Object.fromEntries(
    Object.entries(r1)
      .map(([k, v]) => [k, v - (r0[k] ?? 0)])
      .filter(([, v]) => Number(v) > 0),
  );
  const row = {
    phase: name,
    rocksTickP99: rocks?.tickMs.p99,
    rocksTicks: (rocks?.tick ?? 0) - (s0.matches.find((m) => m.room === "rocks")?.tick ?? 0),
    elu: s1.elu,
    players: s1.players,
    rejections: delta,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
  console.log(JSON.stringify(row));
  return row;
}

const rows = [];
rows.push(await phase("baseline", async () => undefined));

rows.push(
  await phase("flood", async (stop) => {
    let frames = 0;
    let sockets = 0;
    const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const attacker = async () => {
      while (!stop()) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
        ws.on("error", () => {});
        sockets++;
        await new Promise<void>((resolve) => {
          ws.once("open", () => {
            for (let i = 0; i < 50 && ws.readyState === WebSocket.OPEN; i++) {
              ws.send(junk);
              frames++;
            }
          });
          ws.once("close", () => resolve());
          ws.once("unexpected-response", () => resolve());
        });
      }
    };
    await Promise.all(Array.from({ length: 20 }, attacker));
    return {
      garbageFramesSentPerSec: Math.round(frames / SECONDS),
      attackerConnectAttemptsPerSec: Math.round(sockets / SECONDS),
    };
  }),
);

rows.push(
  await phase("kill-client", async () => {
    const before = (await stats()).players;
    player.terminate(); // «висмикнули кабель»: без close-кадру
    await sleep(1000);
    return {
      playersBefore: before,
      playersAfter1s: (await stats()).players,
      victimSnapshots: snapshots,
    };
  }),
);

server.kill("SIGTERM");
const out = join(ROOT, "docs", "lab-08");
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "chaos.json"),
  `${JSON.stringify({ seconds: SECONDS, node: process.version, rows }, null, 2)}\n`,
);
