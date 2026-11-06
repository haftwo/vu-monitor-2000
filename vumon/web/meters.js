// Meter ballistics and drawing. One MeterState per stream holds the
// ballistic state; drawDigital / drawAnalog paint it onto a canvas.

export const dB = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// IEC 60268-17 VU: 99 % of a step in 300 ms, ~1-1.5 % overshoot.
const VU_ZETA = 0.81;
const VU_OMEGA = 2 * Math.PI * 2.15;
// Sine-wave calibration, broadcast convention: a sine tone whose peak is at the
// alignment level (e.g. -18 dBFS) reads 0 VU. Mean |x| of a sine = 2/pi * peak.
const AVG_TO_SINE_PEAK = Math.PI / 2;
// Digital peak meter fall-back: 20 dB in 1.7 s (IEC 60268-18).
const PEAK_DECAY_DB_PER_S = 20 / 1.7;
const VU_MAX_LIN = Math.pow(10, 3 / 20);   // +3 VU at full scale

export class MeterState {
  constructor() { this.reset(); }

  reset() {
    this.peak = [-Infinity, -Infinity];    // displayed bar level, dBFS
    this.hold = [-Infinity, -Infinity];
    this.holdAt = [0, 0];
    this.max = [-Infinity, -Infinity];     // max since reset
    this.over = [false, false];
    this.redAt = [0, 0];                   // last time the red zone was hit (for LEDs)
    this.vuIn = [0, 0];                    // linear, 1.0 = alignment tone
    this.vuY = [0, 0];                     // needle position (linear, 1 = reference)
    this.vuV = [0, 0];
    this.lr = 0; this.ll = 0; this.rr = 0;
    this.corr = null;
    this.M = -Infinity; this.S = -Infinity; this.I = -Infinity;
    this.mono = false;
    this.lastReport = 0;
    this.quietSince = null;
    this.silent = false;
    this.latestLevel = -Infinity;
  }

  resetPeaks() {
    this.max = [-Infinity, -Infinity];
    this.over = [false, false];
    this.hold = [-Infinity, -Infinity];
  }

  // A report from the worklet.
  ingest(r, settings, now) {
    this.lastReport = now;
    this.mono = r.mono;
    const peaks = settings.peak === 'sample' ? r.pk : r.tp;
    let loudest = -Infinity;
    for (let c = 0; c < 2; c++) {
      const v = dB(peaks[c]);
      loudest = Math.max(loudest, v);
      if (v > this.peak[c]) this.peak[c] = v;
      if (v >= this.hold[c]) { this.hold[c] = v; this.holdAt[c] = now; }
      if (v > this.max[c]) this.max[c] = v;
      if (r.pk[c] >= 0.98855) this.over[c] = true;          // >= -0.1 dBFS sample peak: clip
      if (v >= settings.red) this.redAt[c] = now;
      this.vuIn[c] = r.ma[c] * AVG_TO_SINE_PEAK / Math.pow(10, settings.ref / 20);
    }
    this.latestLevel = loudest;

    // correlation, smoothed with a ~300 ms time constant
    const k = 1 - Math.exp(-(1 / 30) / 0.3);
    this.lr += (r.lr - this.lr) * k;
    this.ll += (r.ll - this.ll) * k;
    this.rr += (r.rr - this.rr) * k;
    const den = Math.sqrt(this.ll * this.rr);
    this.corr = den > 1e-9 ? clamp(this.lr / den, -1, 1) : null;

    this.M = r.M; this.S = r.S; this.I = r.I;

    // silence detection
    if (loudest < settings.silenceDb) {
      if (this.quietSince === null) this.quietSince = now;
      this.silent = now - this.quietSince >= settings.silenceSec;
    } else {
      this.quietSince = null;
      this.silent = false;
    }
  }

  // Advance ballistics by dt seconds (called once per animation frame).
  tick(dt, settings, now) {
    dt = Math.min(dt, 0.1);
    // Nothing coming in (stalled / stopped): let everything fall.
    if (now - this.lastReport > 0.5) this.vuIn = [0, 0];
    for (let c = 0; c < 2; c++) {
      this.peak[c] -= PEAK_DECAY_DB_PER_S * dt;
      if (now - this.holdAt[c] > settings.hold) this.hold[c] -= PEAK_DECAY_DB_PER_S * 2 * dt;
      if (this.hold[c] < this.peak[c]) this.hold[c] = this.peak[c];

      // VU needle: second-order system integrated in 1 ms steps
      let y = this.vuY[c], v = this.vuV[c];
      const u = Math.min(this.vuIn[c], VU_MAX_LIN * 1.08);
      for (let t = 0; t < dt; t += 0.001) {
        const h = Math.min(0.001, dt - t);
        const a = VU_OMEGA * VU_OMEGA * (u - y) - 2 * VU_ZETA * VU_OMEGA * v;
        v += a * h; y += v * h;
      }
      // mechanical end stops
      if (y < -0.02) { y = -0.02; v = 0; }
      if (y > VU_MAX_LIN * 1.06) { y = VU_MAX_LIN * 1.06; v = 0; }
      this.vuY[c] = y; this.vuV[c] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export const fmtDb = (v, digits = 1) =>
  (Number.isFinite(v) && v > -99 ? (v > 0 ? '+' : '') + v.toFixed(digits) : '-∞');

// ---------------------------------------------------------------------------
// Digital peak meter (vertical bargraph, dBFS)
// ---------------------------------------------------------------------------

// dBFS -> 0..1 with extra resolution in the top 20 dB.
function digitalPos(db) {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  if (db >= -20) return 0.55 + (db + 20) / 20 * 0.45;
  return (db + 60) / 40 * 0.55;
}

const DIGI_TICKS = [0, -3, -6, -9, -12, -15, -18, -20, -25, -30, -40, -50, -60];
// Always label the alignment level; drop ticks crowding it.
const ticksFor = (ref) => [...new Set([...DIGI_TICKS.filter((t) => t === 0 || Math.abs(t - ref) >= 2.5), ref])];

export function drawDigital(canvas, st, settings, now) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const colOk = css.getPropertyValue('--meter-green').trim() || '#3ddc84';
  const colWarn = css.getPropertyValue('--meter-amber').trim() || '#ffb020';
  const colHot = css.getPropertyValue('--meter-red').trim() || '#ff3b3b';
  const colText = css.getPropertyValue('--muted').trim() || '#8a93a6';
  const colTextHi = css.getPropertyValue('--text').trim() || '#e7ebf3';

  const top = 30, bottom = h - 20;
  const scaleW = 40;
  const barW = clamp((w - scaleW - 24) / 2, 14, 46);
  const groupW = barW * 2 + scaleW;
  const x0 = (w - groupW) / 2;
  const bars = [x0, x0 + barW + scaleW];
  const yOf = (db) => bottom - digitalPos(db) * (bottom - top);

  // scale
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of ticksFor(settings.ref)) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.fillStyle = t === settings.ref ? colTextHi : colText;
    ctx.fillText(t === 0 ? '0' : String(t), x0 + barW + scaleW / 2, y);
    ctx.strokeStyle = colText;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(x0 + barW + 2, y); ctx.lineTo(x0 + barW + 6, y);
    ctx.moveTo(x0 + barW + scaleW - 6, y); ctx.lineTo(x0 + barW + scaleW - 2, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const zoneColour = (db) => (db >= settings.red ? colHot : db >= settings.amber ? colWarn : colOk);
  const seg = 3; // LED segment pitch, px

  for (let c = 0; c < 2; c++) {
    const x = bars[c];
    // unlit segments
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, top, barW, bottom - top);

    // lit portion, drawn in three zones
    const level = st.peak[c];
    const yLevel = yOf(level);
    const zones = [[-Infinity, settings.amber, colOk], [settings.amber, settings.red, colWarn],
      [settings.red, Infinity, colHot]];
    for (const [lo, hi, col] of zones) {
      const yLo = yOf(lo), yHi = yOf(hi);
      const yStart = Math.max(yLevel, yHi);
      if (yStart < yLo) {
        ctx.fillStyle = col;
        ctx.fillRect(x, yStart, barW, yLo - yStart);
      }
      // dim zone colour behind unlit segments
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = col;
      ctx.fillRect(x, yHi, barW, Math.min(yLevel, yLo) - yHi);
      ctx.globalAlpha = 1;
    }
    // segment gaps
    ctx.fillStyle = css.getPropertyValue('--card').trim() || '#141922';
    for (let y = bottom - seg; y > top; y -= seg) ctx.fillRect(x, y, barW, 1);

    // peak hold line
    if (st.hold[c] > -60) {
      const yh = Math.round(yOf(st.hold[c]));
      ctx.fillStyle = zoneColour(st.hold[c]);
      ctx.fillRect(x, yh - 1, barW, 2);
    }
    // alignment marker
    const yr = Math.round(yOf(settings.ref)) + 0.5;
    ctx.strokeStyle = colTextHi; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(x, yr); ctx.lineTo(x + barW, yr); ctx.stroke();
    ctx.globalAlpha = 1;

    // max readout + OVER
    const over = st.over[c];
    ctx.fillStyle = over ? colHot : 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, 2, barW, 12);
    ctx.fillStyle = over ? '#fff' : colText;
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText('OVER', x + barW / 2, 8.5);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = st.max[c] >= settings.red ? colHot : colTextHi;
    ctx.fillText(fmtDb(st.max[c]), x + barW / 2, 22);

    // channel label
    ctx.fillStyle = colText;
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillText(c === 0 ? 'L' : 'R', x + barW / 2, h - 9);
  }
  ctx.fillStyle = colText;
  ctx.font = '600 9px system-ui, sans-serif';
  ctx.fillText(settings.peak === 'sample' ? 'dBFS' : 'dBTP', x0 + barW + scaleW / 2, h - 9);
}

// ---------------------------------------------------------------------------
// Analogue VU meter (pair of moving-coil style meters)
// ---------------------------------------------------------------------------

const VU_MARKS = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
const VU_MINOR = [-15, -6, -4, 0.5, 1.5, 2.5];
const ARC = 44 * Math.PI / 180; // half sweep

function vuAngle(lin) {
  const p = clamp(lin / VU_MAX_LIN, -0.02, 1.06);
  return -ARC + p * 2 * ARC;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawOneVU(ctx, x, y, w, h, st, c, settings, now) {
  // bezel
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = '#0b0d10';
  ctx.fill();
  const ix = x + 5, iy = y + 5, iw = w - 10, ih = h - 10;

  // backlit face
  ctx.save();
  roundRect(ctx, ix, iy, iw, ih, 5);
  ctx.clip();
  const g = ctx.createRadialGradient(ix + iw / 2, iy + ih * 0.95, ih * 0.1, ix + iw / 2, iy + ih * 0.7, iw * 0.75);
  g.addColorStop(0, '#fff3cf');
  g.addColorStop(0.6, '#f3d58f');
  g.addColorStop(1, '#c99a45');
  ctx.fillStyle = g;
  ctx.fillRect(ix, iy, iw, ih);

  const cx = ix + iw / 2;
  const cy = iy + ih * 1.05;          // pivot sits below the window
  const R = ih * 0.74;                // scale radius
  const pt = (ang, r) => [cx + Math.sin(ang) * r, cy - Math.cos(ang) * r];
  const ink = '#2a1d0c', red = '#c4161c';

  // main arc (black to 0, red to +3)
  ctx.lineWidth = Math.max(1.2, ih * 0.012);
  ctx.strokeStyle = ink;
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI / 2 - ARC, -Math.PI / 2 + vuAngle(1));
  ctx.stroke();
  ctx.strokeStyle = red;
  ctx.lineWidth = Math.max(3, ih * 0.035);
  ctx.beginPath();
  ctx.arc(cx, cy, R + ctx.lineWidth / 2, -Math.PI / 2 + vuAngle(1), -Math.PI / 2 + ARC);
  ctx.stroke();

  // ticks and labels
  const fs = Math.max(8, Math.round(ih * 0.095));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of VU_MARKS) {
    const a = vuAngle(Math.pow(10, m / 20));
    const col = m > 0 ? red : ink;
    const [x1, y1] = pt(a, R);
    const [x2, y2] = pt(a, R + ih * 0.07);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, ih * 0.014);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const [tx, ty] = pt(a, R + ih * 0.15);
    ctx.fillStyle = col;
    ctx.font = `700 ${fs}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(m > 0 ? `+${m}` : String(Math.abs(m)), tx, ty);
  }
  for (const m of VU_MINOR) {
    const a = vuAngle(Math.pow(10, m / 20));
    const [x1, y1] = pt(a, R);
    const [x2, y2] = pt(a, R + ih * 0.04);
    ctx.strokeStyle = m > 0 ? red : ink; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  // percentage scale below the arc
  ctx.font = `600 ${Math.max(7, Math.round(fs * 0.7))}px "Helvetica Neue", Arial, sans-serif`;
  for (const pct of [0, 20, 40, 60, 80, 100]) {
    const a = vuAngle(pct / 100);
    const [x1, y1] = pt(a, R - ih * 0.005);
    const [x2, y2] = pt(a, R - ih * 0.045);
    ctx.strokeStyle = ink; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const [tx, ty] = pt(a, R - ih * 0.1);
    ctx.fillStyle = ink;
    ctx.fillText(String(pct), tx, ty);
  }

  // legend
  ctx.fillStyle = ink;
  ctx.font = `800 ${Math.round(fs * 1.5)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('VU', cx, iy + ih * 0.62);
  ctx.font = `600 ${Math.max(7, Math.round(fs * 0.72))}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(`0 VU = ${settings.ref} dBFS`, cx, iy + ih * 0.76);
  ctx.textAlign = 'left';
  ctx.font = `800 ${Math.round(fs * 1.1)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(c === 0 ? 'L' : 'R', ix + iw * 0.05, iy + ih * 0.88);

  // peak LED
  const lit = now - st.redAt[c] < 0.15 || st.over[c];
  const lx = ix + iw * 0.92, ly = iy + ih * 0.86, lr = Math.max(3, ih * 0.04);
  ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2);
  ctx.fillStyle = lit ? '#ff2a2a' : '#5a1a14';
  if (lit) { ctx.shadowColor = '#ff2a2a'; ctx.shadowBlur = lr * 3; }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textAlign = 'right';
  ctx.fillStyle = ink;
  ctx.font = `700 ${Math.max(7, Math.round(fs * 0.62))}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText('PEAK', lx - lr - 3, ly);

  // needle
  const a = vuAngle(st.vuY[c]);
  const [nx, ny] = pt(a, R + ih * 0.1);
  const [bx, by] = pt(a, ih * 0.32);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 1;
  ctx.strokeStyle = '#111'; ctx.lineWidth = Math.max(1.2, ih * 0.012); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(nx, ny); ctx.stroke();
  ctx.restore();

  // window shadow / glass
  const glass = ctx.createLinearGradient(0, iy, 0, iy + ih);
  glass.addColorStop(0, 'rgba(0,0,0,0.28)');
  glass.addColorStop(0.12, 'rgba(0,0,0,0)');
  glass.addColorStop(0.8, 'rgba(0,0,0,0)');
  glass.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = glass;
  ctx.fillRect(ix, iy, iw, ih);
  ctx.restore();

  // pivot housing
  ctx.fillStyle = '#0b0d10';
  ctx.beginPath();
  ctx.ellipse(cx, iy + ih + 1, iw * 0.16, ih * 0.1, 0, Math.PI, 0);
  ctx.fill();
}

export function drawAnalog(canvas, st, settings, now) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const gap = 10;
  const mw = (w - gap) / 2;
  drawOneVU(ctx, 0, 0, mw, h, st, 0, settings, now);
  drawOneVU(ctx, mw + gap, 0, mw, h, st, 1, settings, now);
}

export function analogHeightFor(width) {
  return Math.round(((width - 10) / 2) / 1.45);
}
