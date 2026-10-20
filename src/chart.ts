import { ASSUMPTIONS, type Step } from './sim';

type Colors = Record<'pv' | 'grid' | 'bess' | 'building' | 'ai' | 'ev' | 'heat', string>;

function setup(canvas: HTMLCanvasElement) {
  const dpr = Math.min(devicePixelRatio, 2), w = canvas.clientWidth, h = canvas.clientHeight || +canvas.getAttribute('height')!;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// 24 h lines in MW: total load, PV, grid (import − export) with the no-EMS grid dashed, BESS (+discharge / −charge),
// SoC on the right axis. Peak-price hours and DR windows are shaded.
export function drawChart(canvas: HTMLCanvasElement, steps: Step[], baseline: Step[], now: number, c: Colors, legend: HTMLElement) {
  const { ctx, w, h } = setup(canvas);
  const L = 30, R = 30, T = 6, B = 18, n = steps.length;
  const max = Math.ceil(Math.max(...steps.map(s => s.building + s.ai + s.ev), ...baseline.map(s => s.gridImport)) + 1), min = -ASSUMPTIONS.bess.power;
  const x = (i: number) => L + (i / (n - 1)) * (w - L - R), y = (v: number) => T + (1 - (v - min) / (max - min)) * (h - T - B);
  ctx.font = '10px system-ui'; ctx.fillStyle = '#8b9bab'; ctx.strokeStyle = '#233040'; ctx.lineWidth = 1;
  steps.forEach((s, i) => {
    if (s.price >= 8) { ctx.fillStyle = 'rgba(248,113,113,0.07)'; ctx.fillRect(x(i), T, (w - L - R) / n, h - T - B); }
    if (s.dr) { ctx.fillStyle = 'rgba(248,113,113,0.22)'; ctx.fillRect(x(i), T, (w - L - R) / n, h - T - B); }
  });
  ctx.fillStyle = '#8b9bab';
  for (let v = Math.ceil(min / 5) * 5; v <= max; v += 5) {
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(w - R, y(v)); ctx.stroke(); ctx.fillText(String(v), 4, y(v) + 3);
  }
  for (let hr = 0; hr <= 24; hr += 6) ctx.fillText(`${hr}`, x(hr * 4 - (hr === 24 ? 1 : 0)) - 4, h - 4);
  ctx.fillText('MW', 4, h - 4); ctx.fillText('SoC', w - R + 4, T + 8);
  const line = (vals: number[], color: string, dash: number[] = [], width = 1.6, yf = y) => {
    ctx.beginPath(); ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width;
    vals.forEach((v, i) => (i ? ctx.lineTo(x(i), yf(v)) : ctx.moveTo(x(i), yf(v)))); ctx.stroke(); ctx.setLineDash([]);
  };
  line(steps.map(s => s.building + s.ai + s.ev), '#e6edf3');
  line(baseline.map(s => s.gridImport - s.gridExport), c.grid, [3, 3], 1.2);
  line(steps.map(s => s.gridImport - s.gridExport), c.grid, [], 2);
  line(steps.map(s => s.pv), c.pv, [], 2);
  line(steps.map(s => s.bessDischarge - s.bessCharge), c.bess, [], 1.4);
  line(steps.map(s => s.soc), c.bess, [1, 3], 1.4, v => T + (1 - v) * (h - T - B));
  ctx.strokeStyle = '#e6edf3'; ctx.beginPath(); ctx.moveTo(x(now), T); ctx.lineTo(x(now), h - B); ctx.stroke();
  if (!legend.childElementCount) legend.innerHTML = [['總用電', '#e6edf3'], ['購電', c.grid], ['購電（無調度）', c.grid], ['光電', c.pv], ['儲能 放＋／充−', c.bess], ['儲能電量', c.bess], ['尖峰電價時段', 'rgba(248,113,113,0.5)']]
    .map(([t, col]) => `<span style="--c:${col}">${t}</span>`).join('');
}

export function drawSpark(canvas: HTMLCanvasElement, vals: number[], now: number, color: string) {
  const { ctx, w, h } = setup(canvas);
  const max = Math.max(...vals, 1e-6), min = Math.min(0, ...vals), x = (i: number) => (i / (vals.length - 1)) * w, y = (v: number) => 4 + (1 - (v - min) / (max - min)) * (h - 8);
  ctx.beginPath(); vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(w, y(min)); ctx.lineTo(0, y(min)); ctx.closePath(); ctx.globalAlpha = 0.15; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = '#e6edf3'; ctx.beginPath(); ctx.arc(x(now), y(vals[now]), 3, 0, Math.PI * 2); ctx.fill();
}
