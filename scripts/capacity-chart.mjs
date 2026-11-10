/** SVG-графік ємності з docs/lab-07/load-*.json: node scripts/capacity-chart.mjs → docs/lab-07/capacity.svg */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "docs", "lab-07");
const grid = JSON.parse(readFileSync(join(dir, "load-grid.json"), "utf8")).rows;
const naive = JSON.parse(readFileSync(join(dir, "load-naive.json"), "utf8")).rows;
const W = 900,
  H = 340,
  pad = { l: 56, r: 20, t: 40, b: 44 },
  gap = 60;
const pw = (W - pad.l - pad.r - gap) / 2,
  ph = H - pad.t - pad.b;
const ns = grid.map((r) => r.players);
const xs = (i, x0) => x0 + (i / (ns.length - 1)) * pw;

function panel(x0, title, series, yMax, line) {
  const ys = (v) => pad.t + ph - (v / yMax) * ph;
  let s = `<text x="${x0}" y="24" font-weight="600">${title}</text>`;
  for (let k = 0; k <= 4; k++) {
    const v = (yMax / 4) * k;
    s += `<line x1="${x0}" x2="${x0 + pw}" y1="${ys(v)}" y2="${ys(v)}" stroke="#ddd"/><text x="${x0 - 6}" y="${ys(v) + 4}" text-anchor="end" font-size="11">${+v.toFixed(1)}</text>`;
  }
  for (const [i, n] of ns.entries())
    s += `<text x="${xs(i, x0)}" y="${H - pad.b + 18}" text-anchor="middle" font-size="11">${n}</text>`;
  s += `<text x="${x0 + pw / 2}" y="${H - 8}" text-anchor="middle" font-size="11">гравців у кімнаті</text>`;
  if (line !== undefined)
    s += `<line x1="${x0}" x2="${x0 + pw}" y1="${ys(line)}" y2="${ys(line)}" stroke="#c33" stroke-dasharray="4 3"/><text x="${x0 + pw}" y="${ys(line) - 4}" text-anchor="end" font-size="11" fill="#c33">бюджет тіку 33 мс</text>`;
  for (const { rows, color, name, key } of series) {
    const pts = rows.map((r, i) => `${xs(i, x0)},${ys(r[key])}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
    for (const [i, r] of rows.entries())
      s += `<circle cx="${xs(i, x0)}" cy="${ys(r[key])}" r="3.5" fill="${color}"/>`;
    const last = rows.at(-1);
    s += `<text x="${xs(rows.length - 1, x0) - 6}" y="${ys(last[key]) - 8}" text-anchor="end" font-size="11" fill="${color}">${name} ${last[key]}</text>`;
  }
  return s;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="13"><title>Ємність сервера dogfight</title><rect width="100%" height="100%" fill="#fff"/>
${panel(
  pad.l,
  "Час тіку p99 (мс)",
  [
    { rows: naive, color: "#d08000", name: "naive O(n²)", key: "tickP99" },
    { rows: grid, color: "#2266cc", name: "spatial hash", key: "tickP99" },
  ],
  36,
  33.3,
)}
${panel(pad.l + pw + gap, "Вихідний трафік сервера (КБ/с)", [{ rows: grid, color: "#2266cc", name: "", key: "outKBps" }], Math.ceil(Math.max(...grid.map((r) => r.outKBps)) / 5000) * 5000)}
</svg>`;
writeFileSync(join(dir, "capacity.svg"), svg);
console.log("docs/lab-07/capacity.svg");
