/**
 * Екран завантаження: смуга прогресу на canvas + DOM-кнопки для відновлення.
 */
import { screenSpace, type View } from "./canvas.ts";

export interface LoadingState {
  done: number;
  total: number;
  current: string;
  log: string[];
  error: string | null;
}

export interface Choice<Id extends string> {
  id: Id;
  label: string;
}

export interface LoadingScreen {
  readonly state: LoadingState;
  start(): void;
  stop(): void;
  ask<Id extends string>(buttons: readonly Choice<Id>[]): Promise<Id>;
  log(line: string): void;
}

export function createLoadingScreen(view: View): LoadingScreen {
  const state: LoadingState = { done: 0, total: 1, current: "", log: [], error: null };
  let raf = 0;
  let actions: HTMLDivElement | null = null;

  function draw(): void {
    const { ctx, cssWidth: w, cssHeight: h } = view;
    screenSpace(view);
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, w, h);
    const bw = Math.min(520, w - 64);
    const x = (w - bw) / 2;
    const y = h / 2;
    ctx.font = "700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#e8edf7";
    ctx.fillText("dogfight", w / 2, y - 48);
    ctx.fillStyle = "#111b33";
    ctx.fillRect(x, y - 10, bw, 20);
    const k = state.total ? state.done / state.total : 0;
    ctx.fillStyle = state.error ? "#ff4d5e" : "#7fa2ff";
    ctx.fillRect(x, y - 10, bw * k, 20);
    ctx.strokeStyle = "#2c3d6e";
    ctx.strokeRect(x + 0.5, y - 9.5, bw - 1, 19);
    ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.fillStyle = "#cfe0ff";
    ctx.fillText(
      state.error ?? `${state.done} / ${state.total}${state.current ? ` · ${state.current}` : ""}`,
      w / 2,
      y + 36,
    );
    ctx.fillStyle = "#8fa3cc";
    state.log.slice(-5).forEach((line, i) => {
      ctx.fillText(line, w / 2, y + 66 + i * 18);
    });
    if (!state.error) {
      ctx.fillStyle = "#56668c";
      ctx.fillText("Esc — скасувати завантаження", w / 2, h - 30);
    }
    raf = requestAnimationFrame(draw);
  }

  return {
    state,
    start() {
      if (!raf) raf = requestAnimationFrame(draw);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      actions?.remove();
    },
    ask(buttons) {
      actions?.remove();
      const box = document.createElement("div");
      actions = box;
      box.style.cssText =
        "position:fixed;left:0;right:0;top:calc(50% + 150px);display:flex;gap:10px;justify-content:center;font:14px ui-monospace,monospace";
      return new Promise((resolve) => {
        for (const { id, label } of buttons) {
          const b = document.createElement("button");
          b.textContent = label;
          b.dataset.action = id;
          b.style.cssText =
            "padding:9px 16px;border-radius:8px;border:1px solid #7fa2ff;background:#111b33;color:#e8edf7;font:inherit;cursor:pointer";
          b.addEventListener("click", () => {
            box.remove();
            actions = null;
            resolve(id);
          });
          box.append(b);
        }
        document.body.append(box);
        box.querySelector("button")?.focus();
      });
    },
    log(line) {
      state.log.push(line);
      console.info("[loader]", line);
    },
  };
}
