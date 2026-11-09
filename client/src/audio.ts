/**
 * Звук через Web Audio. Модуль володіє єдиним AudioContext і лише СЛУХАЄ події симуляції.
 */
import type { Bus } from "@dogfight/shared/bus.ts";
import type { WorldEvents } from "@dogfight/shared/sim/world.ts";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
let ambientSource: AudioBufferSourceNode | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function unlockOnGesture(target: Window = window): void {
  const unlock = (): void => {
    getAudioContext()
      .resume()
      .then(() => startAmbient())
      .catch(() => {});
    target.removeEventListener("pointerdown", unlock);
    target.removeEventListener("keydown", unlock);
  };
  target.addEventListener("pointerdown", unlock);
  target.addEventListener("keydown", unlock);
}

export function registerBuffers(assets: ReadonlyMap<string, unknown>): void {
  for (const [id, value] of assets) {
    if (id.startsWith("sfx.") && value instanceof AudioBuffer) buffers.set(id.slice(4), value);
  }
}

export function play(name: string, { volume = 1, rate = 1 } = {}): void {
  if (!ctx || !master || ctx.state !== "running") return;
  const buffer = buffers.get(name);
  if (!buffer) return;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(master);
  src.start();
}

function startAmbient(): void {
  const buffer = buffers.get("ambient");
  if (!buffer || ambientSource || !ctx || !master) return;
  ambientSource = ctx.createBufferSource();
  ambientSource.buffer = buffer;
  ambientSource.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  ambientSource.connect(gain).connect(master);
  ambientSource.start();
}

/** Підписка на події симуляції: працює і з World (офлайн), і з мережевою шиною (онлайн). */
export function attachAudio(
  bus: Bus<WorldEvents>,
  { isLocal = (_id: number): boolean => true }: { isLocal?: (id: number) => boolean } = {},
): void {
  bus.on("fired", (d) => play("shoot", { volume: isLocal(d.ownerId) ? 0.5 : 0.25 }));
  bus.on("hit", () => play("hit", { volume: 0.6 }));
  bus.on("exploded", (d) => play("explosion", { volume: d.kind === "ship" ? 1 : 0.6 }));
  bus.on("picked", () => play("pickup", { volume: 0.7 }));
}
