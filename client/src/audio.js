/**
 * Звук через Web Audio. Модуль володіє єдиним AudioContext.
 *
 * Браузер не дає відтворювати звук до жесту користувача: контекст створюється в стані
 * "suspended" (декодувати буфери вже можна — це робимо під час завантаження),
 * а resume() викликаємо на першому кліку / натисканні клавіші.
 *
 * Симуляція про цей модуль НЕ знає: аудіо лише підписується на події шини.
 */
let ctx = null;
let master = null;
const buffers = new Map();
let ambientSource = null;

export function getAudioContext() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Розблокувати звук на першому жесті. Повертає функцію відписки. */
export function unlockOnGesture(target = window) {
  const unlock = () => {
    getAudioContext()
      .resume()
      .then(() => startAmbient())
      .catch(() => {});
    target.removeEventListener("pointerdown", unlock);
    target.removeEventListener("keydown", unlock);
  };
  target.addEventListener("pointerdown", unlock);
  target.addEventListener("keydown", unlock);
  return unlock;
}

export function registerBuffers(assets) {
  for (const [id, value] of assets) {
    if (id.startsWith("sfx.") && value) buffers.set(id.slice(4), value);
  }
}

export function play(name, { volume = 1, rate = 1 } = {}) {
  if (ctx?.state !== "running") return;
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

function startAmbient() {
  const buffer = buffers.get("ambient");
  if (!buffer || ambientSource) return;
  ambientSource = ctx.createBufferSource();
  ambientSource.buffer = buffer;
  ambientSource.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  ambientSource.connect(gain).connect(master);
  ambientSource.start();
}

/**
 * Підписка на події симуляції. `bus` — будь-який EventTarget (World або шина).
 * @param {(id: number) => boolean} isLocal — щоб свої постріли звучали голосніше
 */
export function attachAudio(bus, { isLocal = () => true } = {}) {
  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
  on("fired", (d) => play("shoot", { volume: isLocal(d.ownerId) ? 0.5 : 0.25 }));
  on("hit", () => play("hit", { volume: 0.6 }));
  on("exploded", (d) => play("explosion", { volume: d.kind === "ship" ? 1 : 0.6 }));
  on("picked", () => play("pickup", { volume: 0.7 }));
}
