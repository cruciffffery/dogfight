/**
 * Шар-накладка для HUD і netgraph: окремий <canvas> поверх ігрового (position: fixed,
 * pointer-events: none). Перемальовується раз на intervalMs, а між перемальовуваннями
 * не коштує головному потоку НІЧОГО — складання шарів робить компoзитор браузера.
 *
 * Історія з профілю (Лаба 7): перша версія копіювала кеш шару на ігрове полотно
 * drawImage-ом щокадру — під CPU ×4 drawImage став топ-1 за self time (30 %),
 * бо це повноекранна копія пікселів двічі на кадр. DOM-шар прибрав цю копію зовсім.
 */
import type { View } from "./canvas.ts";

export interface Layer {
  /** paint викликається, лише коли шар «застарів» (раз на intervalMs). */
  draw(now: number, paint: (layerView: View) => void): void;
  /** Сховати шар (наприклад, HUD вимкнено клавішею). */
  hide(): void;
  destroy(): void;
}

export function createLayer(view: View, intervalMs = 100): Layer {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none";
  view.canvas.after(canvas);
  const ctx = canvas.getContext("2d");
  let paintedAt = Number.NEGATIVE_INFINITY;
  let visible = true;

  return {
    draw(now, paint) {
      if (!ctx) return;
      if (!visible) {
        canvas.style.display = "";
        visible = true;
        paintedAt = Number.NEGATIVE_INFINITY;
      }
      if (canvas.width !== view.canvas.width || canvas.height !== view.canvas.height) {
        canvas.width = view.canvas.width;
        canvas.height = view.canvas.height;
        paintedAt = Number.NEGATIVE_INFINITY;
      }
      if (now - paintedAt < intervalMs) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paint({ ...view, ctx, canvas });
      paintedAt = now;
    },
    hide() {
      if (!visible) return;
      canvas.style.display = "none";
      visible = false;
    },
    destroy() {
      canvas.remove();
    },
  };
}
