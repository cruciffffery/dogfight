/**
 * Лобі — модель без DOM. Події типізовані через Bus<LobbyEvents>.
 */
import { Bus } from "@dogfight/shared/bus.ts";
import {
  type ArenaConfig,
  ArenaSchema,
  type RoomInfo,
  RoomInfoSchema,
} from "@dogfight/shared/protocol.ts";
import { z } from "zod";
import { fetchJson, withRetry } from "../assets/loader.ts";

export interface JoinIntent {
  room: RoomInfo;
  arena: ArenaConfig;
  name: string;
}

export interface LobbyEvents {
  loading: undefined;
  rooms: RoomInfo[];
  error: Error;
  join: JoinIntent;
  left: undefined;
}

const RoomListSchema = z.array(RoomInfoSchema);

export class Lobby extends Bus<LobbyEvents> {
  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active = false;
  readonly roomsUrl: string;
  readonly arenaUrl: (id: string) => string;
  rooms: RoomInfo[] = [];
  refreshMs = 5000;
  timeoutMs = 3000;

  constructor({
    roomsUrl = "/api/rooms",
    arenaUrl = (id: string) => `/assets/arenas/${id}.json`,
  }: { roomsUrl?: string; arenaUrl?: (id: string) => string } = {}) {
    super();
    this.roomsUrl = roomsUrl;
    this.arenaUrl = arenaUrl;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.refreshMs);
  }

  async refresh(): Promise<void> {
    this.#controller?.abort(new DOMException("superseded", "AbortError"));
    const controller = new AbortController();
    this.#controller = controller;
    this.emit("loading", undefined);
    try {
      const rooms = RoomListSchema.parse(
        await fetchJson(this.roomsUrl, { signal: controller.signal, timeoutMs: this.timeoutMs }),
      );
      this.rooms = rooms;
      this.emit("rooms", rooms);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  async join(roomId: string, name: string): Promise<RoomInfo | null> {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new RangeError(`Unknown room: ${roomId}`);
    const controller = new AbortController();
    this.#controller?.abort();
    this.#controller = controller;
    try {
      const arena = await withRetry(
        async () =>
          ArenaSchema.parse(
            await fetchJson(this.arenaUrl(room.arena), {
              signal: controller.signal,
              timeoutMs: this.timeoutMs,
            }),
          ),
        { signal: controller.signal, attempts: 3 },
      );
      this.leave();
      this.emit("join", { room, arena, name });
      return room;
    } catch (err: unknown) {
      if (!controller.signal.aborted)
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  async createRoom(name: string, arena = "classic"): Promise<RoomInfo> {
    const response = await fetch(this.roomsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arena }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = z.object({ error: z.string() }).safeParse(body);
      throw new Error(message.success ? message.data.error : `HTTP ${response.status}`);
    }
    await this.refresh();
    return RoomInfoSchema.parse(body);
  }

  leave(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort(new DOMException("left lobby", "AbortError"));
    this.#controller = null;
    if (this.#active) {
      this.#active = false;
      this.emit("left", undefined);
    }
  }

  waitForJoin(): Promise<JoinIntent> {
    return new Promise((resolve) => {
      this.on("join", resolve, { once: true });
    });
  }
}
