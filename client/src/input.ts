/**
 * Клавіатура як замикання: стан (`down`, `pressed`, `listeners`) недоступний ззовні.
 */
import type { Command } from "@dogfight/shared/types.ts";

const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);

export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endStep(): void;
  onPress(code: string, fn: (e: KeyboardEvent) => void): () => void;
  dispose(): void;
}

export function createInput(target: Window | HTMLElement = window): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();
  const listeners = new Map<string, Set<(e: KeyboardEvent) => void>>();

  const isTyping = (e: Event): boolean =>
    e.target instanceof HTMLElement && e.target.matches("input, textarea");

  function onKeyDown(e: Event): void {
    if (!(e instanceof KeyboardEvent) || isTyping(e)) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!e.repeat && !down.has(e.code)) {
      pressed.add(e.code);
      for (const fn of listeners.get(e.code) ?? []) fn(e);
    }
    down.add(e.code);
  }

  function onKeyUp(e: Event): void {
    if (e instanceof KeyboardEvent) down.delete(e.code);
  }

  function onBlur(): void {
    down.clear();
    pressed.clear();
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    onPress(code, fn) {
      let set = listeners.get(code);
      if (!set) {
        set = new Set();
        listeners.set(code, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}

export function readCommand(input: Input): Command {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  return {
    turn: left === right ? 0 : right ? 1 : -1,
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    brake: input.isDown("ArrowDown") || input.isDown("KeyS"),
    fire: input.isDown("Space"),
  };
}
