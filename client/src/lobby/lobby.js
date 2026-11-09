/**
 * Лобі — модель без DOM. Спілкується з рештою через події (EventTarget):
 *   "loading"  — почався запит
 *   "rooms"    — detail: Room[]
 *   "error"    — detail: Error (запит упав або вийшов таймаут)
 *   "join"     — detail: { room, arena, name }
 *   "left"     — лобі закрито
 *
 * Рендеринг живе окремо (view.js) і лише слухає ці події.
 */
import { fetchJson, withRetry } from "../assets/loader.js";

export class Lobby extends EventTarget {
  #controller = null; // AbortController поточного запиту
  #timer = 0;
  #active = false;

  constructor({ roomsUrl = "/api/rooms", arenaUrl = (id) => `/assets/arenas/${id}.json` } = {}) {
    super();
    this.roomsUrl = roomsUrl;
    this.arenaUrl = arenaUrl;
    this.rooms = [];
    this.refreshMs = 5000;
    this.timeoutMs = 3000;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Запускає періодичне оновлення, поки лобі на екрані. */
  start() {
    if (this.#active) return;
    this.#active = true;
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.refreshMs);
  }

  /** Одне оновлення списку кімнат. Попередній незавершений запит скасовується. */
  async refresh() {
    this.#controller?.abort(new DOMException("superseded", "AbortError"));
    const controller = new AbortController();
    this.#controller = controller;
    this.#emit("loading");
    try {
      const rooms = await fetchJson(this.roomsUrl, {
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
      });
      if (!Array.isArray(rooms)) throw new TypeError("rooms: expected an array");
      this.rooms = rooms;
      this.#emit("rooms", rooms);
    } catch (err) {
      if (controller.signal.aborted) return; // нас скасували навмисно — це не помилка
      this.#emit("error", err);
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  /** Вибір кімнати: підвантажити конфіг арени (з повторами) і повідомити гру. */
  async join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new RangeError(`Unknown room: ${roomId}`);
    const controller = new AbortController();
    this.#controller?.abort();
    this.#controller = controller;
    try {
      const arena = await withRetry(
        () =>
          fetchJson(this.arenaUrl(room.arena), {
            signal: controller.signal,
            timeoutMs: this.timeoutMs,
          }),
        { signal: controller.signal, attempts: 3 },
      );
      this.leave();
      this.#emit("join", { room, arena, name });
      return room;
    } catch (err) {
      if (!controller.signal.aborted) this.#emit("error", err);
    }
  }

  /** Вийти з лобі: зупинити таймер і скасувати запит у польоті — без «осиротілих» запитів. */
  leave() {
    clearInterval(this.#timer);
    this.#timer = 0;
    this.#controller?.abort(new DOMException("left lobby", "AbortError"));
    this.#controller = null;
    if (this.#active) {
      this.#active = false;
      this.#emit("left");
    }
  }

  /** Створити кімнату на сервері (POST /api/rooms) і оновити список. */
  async createRoom(name, arena = "classic") {
    const response = await fetch(this.roomsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arena }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    await this.refresh();
    return body;
  }

  /** Подію → проміс: зручно для async-коду, що «чекає вибору кімнати». */
  waitForJoin() {
    return new Promise((resolve) => {
      this.addEventListener("join", (e) => resolve(e.detail), { once: true });
    });
  }
}
