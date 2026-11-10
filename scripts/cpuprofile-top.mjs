/** Топ функцій за self time з .cpuprofile (node --cpu-prof або DevTools): node scripts/cpuprofile-top.mjs file [N] */
import { readFileSync } from "node:fs";

const [file, n = "12"] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((x) => [x.id, x]));
const self = new Map();
p.samples.forEach((id, i) => {
  const cf = byId.get(id).callFrame;
  const key = `${cf.functionName || "(anonymous)"} ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
});
const busy = [...self].filter(([k]) => !/^\((idle|program)\)/.test(k));
const total = busy.reduce((a, [, v]) => a + v, 0);
console.log(`busy ${total.toFixed(0)} ms`);
for (const [k, v] of busy.sort((a, b) => b[1] - a[1]).slice(0, Number(n)))
  console.log(
    `${((100 * v) / total).toFixed(1).padStart(5)}%  ${v.toFixed(0).padStart(6)} ms  ${k}`,
  );
