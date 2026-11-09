/**
 * П'ять задач на порядок виконання (Лаба 3, M4).
 * Вставте у консоль браузера або відкрийте /docs/lab-03/puzzles.html у dev-сервері.
 * Кожна задача запускається окремо, коли попередня повністю завершилась.
 */
export const puzzles = [
  {
    name: "1. async-функція до і після await",
    run(log) {
      log("A");
      (async () => {
        log("B");
        await null;
        log("C");
      })();
      Promise.resolve().then(() => log("D"));
      log("E");
    },
  },
  {
    name: "2. setTimeout всередині .then",
    run(log) {
      setTimeout(() => log("T1"), 0);
      Promise.resolve()
        .then(() => {
          log("P1");
          setTimeout(() => log("T2"), 0);
        })
        .then(() => log("P2"));
      log("S");
    },
  },
  {
    name: "3. requestAnimationFrame проти таймера і мікрозадачі",
    run(log) {
      requestAnimationFrame(() => {
        log("R");
        Promise.resolve().then(() => log("R-micro"));
      });
      setTimeout(() => log("T"), 0);
      Promise.resolve().then(() => log("P"));
      log("S");
    },
  },
  {
    name: "4. queueMicrotask і ланцюжок .then",
    run(log) {
      Promise.resolve()
        .then(() => log(1))
        .then(() => log(2));
      queueMicrotask(() => {
        log(3);
        queueMicrotask(() => log(4));
      });
      Promise.resolve().then(() => log(5));
    },
  },
  {
    name: "5. await результату async-функції проти .then",
    run(log) {
      async function f() {
        log("f-start");
        return "v";
      }
      f().then((v) => log(`then:${v}`));
      (async () => {
        const v = await f();
        log(`await:${v}`);
      })();
      log("end");
    },
  },
];

/** Запускає задачі по черзі; кожна має 100 мс, щоб усі таймери і кадри відпрацювали. */
export async function runAll() {
  const results = [];
  for (const p of puzzles) {
    const out = [];
    p.run((x) => out.push(String(x)));
    await new Promise((r) => setTimeout(r, 100));
    results.push({ name: p.name, output: out.join(" ") });
  }
  return results;
}
