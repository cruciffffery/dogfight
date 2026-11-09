/**
 * Canvas з урахуванням devicePixelRatio.
 *
 * Буфер canvas = CSS-розмір × DPR (інакше на retina все розмите),
 * а ctx.setTransform(dpr, …) дозволяє далі малювати в CSS-пікселях.
 * Поверх цього рахуємо масштаб «світ → екран», щоб арена фіксованого розміру
 * вписувалась у будь-яке вікно з полями (letterbox).
 */
export function setupCanvas(canvas, initialArena) {
  let arena = initialArena;
  const ctx = canvas.getContext("2d", { alpha: false });

  const view = {
    ctx,
    canvas,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
    scale: 1, // світові px → CSS px
    offsetX: 0,
    offsetY: 0,
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    view.cssWidth = w;
    view.cssHeight = h;
    view.dpr = dpr;
    view.scale = Math.min(w / arena.width, h / arena.height);
    view.offsetX = (w - arena.width * view.scale) / 2;
    view.offsetY = (h - arena.height * view.scale) / 2;
  }

  // DPR змінюється, коли вікно перетягують на інший монітор або змінюють масштаб сторінки
  let dprQuery = null;
  function watchDpr() {
    dprQuery?.removeEventListener("change", onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDprChange);
  }
  function onDprChange() {
    resize();
    watchDpr();
  }

  new ResizeObserver(resize).observe(canvas);
  watchDpr();
  resize();

  /** Кімнати мають різні розміри арени — масштаб перераховується. */
  view.setArena = (next) => {
    arena = next;
    resize();
  };

  return view;
}

/** Скидає трансформацію до «CSS-пікселів» (для HUD). */
export function screenSpace(view) {
  view.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

/** Трансформація «світові координати арени» (для гри). */
export function worldSpace(view) {
  const s = view.dpr * view.scale;
  view.ctx.setTransform(s, 0, 0, s, view.dpr * view.offsetX, view.dpr * view.offsetY);
}
