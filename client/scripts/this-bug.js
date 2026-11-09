/**
 * Відтворення бага з `this` і три способи його виправити.
 *
 *   node scripts/this-bug.js
 *
 * Метод класу — це звичайна функція на прототипі. `this` визначається НЕ місцем,
 * де метод написаний, а тим, ЯК його викликали.
 */
import { Ship } from "@dogfight/shared/sim/entities/ship.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";
import { World } from "@dogfight/shared/sim/world.js";

const world = new World({ director: () => {} });
const ship = world.spawn(new Ship({ pos: new Vector2(100, 100) }));

function tryCall(label, fn) {
  try {
    const result = fn();
    console.log(`✔ ${label}: ${result ? `куля #${result.id}` : "без кулі"}`);
  } catch (err) {
    console.log(`✘ ${label}: ${err.constructor.name}: ${err.message}`);
  }
  ship.cooldown = 0;
}

// 1. Правильний виклик: ship.fire(...) → this === ship (неявне прив'язування)
tryCall("ship.fire(world)", () => ship.fire(world));

// 2. БАГ: метод «відірвали» від об'єкта і викликали як звичайну функцію
const detached = ship.fire;
tryCall("const f = ship.fire; f(world)", () => detached(world));

// 3. Саме так виглядає баг у грі: колбек передали в обробник подій / таймер
await new Promise((resolve) => {
  setTimeout(() => {
    tryCall("setTimeout(ship.fire) — колбек без отримувача", () => detached.call(undefined, world));
    resolve();
  }, 0);
});

// ---- Три виправлення ----
// a) стрілкова функція-обгортка (обрано в грі)
tryCall("() => ship.fire(world)", () => (() => ship.fire(world))());

// b) bind: нова функція з назавжди зафіксованим this (і, за бажання, аргументами)
const bound = ship.fire.bind(ship, world);
tryCall("ship.fire.bind(ship, world)", () => bound());

// c) поле класу зі стрілковою функцією — this захоплюється при створенні екземпляра
class ShipWithArrowField extends Ship {
  fireArrow = (w) => this.fire(w);
}
const ship2 = world.spawn(new ShipWithArrowField({ pos: new Vector2(300, 300) }));
const handler = ship2.fireArrow;
tryCall("поле-стрілка (без отримувача)", () => {
  const b = handler(world);
  ship2.cooldown = 0;
  return b;
});

// Чому (c) — не за замовчуванням: кожен екземпляр отримує ВЛАСНУ копію функції,
// а метод на прототипі один на всі екземпляри.
console.log(
  "\nship.fire === ship2.fire (метод прототипу, спільний):",
  ship.fire === new Ship({}).fire,
);
console.log(
  "ship2.fireArrow === іншого екземпляра (поле, своє в кожного):",
  ship2.fireArrow === new ShipWithArrowField({}).fireArrow,
);

// Ланцюжок прототипів (stretch)
const chain = [];
for (let p = Object.getPrototypeOf(ship); p; p = Object.getPrototypeOf(p)) {
  chain.push(p.constructor.name);
}
console.log("\nланцюжок прототипів ship:", ["ship", ...chain].join(" → "), "→ null");
