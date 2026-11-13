/**
 * Кросплатформний `npm run dev`: сервер (node --watch) + Vite у двох дочірніх процесах.
 * (`a & b` у package.json не працює однаково в cmd.exe і bash.)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";

// server/.env потрібен для `node --env-file=.env`; при першому запуску беремо приклад
const envFile = new URL("../server/.env", import.meta.url);
if (!existsSync(envFile)) {
  copyFileSync(new URL("../server/.env.example", import.meta.url), envFile);
  console.log("[dev] створено server/.env з server/.env.example");
}

// Порт сервера — з server/.env (PORT=…), щоб Vite проксіював /api і /ws саме туди.
// Якщо 8080 зайнятий (наприклад, Apache з XAMPP), достатньо змінити PORT у server/.env.
const port = /^\s*PORT\s*=\s*(\d+)/m.exec(readFileSync(envFile, "utf8"))?.[1] ?? "8080";
const serverUrl = process.env.SERVER_URL ?? `http://127.0.0.1:${port}`;
console.log(`[dev] сервер гри: ${serverUrl} · клієнт: http://localhost:5173`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npm, ["run", "dev", "-w", "server"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn(npm, ["run", "dev", "-w", "client"], {
    env: { ...process.env, SERVER_URL: serverUrl },
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && stop());
