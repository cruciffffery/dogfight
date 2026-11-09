/**
 * Клієнтське з'єднання з сервером.
 *   - диспетчеризація за типом: conn.on("roster", fn) → подія "msg:<type>"
 *   - текстові кадри — JSON; бінарні — знімки (decodeSnapshot), binaryType = "arraybuffer"
 *   - черга відправки, поки сокет відкривається
 *   - перепідключення з експоненційною затримкою і джитером
 *   - лічильники байтів (для netgraph)
 *   - ІНЖЕКТОР мережевих умов: затримка, джитер, втрата пакетів (Лаба 5)
 *
 * Події: "open", "close" (detail: { code, reason, willRetry, delay }), "msg:<type>".
 */
import { decodeSnapshot } from "@dogfight/shared/codec/binary.js";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/messages.js";

const FATAL_CODES = new Set([4001, 4003, 4004, 4006]);

export class Connection extends EventTarget {
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = 0;
  #closedByUser = false;
  #lastOut = 0;
  #lastIn = 0;

  constructor(url, { maxQueue = 100, baseDelay = 500, maxDelay = 10000 } = {}) {
    super();
    this.url = url;
    this.maxQueue = maxQueue;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    /**
     * Симуляція поганої мережі. latency — додатковий RTT (по половині в кожен бік),
     * jitter — ± до кожного напрямку, drop — частка втрачених НЕНАДІЙНИХ повідомлень
     * (знімки й input; чат, join і pong не губляться). Порядок доставки зберігається,
     * як у TCP: повідомлення не обганяють одне одного.
     */
    this.netsim = { latency: 0, jitter: 0, drop: 0 };
    this.bytes = { in: 0, out: 0 };
  }

  static defaultUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #delay(direction) {
    const { latency, jitter } = this.netsim;
    if (!latency && !jitter) return 0;
    const ms = Math.max(0, latency / 2 + (Math.random() * 2 - 1) * jitter);
    const now = performance.now();
    const prev = direction === "out" ? this.#lastOut : this.#lastIn;
    const at = Math.max(prev, now + ms); // без перестановок
    if (direction === "out") this.#lastOut = at;
    else this.#lastIn = at;
    return at - now;
  }

  #through(direction, unreliable, fn) {
    if (unreliable && this.netsim.drop > 0 && Math.random() < this.netsim.drop) return;
    const ms = this.#delay(direction);
    if (ms > 0) setTimeout(fn, ms);
    else fn();
  }

  connect() {
    this.#closedByUser = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#attempt = 0;
      this.dispatchEvent(new Event("open"));
      for (const data of this.#queue.splice(0)) this.#rawSend(data, false);
    });
    ws.addEventListener("message", (e) => {
      const binary = typeof e.data !== "string";
      this.bytes.in += binary ? e.data.byteLength : e.data.length;
      let msg;
      try {
        msg = binary ? { type: "snapshot", ...decodeSnapshot(e.data) } : JSON.parse(e.data);
      } catch (err) {
        console.warn("[net] bad frame from server:", err.message);
        return;
      }
      if (typeof msg?.type !== "string") return;
      this.#through("in", msg.type === "snapshot", () => {
        this.dispatchEvent(new CustomEvent(`msg:${msg.type}`, { detail: msg }));
      });
    });
    ws.addEventListener("close", (e) => {
      const willRetry = !this.#closedByUser && !FATAL_CODES.has(e.code);
      const delay = willRetry ? this.#nextDelay() : 0;
      this.dispatchEvent(
        new CustomEvent("close", { detail: { code: e.code, reason: e.reason, willRetry, delay } }),
      );
      if (willRetry) this.#timer = setTimeout(() => this.connect(), delay);
    });
    return this;
  }

  #nextDelay() {
    const exp = Math.min(this.maxDelay, this.baseDelay * 2 ** this.#attempt);
    this.#attempt += 1;
    return Math.round(exp * (0.5 + Math.random()));
  }

  #rawSend(data, unreliable) {
    this.#through("out", unreliable, () => {
      if (!this.isOpen) return;
      this.bytes.out += typeof data === "string" ? data.length : data.byteLength;
      this.#ws.send(data);
    });
  }

  /** JSON-повідомлення; якщо сокет ще не відкритий — у чергу. */
  send(msg) {
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
    if (this.isOpen) this.#rawSend(data, msg.type === "input");
    else if (this.#queue.length < this.maxQueue) this.#queue.push(data);
  }

  /** Ненадійне бінарне повідомлення (input): не ставиться в чергу — застаріле не потрібне. */
  sendBinary(buffer) {
    if (this.isOpen) this.#rawSend(buffer, true);
  }

  on(type, fn) {
    const listener = (e) => fn(e.detail);
    this.addEventListener(`msg:${type}`, listener);
    return () => this.removeEventListener(`msg:${type}`, listener);
  }

  once(type, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const off = this.on(type, (msg) => {
        clearTimeout(timer);
        off();
        resolve(msg);
      });
    });
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "bye");
  }
}
