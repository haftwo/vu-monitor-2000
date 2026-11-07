// Long-term level statistics for the Average and SNR / DR views, over a
// sliding window (1-60 min). Fed by the same ~30 Hz reports as the meters.
//
// Every 100 ms tick stores:
//   - 400 ms RMS (unweighted, L/R power mean), into a windowed histogram that
//     gives the noise floor (5th percentile) and signal level (95th)
//   - short-term loudness (3 s), into a windowed histogram for EBU Tech 3342
//     Loudness Range (LRA)
// Every second stores RMS L / R, K-weighted energy and max true peak, for the
// level-over-time graph, Leq, crest factor and peak-to-loudness ratio.
//
// SNR here is an estimate from programme material - there is no test signal
// on a live stream - so it is the gap between the loud passages (P95) and the
// quietest passages (P5, the pauses), which is how a noise floor shows up in
// a real broadcast chain.

import { fitCanvas, fmtDb } from './meters.js';

const CAP_SECS = 3600;            // 60 min of 1 s points
const CAP_TICKS = CAP_SECS * 10;  // 60 min of 100 ms points
const REPORTS_PER_TICK = 3;       // reports arrive at 30 Hz
const MIN_TICKS = 50;             // 5 s before showing dynamics figures

const db10 = (ms) => (ms > 0 ? 10 * Math.log10(ms) : -Infinity);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Histogram over a sliding window: values are added as they arrive and
// subtracted again when they leave the window.
class WindowHist {
  constructor(min, max, step) {
    this.min = min; this.step = step;
    this.bins = Math.round((max - min) / step);
    this.clear();
  }
  clear() {
    this.counts = new Float64Array(this.bins);
    this.below = 0;   // values under the range, or -Infinity (digital black / gated)
    this.n = 0;       // values in range
    this.energy = 0;  // sum of 10^(v/10) over values in range
  }
  bin(v) { return v >= this.min ? Math.min(this.bins - 1, Math.floor((v - this.min) / this.step)) : -1; }
  add(v, sign = 1) {
    const b = this.bin(v);
    if (b < 0) { this.below += sign; return; }
    this.counts[b] += sign;
    this.n += sign;
    this.energy += sign * Math.pow(10, v / 10);
  }
  centre(b) { return this.min + (b + 0.5) * this.step; }
  // p-th percentile; `withBelow` counts below-range values as -Infinity.
  pct(p, withBelow = true, fromBin = 0) {
    let total = withBelow && fromBin === 0 ? this.below : 0;
    for (let b = fromBin; b < this.bins; b++) total += this.counts[b];
    if (total <= 0) return NaN;
    const target = p * total;
    let cum = withBelow && fromBin === 0 ? this.below : 0;
    if (cum >= target && cum > 0) return -Infinity;
    for (let b = fromBin; b < this.bins; b++) {
      cum += this.counts[b];
      if (cum >= target) return this.centre(b);
    }
    return this.centre(this.bins - 1);
  }
}

export class LevelStats {
  constructor(windowMin = 5) {
    this.tickRms = new Float32Array(CAP_TICKS);
    this.tickS = new Float32Array(CAP_TICKS);
    this.secL = new Float64Array(CAP_SECS);
    this.secR = new Float64Array(CAP_SECS);
    this.secK = new Float64Array(CAP_SECS);
    this.secPk = new Float32Array(CAP_SECS);
    this.rmsHist = new WindowHist(-140, 6, 0.2);
    this.sHist = new WindowHist(-70, 10, 0.1);
    this.setWindow(windowMin);
  }

  setWindow(min) {
    this.windowMin = min;
    this.winSecs = Math.min(CAP_SECS, Math.round(min * 60));
    this.winTicks = this.winSecs * 10;
    this.rebuild();
  }

  reset() {
    this.nTicks = 0; this.nSecs = 0;
    this.rmsHist.clear(); this.sHist.clear();
    this.rep = 0; this.aL = 0; this.aR = 0;                  // current tick
    this.sub = [0, 0, 0, 0]; this.subN = 0;                  // last four 100 ms ticks
    this.tk = 0; this.sL = 0; this.sR = 0; this.sK = 0; this.sPk = 0; // current second
    this.cache = null; this.cacheAt = 0;
  }

  // Window changed: rebuild the histograms from what is still in the rings.
  rebuild() {
    if (this.nTicks === undefined) { this.reset(); return; }
    this.rmsHist.clear(); this.sHist.clear();
    const from = Math.max(0, this.nTicks - Math.min(this.winTicks, CAP_TICKS));
    for (let i = from; i < this.nTicks; i++) {
      this.rmsHist.add(this.tickRms[i % CAP_TICKS]);
      this.sHist.add(this.tickS[i % CAP_TICKS]);
    }
    this.cache = null;
  }

  ingest(r) {
    this.aL += r.ms[0]; this.aR += r.ms[1];
    const pk = Math.max(r.tp[0], r.tp[1]);
    if (pk > this.sPk) this.sPk = pk;
    if (++this.rep < REPORTS_PER_TICK) return;

    // --- 100 ms tick
    const mL = this.aL / this.rep, mR = this.aR / this.rep;
    this.rep = 0; this.aL = 0; this.aR = 0;
    this.sub[this.subN % 4] = (mL + mR) / 2; this.subN++;
    const k = Math.min(4, this.subN);
    let s = 0; for (let i = 0; i < k; i++) s += this.sub[i];
    const rms400 = db10(s / k);
    const S = Number.isFinite(r.S) ? r.S : -Infinity;

    if (this.nTicks >= this.winTicks) {
      const old = (this.nTicks - this.winTicks) % CAP_TICKS;
      this.rmsHist.add(this.tickRms[old], -1);
      this.sHist.add(this.tickS[old], -1);
    }
    const slot = this.nTicks % CAP_TICKS;
    this.tickRms[slot] = rms400; this.tickS[slot] = S;
    this.rmsHist.add(rms400); this.sHist.add(S);
    this.nTicks++;

    // --- 1 s point
    this.sL += mL; this.sR += mR;
    this.sK += Number.isFinite(r.M) ? Math.pow(10, (r.M + 0.691) / 10) : 0;
    if (++this.tk < 10) return;
    const j = this.nSecs % CAP_SECS;
    this.secL[j] = this.sL / 10; this.secR[j] = this.sR / 10;
    this.secK[j] = this.sK / 10; this.secPk[j] = this.sPk;
    this.nSecs++;
    this.tk = 0; this.sL = 0; this.sR = 0; this.sK = 0; this.sPk = 0;
  }

  // Figures for both views; recomputed at most twice a second.
  compute(now) {
    if (this.cache && now - this.cacheAt < 0.5) return this.cache;
    const n = Math.min(this.nSecs, this.winSecs);
    let eL = 0, eR = 0, eK = 0, nK = 0, pk = 0, hi = -Infinity, lo = Infinity;
    for (let i = this.nSecs - n; i < this.nSecs; i++) {
      const j = i % CAP_SECS;
      eL += this.secL[j]; eR += this.secR[j];
      const sec = db10((this.secL[j] + this.secR[j]) / 2);
      if (sec > hi) hi = sec;
      if (sec < lo) lo = sec;
      const lk = -0.691 + db10(this.secK[j]);
      if (lk > -70) { eK += this.secK[j]; nK++; }
      if (this.secPk[j] > pk) pk = this.secPk[j];
    }
    const out = {
      secs: n, ticks: Math.min(this.nTicks, this.winTicks), windowSecs: this.winSecs,
      leqL: n ? db10(eL / n) : -Infinity, leqR: n ? db10(eR / n) : -Infinity,
      leq: n ? db10((eL + eR) / 2 / n) : -Infinity,
      lufs: nK ? -0.691 + db10(eK / nK) : -Infinity,
      max: n ? hi : -Infinity, min: n ? lo : -Infinity,
      peak: n ? 20 * Math.log10(Math.max(pk, 1e-10)) : -Infinity,
      ready: Math.min(this.nTicks, this.winTicks) >= MIN_TICKS,
    };
    // noise floor / signal (unweighted 400 ms RMS)
    out.noise = this.rmsHist.pct(0.05);
    out.signal = this.rmsHist.pct(0.95);
    out.snr = out.signal - out.noise;                 // Infinity on digital black
    out.dr = out.peak - out.noise;
    out.crest = out.peak - out.leq;
    out.plr = out.peak - out.lufs;
    // EBU Tech 3342 LRA: abs gate -70 LUFS, relative gate -20 LU, P10..P95
    out.lra = NaN;
    const h = this.sHist;
    if (h.n > 0) {
      const gate = db10(h.energy / h.n) - 20;
      const gb = Math.max(0, h.bin(gate));
      const p10 = h.pct(0.10, false, gb), p95 = h.pct(0.95, false, gb);
      out.lra = Math.max(0, p95 - p10);
    }
    this.cache = out; this.cacheAt = now;
    return out;
  }

  // 1 s history over the window, oldest first: [msL, msR] per point.
  *history() {
    const n = Math.min(this.nSecs, this.winSecs);
    for (let i = this.nSecs - n; i < this.nSecs; i++) {
      const j = i % CAP_SECS;
      yield [this.secL[j], this.secR[j]];
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const COL_L = '#4da3ff', COL_R = '#c792ff';

function colours(canvas) {
  const css = getComputedStyle(canvas);
  const get = (n, d) => css.getPropertyValue(n).trim() || d;
  return {
    text: get('--text', '#e7ebf3'), muted: get('--muted', '#8a93a6'), line: get('--line', '#232a36'),
    ok: get('--meter-green', '#3ddc84'), warn: get('--meter-amber', '#ffb020'), hot: get('--meter-red', '#ff3b3b'),
  };
}

export const fmtDur = (s) => {
  s = Math.round(s);
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Average: level over time with Leq.
export function drawLevelHistory(canvas, stats, settings, now) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const c = colours(canvas);
  const st = stats.compute(now);

  // readouts
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const tile = (x, label, val, unit, col = c.text) => {
    ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`; ctx.fillText(label, x, 7);
    ctx.fillStyle = col; ctx.font = `600 13px ${MONO}`; ctx.fillText(val, x, 21);
    const vw = ctx.measureText(val).width;
    ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`; ctx.fillText(unit, x + vw + 3, 22);
  };
  const cols = 4, tw = w / cols;
  tile(0, 'Leq L', fmtDb(st.leqL), 'dBFS', COL_L);
  tile(tw, 'Leq R', fmtDb(st.leqR), 'dBFS', COL_R);
  const near = Number.isFinite(st.lufs) && Math.abs(st.lufs - settings.target) <= 1;
  tile(tw * 2, 'AVG LOUD', fmtDb(st.lufs), 'LUFS', near ? c.ok : c.text);
  tile(tw * 3, 'MAX / MIN', `${fmtDb(st.max, 0)}/${fmtDb(st.min, 0)}`, '');

  // plot
  const left = 30, right = w - 4, top = 46, bottom = h - 16;
  const pw = right - left, ph = bottom - top;
  const yOf = (db) => bottom - clamp((db + 60) / 60, 0, 1) * ph;
  ctx.font = `600 9px ${MONO}`;
  ctx.textAlign = 'right';
  for (let t = 0; t >= -60; t -= 10) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = c.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = c.muted; ctx.fillText(String(t), left - 4, y);
  }
  // alignment level
  const yr = Math.round(yOf(settings.ref)) + 0.5;
  ctx.setLineDash([2, 3]); ctx.strokeStyle = c.muted;
  ctx.beginPath(); ctx.moveTo(left, yr); ctx.lineTo(right, yr); ctx.stroke();
  ctx.setLineDash([]);

  // time axis
  ctx.textAlign = 'center'; ctx.fillStyle = c.muted;
  const win = stats.winSecs;
  for (let i = 0; i <= 4; i++) {
    const x = left + pw * i / 4;
    const secs = win * (1 - i / 4);
    ctx.fillText(i === 4 ? 'now' : '-' + fmtDur(secs), clamp(x, left + 14, right - 12), h - 6);
  }

  // traces: one column per pixel, power-averaged
  const pts = [...stats.history()];
  const start = win - pts.length;          // window not full yet: data fills from the right
  const drawTrace = (ci, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath();
    let pen = false;
    const cols = Math.max(1, Math.floor(pw));
    let p = 0;
    for (let x = 0; x < cols; x++) {
      const t1 = Math.floor((x + 1) / cols * win) - start;
      let sum = 0, n = 0;
      while (p < pts.length && p < t1) { sum += pts[p][ci]; n++; p++; }
      if (!n) continue;
      const y = yOf(db10(sum / n));
      if (pen) ctx.lineTo(left + x, y); else { ctx.moveTo(left + x, y); pen = true; }
    }
    ctx.stroke();
  };
  drawTrace(0, COL_L);
  drawTrace(1, COL_R);

  // Leq line
  if (Number.isFinite(st.leq) && st.leq > -60) {
    const y = Math.round(yOf(st.leq)) + 0.5;
    ctx.strokeStyle = c.text; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c.text; ctx.textAlign = 'left'; ctx.font = `700 9px ${MONO}`;
    ctx.fillText('Leq', left + 3, y - 6);
  }
  ctx.textAlign = 'right'; ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`;
  ctx.fillText(`RMS dBFS, 1 s · ${fmtDur(st.secs)} of ${fmtDur(win)}`, right, top - 9);
}

// SNR / DR: dynamics figures and the level distribution.
export function drawDynamics(canvas, stats, settings, now) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const c = colours(canvas);
  const st = stats.compute(now);
  const ok = st.ready;
  const f = (v, unit, digits = 1) => {
    if (!ok || Number.isNaN(v)) return ['…', ''];
    if (v === Infinity) return ['∞', unit];
    if (!Number.isFinite(v)) return ['-∞', unit];
    return [v.toFixed(digits), unit];
  };
  const tiles = [
    ['SNR (est.)', ...f(st.snr, 'dB'), 'Loud passages (P95) above the noise floor'],
    ['DYN RANGE', ...f(st.dr, 'dB'), 'Highest peak above the noise floor'],
    ['LRA', ...f(st.lra, 'LU'), 'EBU Tech 3342 loudness range'],
    ['NOISE FLR', ...f(st.noise, 'dBFS'), 'Quietest 5 % of 400 ms blocks'],
    ['CREST', ...f(st.crest, 'dB'), 'Peak above RMS'],
    ['PLR', ...f(st.plr, 'LU'), 'Peak to loudness ratio'],
  ];
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const tw = w / 3;
  tiles.forEach(([label, val, unit], i) => {
    const x = (i % 3) * tw, y = Math.floor(i / 3) * 34;
    ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`; ctx.fillText(label, x, y + 7);
    let col = c.text;
    if (label === 'SNR (est.)' && ok && Number.isFinite(st.snr)) col = st.snr < 30 ? c.hot : st.snr < 50 ? c.warn : c.ok;
    if (label === 'NOISE FLR' && ok && st.noise > -50) col = c.warn;
    ctx.fillStyle = col; ctx.font = `600 15px ${MONO}`; ctx.fillText(val, x, y + 22);
    const vw = ctx.measureText(val).width;
    ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`; ctx.fillText(unit, x + vw + 3, y + 24);
  });

  // distribution of 400 ms RMS levels
  const left = 6, right = w - 6, top = 76, bottom = h - 16;
  const pw = right - left, ph = bottom - top;
  const LO = -100, HI = 0;
  const xOf = (db) => left + clamp((db - LO) / (HI - LO), 0, 1) * pw;
  const hist = stats.rmsHist;
  const cols = Math.max(1, Math.floor(pw / 3));
  const vals = new Float64Array(cols);
  for (let b = 0; b < hist.bins; b++) {
    const v = hist.centre(b);
    if (v < LO || v >= HI || !hist.counts[b]) continue;
    vals[Math.min(cols - 1, Math.floor((v - LO) / (HI - LO) * cols))] += hist.counts[b];
  }
  // digital black (and anything under -100) piles up in the first column
  let below = hist.below;
  for (let b = 0; b < hist.bins && hist.centre(b) < LO; b++) below += hist.counts[b];
  vals[0] += below;
  let mx = 0; for (const v of vals) mx = Math.max(mx, v);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(left, top, pw, ph);
  if (mx > 0) {
    const bw = pw / cols;
    for (let i = 0; i < cols; i++) {
      if (!vals[i]) continue;
      const bh = Math.max(1, Math.sqrt(vals[i] / mx) * ph);   // sqrt so quiet passages stay visible
      const lvl = LO + (i + 0.5) / cols * (HI - LO);
      ctx.fillStyle = lvl >= settings.amber ? c.warn : 'rgba(77,163,255,0.75)';
      ctx.fillRect(left + i * bw, bottom - bh, Math.max(1, bw - 1), bh);
    }
  }
  // axis
  ctx.font = `600 9px ${MONO}`; ctx.textAlign = 'center'; ctx.fillStyle = c.muted;
  for (let t = LO; t <= HI; t += 20) ctx.fillText(String(t), clamp(xOf(t), left + 10, right - 8), h - 6);
  // markers
  const mark = (v, col, label, row) => {
    if (!ok || !Number.isFinite(v)) return;
    const x = Math.round(xOf(v)) + 0.5;
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = col; ctx.font = `700 9px ${MONO}`;
    ctx.textAlign = x > right - 40 ? 'right' : 'left';
    ctx.fillText(label, x + (ctx.textAlign === 'right' ? -3 : 3), top + 7 + row * 11);
  };
  mark(st.noise, c.hot, 'NOISE', 0);
  mark(st.signal, c.ok, 'P95', 1);
  mark(st.peak, c.warn, 'PEAK', 2);
  ctx.textAlign = 'right'; ctx.fillStyle = c.muted; ctx.font = `600 9px ${MONO}`;
  ctx.fillText(ok ? `400 ms RMS, ${fmtDur(st.ticks / 10)} of ${fmtDur(stats.winSecs)}` : 'measuring…', right, top - 5);
}
