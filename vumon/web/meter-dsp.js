// Sample-accurate metering DSP, shared by the AudioWorklet (meter-worklet.js)
// and the ScriptProcessor fallback used on plain-HTTP pages, where browsers
// disable AudioWorklet. Every sample is measured; a report is posted ~30
// times a second.
//
// Per report, per channel:
//   pk  sample peak (linear)
//   tp  true peak, 4x oversampled (linear) - ITU-R BS.1770 style
//   ma  mean absolute value (for the VU meter's rectified average)
//   ms  mean square (unweighted RMS^2, for the average / SNR meters)
// Shared:
//   lr, ll, rr   cross / auto products for the correlation meter
//   M, S, I      momentary (400 ms), short-term (3 s), integrated loudness, LUFS
//   mono         true if the source only has one channel

const HIST_MIN = -70;   // LUFS, absolute gate
const HIST_MAX = 10;
const HIST_STEP = 0.1;
const HIST_BINS = Math.round((HIST_MAX - HIST_MIN) / HIST_STEP);

// K-weighting (BS.1770-4) for any sample rate - same derivation as libebur128.
function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

// 4x oversampling interpolator: 48-tap windowed sinc split into 4 phases,
// each phase normalised to unity gain.
const TP_TAPS = 12;
function tpPhases() {
  const N = TP_TAPS * 4, phases = [];
  for (let p = 0; p < 4; p++) phases.push(new Float32Array(TP_TAPS));
  for (let n = 0; n < N; n++) {
    const x = (n - (N - 1) / 2) / 4;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / N); // Hann
    phases[n % 4][Math.floor(n / 4)] = sinc * w;
  }
  for (const ph of phases) {
    let s = 0; for (const v of ph) s += v;
    for (let i = 0; i < ph.length; i++) ph[i] /= s;
  }
  return phases;
}

class Channel {
  constructor(fs) {
    this.k = kWeighting(fs);
    this.z = new Float64Array(4); // K-weighting biquad state, 2 per stage
    this.hist = new Float32Array(TP_TAPS);
    this.hpos = 0;
    this.reset();
  }
  reset() { this.pk = 0; this.tp = 0; this.sumAbs = 0; this.sumSq = 0; }
}

export class MeterDSP {
  constructor(fs, post) {
    this.fs = fs;
    this.post = post;
    this.reportLen = Math.round(this.fs / 30);
    this.blockLen = Math.round(this.fs / 10);       // 100 ms loudness sub-blocks
    this.ch = [new Channel(this.fs), new Channel(this.fs)];
    this.phases = tpPhases();
    this.n = 0;
    this.lr = 0; this.ll = 0; this.rr = 0;
    this.blockSum = 0; this.blockN = 0;
    this.sub = new Float64Array(30);                // last 30 sub-block mean squares (3 s)
    this.subCount = 0;
    this.mono = false;
    this.resetIntegrated();
  }

  resetIntegrated() {
    this.histCount = new Float64Array(HIST_BINS);
    this.histEnergy = new Float64Array(HIST_BINS);
    this.I = -Infinity;
  }

  meanOf(count) {
    if (this.subCount < count) return -Infinity;
    let s = 0;
    for (let i = 0; i < count; i++) s += this.sub[(this.subCount - 1 - i) % 30];
    return s / count;
  }

  endSubBlock() {
    this.sub[this.subCount % 30] = this.blockSum / this.blockN;
    this.subCount++;
    this.blockSum = 0; this.blockN = 0;

    // 400 ms gating block with 75 % overlap = one new block every 100 ms.
    const e = this.meanOf(4);
    if (e > 0) {
      const l = -0.691 + 10 * Math.log10(e);
      if (l > HIST_MIN) {
        const bin = Math.min(HIST_BINS - 1, Math.floor((l - HIST_MIN) / HIST_STEP));
        this.histCount[bin]++;
        this.histEnergy[bin] += e;
      }
    }
    // Integrated: relative gate at (ungated loudness - 10 LU)
    let n = 0, s = 0;
    for (let i = 0; i < HIST_BINS; i++) { n += this.histCount[i]; s += this.histEnergy[i]; }
    if (n === 0) { this.I = -Infinity; return; }
    const gate = -0.691 + 10 * Math.log10(s / n) - 10;
    n = 0; s = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      if (HIST_MIN + (i + 0.5) * HIST_STEP > gate) { n += this.histCount[i]; s += this.histEnergy[i]; }
    }
    this.I = n ? -0.691 + 10 * Math.log10(s / n) : -Infinity;
  }

  // input: array of Float32Array channel buffers (1 = mono, 2+ = first two used)
  // sameChannels: caller saw identical L and R (an upmixed mono source); show
  // MONO but still measure both channels.
  process(input, sameChannels = false) {
    if (!input || input.length === 0) return;
    const mono = input.length === 1;
    this.mono = mono || sameChannels;
    const L = input[0], R = mono ? input[0] : input[1];
    const frames = L.length;
    const chans = mono ? 1 : 2;
    const phases = this.phases;

    for (let i = 0; i < frames; i++) {
      let kSum = 0;
      for (let c = 0; c < chans; c++) {
        const x = c === 0 ? L[i] : R[i];
        const ch = this.ch[c];
        const a = x < 0 ? -x : x;
        if (a > ch.pk) ch.pk = a;
        ch.sumAbs += a;
        ch.sumSq += x * x;

        // true peak
        ch.hist[ch.hpos] = x;
        ch.hpos = (ch.hpos + 1) % TP_TAPS;
        for (let p = 0; p < 4; p++) {
          const h = phases[p];
          let y = 0, idx = ch.hpos;
          for (let t = TP_TAPS - 1; t >= 0; t--) { y += h[t] * ch.hist[idx]; idx = (idx + 1) % TP_TAPS; }
          const ay = y < 0 ? -y : y;
          if (ay > ch.tp) ch.tp = ay;
        }

        // K-weighting, two biquads, transposed direct form II
        const [s1, s2] = ch.k, z = ch.z;
        const y1 = s1.b0 * x + z[0];
        z[0] = s1.b1 * x - s1.a1 * y1 + z[1];
        z[1] = s1.b2 * x - s1.a2 * y1;
        const y2 = s2.b0 * y1 + z[2];
        z[2] = s2.b1 * y1 - s2.a1 * y2 + z[3];
        z[3] = s2.b2 * y1 - s2.a2 * y2;
        kSum += y2 * y2;
      }
      if (!mono) { const l = L[i], r = R[i]; this.lr += l * r; this.ll += l * l; this.rr += r * r; }
      this.blockSum += kSum; this.blockN++;
      if (this.blockN >= this.blockLen) this.endSubBlock();

      if (++this.n >= this.reportLen) this.report();
    }
  }

  report() {
    const [a, b] = this.ch;
    const mono = this.mono;
    const lufs = (e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
    const bb = mono ? a : b;
    this.post({
      pk: [a.pk, bb.pk], tp: [Math.max(a.tp, a.pk), Math.max(bb.tp, bb.pk)],
      ma: [a.sumAbs / this.n, bb.sumAbs / this.n],
      ms: [a.sumSq / this.n, bb.sumSq / this.n],
      lr: mono ? 1 : this.lr, ll: mono ? 1 : this.ll, rr: mono ? 1 : this.rr,
      M: lufs(this.meanOf(4)), S: lufs(this.meanOf(30)), I: this.I, mono,
    });
    a.reset(); b.reset();
    this.n = 0; this.lr = 0; this.ll = 0; this.rr = 0;
  }
}

