// Frequency response: 1/3-octave real-time analyser (IEC 61260 band centres,
// 20 Hz - 20 kHz) with peak hold and a long-term average curve, which shows
// the programme's overall tonal balance since the last reset.
//
// Uses Web Audio AnalyserNodes (works on plain HTTP too). Bands are built by
// summing FFT bin power, calibrated so a full-scale sine reads 0 dBFS in its
// band and noise reads its true in-band level.

import { fitCanvas } from './meters.js';

const FFT = 16384;                         // ~2.9 Hz bins at 48 kHz: enough for the 20 Hz band
const BLACKMAN_MS = 0.3046;                // mean(w^2) of the Blackman window AnalyserNode uses
const CAL = 4 / BLACKMAN_MS;               // positive-bin power -> sine-peak-referenced power
const RATE = 15;                           // analysis updates per second
export const BANDS = Array.from({ length: 31 }, (_, i) => 1000 * Math.pow(2, (i - 17) / 3));
const LABELS = { 31.5: '31', 63: '63', 125: '125', 250: '250', 500: '500', 1000: '1k', 2000: '2k', 4000: '4k', 8000: '8k', 16000: '16k' };
const DB_LO = -90, DB_HI = 0;

const db10 = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class SpectrumState {
  constructor() { this.reset(); }

  reset() {
    this.live = new Float64Array(BANDS.length);       // smoothed band power
    this.hold = new Float64Array(BANDS.length).fill(-Infinity);  // dB
    this.holdAt = new Float64Array(BANDS.length);
    this.avgSum = new Float64Array(BANDS.length);
    this.avgN = 0;
    this.last = 0;
  }

  // Tap the stream's source node. `sink` is a muted node to the destination
  // that keeps the analysers pulled.
  attach(ctx, source, sink) {
    this.detach();
    // Force two channels so a mono source feeds both analysers.
    this.pre = ctx.createGain();
    this.pre.channelCount = 2;
    this.pre.channelCountMode = 'explicit';
    this.pre.channelInterpretation = 'speakers';
    this.split = ctx.createChannelSplitter(2);
    this.an = [0, 1].map((c) => {
      const a = ctx.createAnalyser();
      a.fftSize = FFT;
      a.smoothingTimeConstant = 0;
      a.minDecibels = -160; a.maxDecibels = 0;
      this.split.connect(a, c);
      a.connect(sink);
      return a;
    });
    source.connect(this.pre).connect(this.split);
    this.buf = new Float32Array(FFT / 2);
    const binHz = ctx.sampleRate / FFT;
    const nyq = ctx.sampleRate / 2;
    this.ranges = BANDS.map((fc) => {
      const lo = fc * Math.pow(2, -1 / 6), hi = Math.min(fc * Math.pow(2, 1 / 6), nyq);
      if (lo >= nyq) return null;
      let k0 = Math.ceil(lo / binHz), k1 = Math.floor(hi / binHz);
      if (k1 < k0) { k0 = k1 = Math.round(fc / binHz); }   // band narrower than a bin
      return [k0, Math.min(k1, FFT / 2 - 1)];
    });
  }

  detach() {
    for (const n of [this.pre, this.split, ...(this.an || [])]) { try { n?.disconnect(); } catch { /* */ } }
    this.pre = this.split = this.an = null;
  }

  // Called every animation frame; analyses at RATE Hz.
  sample(now, settings, running) {
    if (!this.an || now - this.last < 1 / RATE) return;
    const dt = this.last ? Math.min(0.5, now - this.last) : 1 / RATE;
    this.last = now;
    const p = new Float64Array(BANDS.length);
    for (const a of this.an) {
      a.getFloatFrequencyData(this.buf);
      this.ranges.forEach((r, b) => {
        if (!r) return;
        let s = 0;
        for (let k = r[0]; k <= r[1]; k++) s += Math.pow(10, this.buf[k] / 10);
        p[b] += s * CAL / 2;                          // mean of L and R
      });
    }
    const tau = settings.rtaSpeed === 'slow' ? 1 : 0.125;
    const k = 1 - Math.exp(-dt / tau);
    let total = 0;
    for (let b = 0; b < BANDS.length; b++) {
      this.live[b] += (p[b] - this.live[b]) * k;
      total += p[b];
      const v = db10(this.live[b]);
      if (v >= this.hold[b]) { this.hold[b] = v; this.holdAt[b] = now; }
      else if (now - this.holdAt[b] > settings.hold) this.hold[b] = Math.max(v, this.hold[b] - 20 * dt);
    }
    // long-term average, skipping silence and stalls
    if (running && total > 1e-9) {
      for (let b = 0; b < BANDS.length; b++) this.avgSum[b] += p[b];
      this.avgN++;
    }
  }

  avg(b) { return this.avgN ? db10(this.avgSum[b] / this.avgN) : -Infinity; }
}

export function drawSpectrum(canvas, sp, settings, now) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  const get = (n, d) => css.getPropertyValue(n).trim() || d;
  const muted = get('--muted', '#8a93a6'), text = get('--text', '#e7ebf3'), line = get('--line', '#232a36');
  const warn = get('--meter-amber', '#ffb020'), hot = get('--meter-red', '#ff3b3b');

  const left = 28, right = w - 4, top = 18, bottom = h - 16;
  const pw = right - left, ph = bottom - top;
  const yOf = (db) => bottom - clamp((db - DB_LO) / (DB_HI - DB_LO), 0, 1) * ph;
  const n = BANDS.length, bw = pw / n;

  ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let t = DB_HI; t >= DB_LO; t -= 10) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    if (t % 20 === 0) { ctx.fillStyle = muted; ctx.fillText(String(t), left - 4, y); }
  }
  ctx.textAlign = 'center';
  BANDS.forEach((fc, b) => {
    const nominal = Object.keys(LABELS).find((k) => Math.abs(Number(k) / fc - 1) < 0.03);
    if (!nominal) return;
    ctx.fillStyle = muted;
    ctx.fillText(LABELS[nominal], left + (b + 0.5) * bw, h - 6);
  });

  // live bars, coloured by the meter zones
  const g = ctx.createLinearGradient(0, bottom, 0, top);
  g.addColorStop(0, 'rgba(61,220,132,0.35)');
  g.addColorStop(1, 'rgba(61,220,132,0.9)');
  for (let b = 0; b < n; b++) {
    if (!sp.ranges || !sp.ranges[b]) continue;
    const v = db10(sp.live[b]);
    const x = left + b * bw + 1, bwi = Math.max(1, bw - 2);
    if (v > DB_LO) {
      const y = yOf(v);
      ctx.fillStyle = v >= settings.red ? hot : v >= settings.amber ? warn : g;
      ctx.fillRect(x, y, bwi, bottom - y);
    }
    const hv = sp.hold[b];
    if (hv > DB_LO) {
      ctx.fillStyle = hv >= settings.red ? hot : text;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x, Math.round(yOf(hv)) - 1, bwi, 2);
      ctx.globalAlpha = 1;
    }
  }

  // long-term average curve
  if (sp.avgN) {
    ctx.strokeStyle = warn; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let b = 0; b < n; b++) {
      const v = sp.avg(b);
      if (!sp.ranges?.[b] || !(v > DB_LO)) { pen = false; continue; }
      const x = left + (b + 0.5) * bw, y = yOf(v);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }

  // legend
  ctx.textAlign = 'left'; ctx.fillStyle = muted;
  ctx.fillText(`1/3 oct · dBFS · ${settings.rtaSpeed === 'slow' ? 'slow' : 'fast'}`, left, 7);
  ctx.textAlign = 'right';
  ctx.fillStyle = warn; ctx.fillText('━ average', right, 7);
  const aw = ctx.measureText('━ average').width;
  ctx.fillStyle = text; ctx.fillText('▬ peak  ', right - aw, 7);
}
