/**
 * Клієнтське з'єднання з сервером.
 *   - диспетчеризація за типом: conn.on("roster", fn) → подія "msg:roster"
 *   - черга відправки, поки сокет відкривається (і після розриву — до повторного з'єднання)
 *   - автоматичне перепідключення з експоненційною затримкою і джитером
 *
 * Події: "open", "close" (detail: { code, reason, willRetry, delay }), "msg:<type>".
 */
const FATAL_CODES = new Set([4001, 4003, 4004, 4006]); // повтор нічого не змінить

export class Connection extends EventTarget {
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = 0;
  #closedByUser = false;

  constructor(url, { maxQueue = 100, baseDelay = 500, maxDelay = 10000 } = {}) {
    super();
    this.url = url;
    this.maxQueue = maxQueue;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
  }

  static defaultUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.#closedByUser = false;
    const ws = new WebSocket(this.url);
    this.#ws = ws;
    ws.addEventListener("open", () => {
      this.#attempt = 0;
      this.dispatchEvent(new Event("open"));
      // черга: усе, що «надіслали» поки сокет не був готовий
      for (const data of this.#queue.splice(0)) ws.send(data);
    });
    ws.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        console.warn("[net] invalid JSON from server");
        return;
      }
      if (typeof msg?.type !== "string") return;
      this.dispatchEvent(new CustomEvent(`msg:${msg.type}`, { detail: msg }));
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

  /** Відправити повідомлення; якщо сокет ще не відкритий — поставити в чергу. */
  send(msg) {
    const data = JSON.stringify({ v: 0, ...msg });
    if (this.isOpen) this.#ws.send(data);
    else if (this.#queue.length < this.maxQueue) this.#queue.push(data);
  }

  on(type, fn) {
    const listener = (e) => fn(e.detail);
    this.addEventListener(`msg:${type}`, listener);
    return () => this.removeEventListener(`msg:${type}`, listener);
  }

  /** Подія → проміс з таймаутом. */
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
