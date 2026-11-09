import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSnapshot } from "@dogfight/shared/codec/binary.js";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { createGameServer, listen } from "../src/index.js";

export const quietLog = { info() {}, warn() {}, error() {} };

/** Сервер на випадковому порту з тимчасовою текою журналів. */
export async function startTestServer(env = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "dogfight-test-"));
  const config = loadConfig({ PORT: "0", HOST: "127.0.0.1", LOG_DIR: logDir, ...env });
  const game = createGameServer(config, quietLog);
  const { port } = await listen(game);
  return {
    ...game,
    logDir,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

/** WebSocket-клієнт, що складає повідомлення в масив і вміє їх чекати. */
export function connect(url, options) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    const msg = isBinary
      ? { type: "snapshot", ...decodeSnapshot(data) }
      : JSON.parse(data.toString());
    if (msg.type === "snapshot" && inbox.filter((m) => m.type === "snapshot").length > 50) {
      inbox.splice(
        inbox.findIndex((m) => m.type === "snapshot"),
        1,
      ); // не накопичувати тисячі знімків
    }
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const closed = new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  ws.on("error", () => {});
  return {
    ws,
    inbox,
    closed,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send: (msg) => ws.send(JSON.stringify({ v: 1, ...msg })),
    waitFor(type, pred = () => true, timeoutMs = 2000) {
      const match = (m) => m.type === type && pred(m);
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      });
    },
  };
}
