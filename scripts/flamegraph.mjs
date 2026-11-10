/**
 * Flame graph (icicle) у SVG з .cpuprofile — щоб скріншот профілю жив у репозиторії.
 *   node scripts/flamegraph.mjs docs/lab-07/client-before-x4.cpuprofile docs/lab-07/flame-before.svg "Клієнт до"
 * Ширина блоку = загальний час функції разом із викликаними; (idle)/(program) відкинуто.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, title = input] = process.argv.slice(2);
const p = JSON.parse(readFileSync(input, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, { ...n, self: 0, total: 0 }]));
p.samples.forEach((id, i) => {
  const n = byId.get(id);
  if (n) n.self += (p.timeDeltas[i] ?? 0) / 1000;
});
const skip = (n) => /^\((idle|program)\)$/.test(n.callFrame.functionName);
function total(n) {
  n.total =
    n.self +
    (n.children ?? [])
      .map((c) => byId.get(c))
      .filter((c) => !skip(c))
      .reduce((a, c) => a + total(c), 0);
  return n.total;
}
const root = byId.get(p.nodes[0].id);
total(root);
const W = 1200,
  ROW = 17,
  MIN = 0.5;
let depthMax = 0,
  rects = "";
const hue = (url) =>
  url.includes("main-") || url.includes("/src/") ? 25 : url.startsWith("node:") ? 200 : 0;
function draw(n, x, depth) {
  const w = (n.total / root.total) * W;
  if (w < MIN) return;
  depthMax = Math.max(depthMax, depth);
  const cf = n.callFrame;
  const name = cf.functionName || (n === root ? "all" : "(anonymous)");
  const h = hue(cf.url);
  const y = 30 + depth * ROW;
  const label = w > 40 ? name.slice(0, Math.floor(w / 7)) : "";
  rects += `<g><title>${name} ${cf.url.split("/").pop()}:${cf.lineNumber + 1} — ${n.total.toFixed(0)} ms</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW - 1}" fill="hsl(${h},${name.startsWith("(garbage") ? 0 : 75}%,${60 + (depth % 3) * 6}%)"/><text x="${(x + 3).toFixed(1)}" y="${y + 12}" font-size="11">${label.replace(/[<>&]/g, "")}</text></g>`;
  let cx = x;
  for (const c of (n.children ?? [])
    .map((id) => byId.get(id))
    .filter((c) => !skip(c))
    .sort((a, b) => b.total - a.total)) {
    draw(c, cx, depth + 1);
    cx += (c.total / root.total) * W;
  }
}
draw(root, 0, 0);
const H = 40 + (depthMax + 1) * ROW;
writeFileSync(
  output,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace"><title>${title}</title><rect width="100%" height="100%" fill="#fff"/><text x="4" y="20" font-size="14" font-family="system-ui">${title} — ${root.total.toFixed(0)} ms CPU (без idle)</text>${rects}</svg>`,
);
console.log(output, `${depthMax + 1} levels`);
