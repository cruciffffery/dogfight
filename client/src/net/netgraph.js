/**
 * Netgraph: RTT, вік знімка, байти/с, непідтверджені команди, величина корекції.
 * Малюється на canvas у правому нижньому куті.
 */
import { screenSpace } from "../render/canvas.js";

export function createNetgraph() {
  const corrections = new Float32Array(150);
  let ci = 0;
  const stats = {
    rtt: 0,
    snapshotAge: 0,
    downBps: 0,
    upBps: 0,
    pending: 0,
    correction: 0,
    correctionMax1s: 0,
    corrections: 0, // кількість ненульових корекцій
    interpDelay: 0,
    buffer: 0,
    starved: 0,
    codec: "",
    netsim: "",
    predict: true,
    snapshotBytes: 0,
    inputToMotion: 0,
    starvedFrames: 0,
    frames: 0,
  };
  let lastBytes = null;
  let lastAt = 0;
  let windowMax = 0;
  let windowStart = 0;

  return {
    stats,
    /** Записати корекцію (у px) з чергової звірки. */
    recordCorrection(px) {
      corrections[ci] = px;
      ci = (ci + 1) % corrections.length;
      stats.correction = px;
      if (px > 0.01) stats.corrections += 1;
      windowMax = Math.max(windowMax, px);
    },
    /** Раз на кадр: оновити байти/с. */
    update(now, bytes) {
      if (!lastBytes) {
        lastBytes = { ...bytes };
        lastAt = now;
        windowStart = now;
      }
      if (now - lastAt >= 1000) {
        const s = (now - lastAt) / 1000;
        stats.downBps = (bytes.in - lastBytes.in) / s;
        stats.upBps = (bytes.out - lastBytes.out) / s;
        lastBytes = { ...bytes };
        lastAt = now;
      }
      if (now - windowStart >= 1000) {
        stats.correctionMax1s = windowMax;
        windowMax = 0;
        windowStart = now;
      }
    },
    draw(view) {
      const { ctx } = view;
      screenSpace(view);
      const w = 300;
      const x = view.cssWidth - w - 14;
      const lh = 16;
      const rows = [
        ["RTT", `${stats.rtt.toFixed(0)} ms`],
        ["snapshot age", `${stats.snapshotAge.toFixed(0)} ms`],
        [
          "down / up",
          `${(stats.downBps / 1024).toFixed(1)} / ${(stats.upBps / 1024).toFixed(1)} KB/s`,
        ],
        ["snapshot", `${stats.snapshotBytes} B · ${stats.codec}`],
        ["pending inputs", String(stats.pending)],
        [
          "correction",
          `${stats.correction.toFixed(2)} px (max/s ${stats.correctionMax1s.toFixed(1)})`,
        ],
        [
          "interp delay",
          `${Math.round(stats.interpDelay)} ms · buf ${stats.buffer}${stats.starved ? " · STARVED" : ""}`,
        ],
        [
          "prediction",
          `${stats.predict ? "on" : "OFF (dumb client)"}${stats.inputToMotion ? ` · key→move ${stats.inputToMotion.toFixed(0)} ms` : ""}`,
        ],
        ["netsim", stats.netsim || "off"],
      ];
      const h = rows.length * lh + 64;
      const y = view.cssHeight - h - 14;
      ctx.fillStyle = "rgba(5, 7, 13, 0.78)";
      ctx.fillRect(x - 8, y - 8, w + 16, h + 8);
      ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      rows.forEach(([k, v], i) => {
        ctx.fillStyle = "rgba(207,224,255,0.55)";
        ctx.fillText(k, x, y + i * lh);
        ctx.fillStyle = "#cfe0ff";
        ctx.fillText(v, x + 105, y + i * lh);
      });
      // спарклайн корекцій
      const gy = y + rows.length * lh + 6;
      const gh = 40;
      ctx.strokeStyle = "rgba(207,224,255,0.2)";
      ctx.strokeRect(x, gy, w, gh);
      const n = corrections.length;
      const maxPx = 20;
      for (let i = 0; i < n; i++) {
        const v = corrections[(ci + i) % n];
        if (v <= 0.01) continue;
        const bh = Math.min(gh, (v / maxPx) * gh);
        ctx.fillStyle = v > 5 ? "#ff4d5e" : v > 1 ? "#ffb020" : "#39d98a";
        ctx.fillRect(x + (i / n) * w, gy + gh - bh, Math.max(1, w / n - 0.5), bh);
      }
      ctx.fillStyle = "rgba(207,224,255,0.45)";
      ctx.fillText("correction, px (0–20)", x + 4, gy + 2);
      ctx.fillText("[ ] delay · L netsim · P predict · N graph", x, gy + gh + 4);
    },
  };
}
