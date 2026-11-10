/**
 * Хаос (Лаба 8, M2): сервер убивають посеред матчу і піднімають знову.
 * Клієнт має: показати зрозуміле повідомлення, перепідключитись з backoff і знову
 * опинитись у грі (кімнати alpha/rocks/duel постійні, тож повертаємось у ту саму).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { expect, test } from "@playwright/test";

const PORT = 8097;
const base = `http://localhost:${PORT}`;

function startServer(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["server/src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LOG_LEVEL: "warn",
      LOG_DIR: "test-results/chaos-logs",
    },
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = (): void => {
      fetch(`${base}/ready`).then(
        (r) => (r.ok ? resolve(proc) : setTimeout(poll, 100)),
        () =>
          Date.now() - t0 > 10_000
            ? reject(new Error("server did not start"))
            : setTimeout(poll, 100),
      );
    };
    poll();
  });
}

const exited = (p: ChildProcess) =>
  new Promise<number | null>((resolve) => p.once("exit", (code) => resolve(code)));

test("server killed mid-match → client says so, reconnects with backoff, plays again", async ({
  page,
}) => {
  let server = await startServer();
  await page.goto(`${base}/?room=alpha&name=Chaos&fast`);
  await page.waitForFunction(() => window.__lab.game !== undefined && window.__lab.conn?.isOpen);
  await page.evaluate(() => {
    window.__lab.welcomes = 1;
    window.__lab.conn?.on("welcome", () => {
      window.__lab.welcomes = (window.__lab.welcomes ?? 0) + 1;
    });
  });

  // SIGTERM: сервер має попередити клієнтів і вийти з кодом 0 швидко
  const t0 = Date.now();
  server.kill("SIGTERM");
  expect(await exited(server)).toBe(0);
  expect(Date.now() - t0).toBeLessThan(5000);

  await expect(page.locator(".room-ui")).toContainText("Сервер перезапускається");
  await expect(page.locator(".room-ui")).toContainText("Повтор через");

  server = await startServer();
  await page.waitForFunction(() => (window.__lab.welcomes ?? 0) >= 2, undefined, {
    timeout: 15_000,
  });
  await expect(page.locator(".room-ui .roster")).toContainText("Chaos");
  server.kill("SIGTERM");
  await exited(server);
});
