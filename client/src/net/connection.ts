/**
 * Клієнтське з'єднання з сервером: типізовані події, бінарні знімки, черга, reconnect,
 * лічильники байтів і інжектор мережевих умов (Лаба 5).
 *
 * Події (Bus<ConnectionEvents>): "open", "close" і по одній на КОЖЕН тип повідомлення
 * сервера — conn.on("roster", (m) => m.players) знає точний тип m.
 */
import { Bus } from "@dogfight/shared/bus.ts";
import { decodeSnapshot } from "@dogfight/shared/codec/binary.ts";
import {
  type OutgoingClientMessage,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
} from "@dogfight/shared/protocol.ts";
import { assertNever } from "@dogfight/shared/types.ts";
import { measure } from "../perf.ts";

const FATAL_CODES = new Set([4001, 4003, 4004, 4006]);

export interface CloseInfo {
  code: number;
  reason: string;
  willRetry: boolean;
  delay: number;
}

export type ConnectionEvents = { [K in ServerMessageType]: ServerMessageOf<K> } & {
  open: undefined;
  close: CloseInfo;
};

export interface NetSim {
  latency: number;
  jitter: number;
  drop: number;
}

export class Connection extends Bus<ConnectionEvents> {
  #ws: WebSocket | null = null;
  #queue: string[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closedByUser = false;
  #lastOut = 0;
  #lastIn = 0;
  readonly url: string;
  readonly maxQueue: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  netsim: NetSim = { latency: 0, jitter: 0, drop: 0 };
  readonly bytes = { in: 0, out: 0 };

  constructor(url: string, { maxQueue = 100, baseDelay = 500, maxDelay = 10000 } = {}) {
    super();
    this.url = url;
    this.maxQueue = maxQueue;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
  }

  static defaultUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #delay(direction: "in" | "out"): number {
    const { latency, jitter } = this.netsim;
    if (!latency && !jitter) return 0;
    const ms = Math.max(0, latency / 2 + (Math.random() * 2 - 1) * jitter);
    const now = performance.now();
    const prev = direction === "out" ? this.#lastOut : this.#lastIn;
    const at = Math.max(prev, now + ms);
    if (direction === "out") this.#lastOut = at;
    else this.#lastIn = at;
    return at - now;
  }

  #through(direction: "in" | "out", unreliable: boolean, fn: () => void): void {
    if (unreliable && this.netsim.drop > 0 && Math.random() < this.netsim.drop) return;
    const ms = this.#delay(direction);
    if (ms > 0) setTimeout(fn, ms);
    else fn();
  }

  /** Вичерпна диспетчеризація: новий тип повідомлення без гілки тут — помилка компіляції. */
  #dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.emit("welcome", msg);
        return;
      case "roster":
        this.emit("roster", msg);
        return;
      case "chat":
        this.emit("chat", msg);
        return;
      case "pong":
        this.emit("pong", msg);
        return;
      case "error":
        this.emit("error", msg);
        return;
      case "shutdown":
        this.emit("shutdown", msg);
        return;
      case "snapshot":
        this.emit("snapshot", msg);
        return;
      default:
        assertNever(msg, "server message");
    }
  }

  #decode(data: unknown): ServerMessage | null {
    if (data instanceof ArrayBuffer) {
      this.bytes.in += data.byteLength;
      try {
        return {
          v: PROTOCOL_VERSION,
          type: "snapshot",
          ...measure("decode", () => decodeSnapshot(data)),
        };
      } catch (err: unknown) {
        console.warn("[net] bad binary frame:", err instanceof Error ? err.message : err);
        return null;
      }
    }
    if (typeof data === "string") this.bytes.in += data.length;
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      console.warn("[net] bad frame from server:", parsed.error);
      return null;
    }
    return parsed.value;
  }

  connect(): this {
    this.#closedByUser = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#attempt = 0;
      this.emit("open", undefined);
      for (const data of this.#queue.splice(0)) this.#rawSend(data, false);
    });
    ws.addEventListener("message", (e: MessageEvent<unknown>) => {
      const msg = this.#decode(e.data);
      if (msg) this.#through("in", msg.type === "snapshot", () => this.#dispatch(msg));
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      const willRetry = !this.#closedByUser && !FATAL_CODES.has(e.code);
      const delay = willRetry ? this.#nextDelay() : 0;
      this.emit("close", { code: e.code, reason: e.reason, willRetry, delay });
      if (willRetry) this.#timer = setTimeout(() => this.connect(), delay);
    });
    return this;
  }

  #nextDelay(): number {
    const exp = Math.min(this.maxDelay, this.baseDelay * 2 ** this.#attempt);
    this.#attempt += 1;
    return Math.round(exp * (0.5 + Math.random()));
  }

  #rawSend(data: string | ArrayBuffer, unreliable: boolean): void {
    this.#through("out", unreliable, () => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
      this.bytes.out += typeof data === "string" ? data.length : data.byteLength;
      this.#ws.send(data);
    });
  }

  /** JSON-повідомлення, тип перевіряє компілятор (OutgoingClientMessage з zod-схеми). */
  send(msg: OutgoingClientMessage): void {
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
    if (this.isOpen) this.#rawSend(data, msg.type === "input");
    else if (this.#queue.length < this.maxQueue) this.#queue.push(data);
  }

  sendBinary(buffer: ArrayBuffer): void {
    if (this.isOpen) this.#rawSend(buffer, true);
  }

  close(): void {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "bye");
  }
}
