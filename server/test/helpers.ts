import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSnapshot } from "@dogfight/shared/codec/binary.ts";
import { type ClientOptions, type RawData, WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { createGameServer, listen } from "../src/index.ts";
import { silentLogger } from "../src/logger.ts";

export const quietLog = silentLogger;

/** Сервер на випадковому порту з тимчасовою текою журналів. */
export async function startTestServer(env: Record<string, string> = {}) {
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

/** Повідомлення сервера в тестах — JSON-об'єкти з полем type. */
export type Msg = { type: string } & Record<string, unknown>;

interface Waiter {
  match: (m: Msg) => boolean;
  resolve: (m: Msg) => void;
}

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function parseText(text: string): Msg {
  const value: unknown = JSON.parse(text);
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  ) {
    return { ...value, type: value.type };
  }
  throw new Error(`unexpected message ${text}`);
}

/** WebSocket-клієнт, що складає повідомлення в масив і вміє їх чекати. */
export function connect(url: string, options?: ClientOptions) {
  const ws = new WebSocket(url, options);
  const inbox: Msg[] = [];
  const waiters: Waiter[] = [];
  ws.on("message", (data: RawData, isBinary: boolean) => {
    const bytes = bytesOf(data);
    const msg: Msg = isBinary
      ? { type: "snapshot", ...decodeSnapshot(bytes) }
      : parseText(Buffer.from(bytes).toString("utf8"));
    if (msg.type === "snapshot" && inbox.filter((m) => m.type === "snapshot").length > 50) {
      inbox.splice(
        inbox.findIndex((m) => m.type === "snapshot"),
        1,
      );
    }
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
  });
  ws.on("error", () => {});
  return {
    ws,
    inbox,
    closed,
    opened: new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    }),
    send: (msg: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...msg })),
    waitFor(type: string, pred: (m: Msg) => boolean = () => true, timeoutMs = 2000): Promise<Msg> {
      const match = (m: Msg): boolean => m.type === type && pred(m);
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise<Msg>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          match,
          resolve: (m: Msg) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      });
    },
  };
}
