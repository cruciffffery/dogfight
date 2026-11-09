/**
 * Чому кожен сокет мусить мати слухача "error" (Лаба 4, M4).
 *
 *   node scripts/crash-demo.js
 *
 * Запускає сервер двічі: з DEMO_NO_ERROR_LISTENER=1 і без нього. В обох випадках
 * «зловмисник» шле кадр, більший за maxPayload, а «гравець» у сусідній кімнаті просто чатиться.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { WebSocket } from "ws";

async function run(label, env) {
  const port = 8097;
  console.log(`\n===== ${label} =====`);
  const server = spawn(process.execPath, ["src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), LOG_DIR: "/tmp/dogfight-crash-demo", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const exited = once(server, "exit").then(([code]) => code);
  await new Promise((r) => setTimeout(r, 500));

  const player = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  player.on("error", () => {});
  await once(player, "open");
  player.send(JSON.stringify({ v: 0, type: "join", room: "rocks", name: "Innocent" }));

  const attacker = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  attacker.on("error", () => {});
  await once(attacker, "open");
  attacker.send("x".repeat(64 * 1024)); // > maxPayload (4 КБ)

  await new Promise((r) => setTimeout(r, 500));
  const health = await fetch(`http://127.0.0.1:${port}/health`)
    .then((r) => `${r.status} ${r.statusText}`)
    .catch((e) => `недоступний (${e.cause?.code ?? e.message})`);
  console.log(log.trim().split("\n").slice(0, 14).join("\n"));
  console.log(`--- /health після атаки: ${health}`);
  console.log(
    `--- з'єднання невинного гравця: ${player.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED"}`,
  );
  server.kill();
  console.log(`--- код виходу процесу: ${await exited}`);
}

await run("БЕЗ слухача 'error' на сокеті", { DEMO_NO_ERROR_LISTENER: "1" });
await run("З слухачем 'error' (як у коді сервера)", {});
