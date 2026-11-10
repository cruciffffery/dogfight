/**
 * Canvas з урахуванням devicePixelRatio, letterbox арени у вікні.
 */
import type { Arena } from "@dogfight/shared/sim/arena.ts";

export interface View {
  readonly ctx: CanvasRenderingContext2D;
  readonly canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  setArena(next: Arena): void;
}

export function setupCanvas(canvas: HTMLCanvasElement, initialArena: Arena): View {
  let arena = initialArena;
  // alpha: true — крізь прозоре полотно видно CSS-фон (кешована арена, Лаба 7)
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Canvas 2D is not supported");

  const view: View = {
    ctx,
    canvas,
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    setArena(next) {
      arena = next;
      resize();
    },
  };

  function resize(): void {
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

  let dprQuery: MediaQueryList | null = null;
  function watchDpr(): void {
    dprQuery?.removeEventListener("change", onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDprChange);
  }
  function onDprChange(): void {
    resize();
    watchDpr();
  }

  new ResizeObserver(resize).observe(canvas);
  watchDpr();
  resize();
  return view;
}

export function screenSpace(view: View): void {
  view.ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

export function worldSpace(view: View): void {
  const s = view.dpr * view.scale;
  view.ctx.setTransform(s, 0, 0, s, view.dpr * view.offsetX, view.dpr * view.offsetY);
}
