/**
 * Клавіатура як замикання. Стан (`down`, `pressed`) недоступний ззовні —
 * назовні видно лише функції, які «пам'ятають» ці змінні.
 *
 * isDown(code)      — рівень: клавіша зараз утримується
 * justPressed(code) — фронт: клавішу натиснули з моменту останнього кроку симуляції
 * endStep()         — викликається циклом після кожного кроку simulate(),
 *                     щоб фронт «спрацював» рівно в одному кроці
 */
const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);

export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();

  function onKeyDown(e) {
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // не скролити сторінку стрілками
    // e.repeat — автоповтор ОС; фронт має бути лише на першому натисканні
    if (!e.repeat && !down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  }

  function onKeyUp(e) {
    down.delete(e.code);
  }

  // Втрата фокусу: keyup не прийде, тож без цього корабель «залипне» з газом
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
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}

/**
 * Перетворює «сирий» стан клавіатури на ігрову команду — простий об'єкт даних.
 * Саме його отримує симуляція: так sim/ нічого не знає про DOM і клавіші,
 * а в Лабі 5 ту саму команду можна буде відправити на сервер.
 */
export function readCommand(input) {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  return {
    turn: (right ? 1 : 0) - (left ? 1 : 0),
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    brake: input.isDown("ArrowDown") || input.isDown("KeyS"),
  };
}
