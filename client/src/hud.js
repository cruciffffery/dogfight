/**
 * HUD рахунку. Як і аудіо, лише СЛУХАЄ події симуляції — симуляція його не імпортує.
 * Показує таблицю рахунку, спливаючі «+100» і стрічку останніх подій.
 */
import { screenSpace } from "./render/canvas.js";

export function createHud(bus, { nameOf = (id) => `#${id}`, localId = () => null } = {}) {
  const scores = new Map();
  const popups = []; // { text, x, y, age }
  const feed = []; // { text, age }

  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

  on("scored", ({ id, points, total, pos }) => {
    scores.set(id, total);
    if (id === localId()) popups.push({ text: `+${points}`, x: pos.x, y: pos.y, age: 0 });
  });
  on("exploded", ({ kind, id, byId }) => {
    if (kind !== "ship") return;
    const who = byId == null ? "астероїд" : nameOf(byId);
    feed.unshift({ text: `${who} ✕ ${nameOf(id)}`, age: 0 });
    feed.length = Math.min(feed.length, 4);
  });
  on("picked", ({ id, type }) => {
    feed.unshift({ text: `${nameOf(id)} підібрав ${type}`, age: 0 });
    feed.length = Math.min(feed.length, 4);
  });

  function update(dt) {
    for (const p of popups) p.age += dt;
    for (const f of feed) f.age += dt;
    while (popups.length && popups[0].age > 1) popups.shift();
    while (feed.length && feed[feed.length - 1].age > 5) feed.pop();
  }

  /** Малювання: спливаючі цифри — у світових координатах, таблиця — в екранних. */
  function draw(view, toScreen) {
    const { ctx } = view;
    screenSpace(view);
    ctx.textBaseline = "top";

    ctx.font = "700 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    for (const p of popups) {
      const s = toScreen(p.x, p.y);
      ctx.globalAlpha = 1 - p.age;
      ctx.fillStyle = "#39d98a";
      ctx.textAlign = "center";
      ctx.fillText(p.text, s.x, s.y - 30 - p.age * 30);
    }
    ctx.globalAlpha = 1;

    const rows = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    ctx.textAlign = "right";
    ctx.font = "600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    let y = 50;
    for (const [id, total] of rows) {
      ctx.fillStyle = id === localId() ? "#ffe27a" : "#cfe0ff";
      ctx.fillText(`${nameOf(id)}  ${total}`, view.cssWidth - 16, y);
      y += 18;
    }
    // стрічка подій — під таблицею рахунку (низ правого кута зайнятий netgraph)
    ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    y += 8;
    for (const f of feed) {
      ctx.globalAlpha = Math.min(1, 5 - f.age);
      ctx.fillStyle = "#8fa3cc";
      ctx.fillText(f.text, view.cssWidth - 16, y);
      y += 17;
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  return { update, draw, scores };
}
