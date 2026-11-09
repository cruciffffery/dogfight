/**
 * Клавіатура як замикання. Стан (`down`, `pressed`, `listeners`) недоступний ззовні —
 * назовні видно лише функції, які «пам'ятають» ці змінні.
 *
 * isDown(code)      — рівень: клавіша зараз утримується
 * justPressed(code) — фронт: клавішу натиснули з моменту останнього кроку симуляції
 * endStep()         — викликається після кожного кроку simulate()
 * onPress(code, fn) — колбек на натискання (тут і «ловиться» баг з this — див. README)
 */
const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);

export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();
  const listeners = new Map(); // code → Set<fn>

  function onKeyDown(e) {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!e.repeat && !down.has(e.code)) {
      pressed.add(e.code);
      // колбек викликається як звичайна функція: fn(e) — БЕЗ об'єкта перед крапкою,
      // тому `this` всередині fn буде undefined (strict mode у модулях)
      for (const fn of listeners.get(e.code) ?? []) fn(e);
    }
    down.add(e.code);
  }

  function onKeyUp(e) {
    down.delete(e.code);
  }

  function onBlur() {
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
      if (!listeners.has(code)) listeners.set(code, new Set());
      listeners.get(code).add(fn);
      return () => listeners.get(code).delete(fn);
    },
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}

/** «Сирий» стан клавіатури → ігрова команда (простий об'єкт даних). */
export function readCommand(input) {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  return {
    turn: (right ? 1 : 0) - (left ? 1 : 0),
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    brake: input.isDown("ArrowDown") || input.isDown("KeyS"),
    fire: input.isDown("Space"),
  };
}
