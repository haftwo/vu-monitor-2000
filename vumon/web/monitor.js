import { MeterState, drawDigital, drawAnalog, analogHeightFor, fmtDb } from './meters.js';

// ---------------------------------------------------------------------------
// Settings (per browser)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'digital',      // 'digital' | 'analog'
  ref: -18,             // dBFS that reads 0 VU (alignment level)
  peak: 'tp',           // 'tp' (true peak) | 'sample'
  amber: -9,            // dBFS: digital meter turns amber (permitted max level)
  red: -1,              // dBFS/dBTP: red zone and peak LEDs
  hold: 2,              // seconds of peak hold
  silenceDb: -50,       // below this ...
  silenceSec: 10,       // ... for this long = silence alarm
  target: -23,          // loudness target, LUFS
  volume: 0.8,
  soloExclusive: true,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('vumon.settings') || '{}') };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('vumon.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}
const settings = loadSettings();

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------

let audioCtx = null;
let master = null;
let hlsLoader = null;

function loadHls() {
  if (hlsLoader) return hlsLoader;
  const tryLoad = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => (window.Hls ? resolve(window.Hls) : reject());
    s.onerror = reject;
    document.head.appendChild(s);
  });
  hlsLoader = tryLoad('vendor/hls.min.js')
    .catch(() => tryLoad('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js'))
    .catch(() => null);
  return hlsLoader;
}

let useWorklet = false;
let MeterDSP = null;

async function startAudio() {
  audioCtx = new AudioContext({ latencyHint: 'playback' });
  // AudioWorklet only exists on secure pages (HTTPS or localhost). On plain
  // HTTP, e.g. http://unraid:8080, fall back to a ScriptProcessor running the
  // same DSP on the main thread.
  if (audioCtx.audioWorklet && window.isSecureContext) {
    await audioCtx.audioWorklet.addModule('meter-worklet.js');
    useWorklet = true;
  } else {
    ({ MeterDSP } = await import('./meter-dsp.js'));
    console.info('Not a secure context: using ScriptProcessor metering');
  }
  master = audioCtx.createGain();
  master.gain.value = settings.volume;
  master.connect(audioCtx.destination);
  await audioCtx.resume();
}

// ---------------------------------------------------------------------------
// One monitored stream
// ---------------------------------------------------------------------------

const RETRY_MAX = 30;

class StreamMonitor {
  constructor(cfg) {
    this.cfg = cfg;
    this.meter = new MeterState();
    this.status = 'idle';
    this.detail = '';
    this.listening = false;
    this.retries = 0;
    this.buildCard();
  }

  get playUrl() {
    return this.cfg.proxy ? 'proxy?u=' + encodeURIComponent(this.cfg.url) : this.cfg.url;
  }

  get isHls() { return /\.m3u8?($|\?)/i.test(this.cfg.url) || /m3u8/i.test(this.cfg.url); }

  // -- DOM -----------------------------------------------------------------

  buildCard() {
    const el = document.createElement('section');
    el.className = 'card';
    el.innerHTML = `
      <header class="card-head">
        <div class="title">
          <span class="led" aria-hidden="true"></span>
          <h2></h2>
        </div>
        <div class="badges">
          <span class="badge b-mono" hidden>MONO</span>
          <span class="badge b-silence" hidden>SILENCE</span>
          <span class="badge b-status"></span>
          <button class="icon-btn listen" title="Listen (solo)" aria-pressed="false">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z"/></svg>
          </button>
        </div>
      </header>
      <canvas class="meter"></canvas>
      <footer class="card-foot">
        <div class="loud" title="EBU R128 loudness. Click to reset integrated.">
          <span><em>M</em><b class="lM">-∞</b></span>
          <span><em>S</em><b class="lS">-∞</b></span>
          <span><em>I</em><b class="lI">-∞</b></span>
          <small>LUFS</small>
        </div>
        <div class="corr" title="Phase correlation: +1 mono-compatible, 0 wide, -1 out of phase">
          <span class="corr-scale"><i>-1</i><i>0</i><i>+1</i></span>
          <span class="corr-track"><span class="corr-dot"></span></span>
        </div>
        <div class="info"></div>
      </footer>`;
    this.el = el;
    this.$ = (s) => el.querySelector(s);
    this.canvas = this.$('canvas');
    this.$('h2').textContent = this.cfg.name;
    this.$('h2').title = this.cfg.notes || this.cfg.url;
    this.$('.listen').addEventListener('click', () => toggleListen(this));
    this.$('.loud').addEventListener('click', () => this.resetIntegrated());
    this.canvas.addEventListener('click', () => this.meter.resetPeaks());
    this.canvas.title = 'Click to reset peak / OVER';
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    const b = this.$('.b-status');
    const labels = { idle: 'IDLE', connecting: 'CONNECTING', live: 'LIVE', buffering: 'BUFFERING',
      error: 'ERROR', stalled: 'NO AUDIO' };
    b.textContent = labels[status] || status.toUpperCase();
    b.dataset.state = status;
    b.title = detail;
    this.el.dataset.state = status;
  }

  // -- playback ------------------------------------------------------------

  async start() {
    this.stop();
    this.setStatus('connecting');
    const media = document.createElement('video');
    media.playsInline = true;
    media.preload = 'auto';
    if (!this.cfg.proxy) media.crossOrigin = 'anonymous';
    this.media = media;

    this.source = audioCtx.createMediaElementSource(media);
    const onReport = (r) => this.meter.ingest(r, settings, performance.now() / 1000);
    if (useWorklet) {
      this.worklet = new AudioWorkletNode(audioCtx, 'meter-processor', { numberOfInputs: 1, numberOfOutputs: 1 });
      this.worklet.port.onmessage = (e) => onReport(e.data);
      this.resetI = () => this.worklet?.port.postMessage('resetI');
    } else {
      const dsp = new MeterDSP(audioCtx.sampleRate, onReport);
      this.worklet = audioCtx.createScriptProcessor(2048, 2, 1);
      this.worklet.onaudioprocess = (e) => {
        const b = e.inputBuffer;
        const L = b.getChannelData(0), R = b.getChannelData(1);
        let same = true, any = false;
        for (let i = 0; i < L.length; i += 7) {
          if (L[i] !== R[i]) { same = false; break; }
          if (L[i] !== 0) any = true;
        }
        dsp.process([L, R], same && any);
      };
      this.resetI = () => dsp.resetIntegrated();
    }
    this.listenGain = audioCtx.createGain();
    this.listenGain.gain.value = this.listening ? 1 : 0;
    this.source.connect(this.worklet);
    this.worklet.connect(audioCtx.destination); // silent output; keeps the worklet running
    this.source.connect(this.listenGain).connect(master);

    media.addEventListener('playing', () => { this.retries = 0; this.setStatus('live'); });
    media.addEventListener('waiting', () => this.setStatus('buffering'));
    media.addEventListener('error', () => {
      if (!this.hls) this.fail(media.error ? `Media error ${media.error.code}` : 'Media error');
    });
    media.addEventListener('ended', () => this.fail('Stream ended'));

    const Hls = await loadHls();
    if (this.media !== media) return; // stopped while loading
    if (this.isHls && Hls && Hls.isSupported()) {
      this.startHls(Hls, media);
    } else {
      media.src = this.playUrl;
      media.play().catch((e) => this.fail(e.message));
    }

    // watchdog: playback position must keep moving
    this.lastTime = -1; this.lastMove = performance.now();
    this.watchdog = setInterval(() => {
      if (!this.media) return;
      const t = this.media.currentTime;
      if (t !== this.lastTime) { this.lastTime = t; this.lastMove = performance.now(); }
      else if (performance.now() - this.lastMove > 15000 && this.status !== 'error') {
        this.fail('Playback stalled');
      }
      if (this.status === 'live' && performance.now() / 1000 - this.meter.lastReport > 3) {
        this.setStatus('stalled', 'No audio samples arriving');
      }
    }, 2000);
  }

  startHls(Hls, media) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      maxBufferLength: 12,
      backBufferLength: 10,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 4,
    });
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      // Monitor the best-quality rendition, and stay on it.
      if (data.levels.length > 1) {
        let best = 0;
        data.levels.forEach((l, i) => { if ((l.bitrate || 0) > (data.levels[best].bitrate || 0)) best = i; });
        hls.currentLevel = best;
      }
      media.play().catch((e) => this.fail(e.message));
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const l = hls.levels[data.level];
      if (!l) return;
      const codec = l.audioCodec || l.attrs?.CODECS || '';
      const kbps = l.bitrate ? Math.round(l.bitrate / 1000) + ' kb/s' : '';
      this.$('.info').textContent = [codec, kbps].filter(Boolean).join(' · ');
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
        this.mediaRecovered = true;
        hls.recoverMediaError();
        return;
      }
      const why = data.response?.code ? `HTTP ${data.response.code}` : data.details;
      this.fail(why);
    });
    hls.loadSource(this.playUrl);
    hls.attachMedia(media);
  }

  fail(reason) {
    if (!this.media) return;
    const wait = Math.min(RETRY_MAX, 2 ** Math.min(this.retries, 5));
    this.retries++;
    this.teardown();
    this.meter.vuIn = [0, 0];
    let left = wait;
    this.setStatus('error', `${reason} — retrying in ${left}s`);
    this.retryTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(this.retryTimer); this.retryTimer = null; this.start(); }
      else this.setStatus('error', `${reason} — retrying in ${left}s`);
    }, 1000);
    console.warn(`[${this.cfg.name}] ${reason}`);
  }

  teardown() {
    clearInterval(this.watchdog);
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.media) { this.media.pause(); this.media.removeAttribute('src'); this.media.load(); }
    if (this.worklet) this.worklet.onaudioprocess = null;
    for (const n of [this.source, this.worklet, this.listenGain]) { try { n?.disconnect(); } catch { /* */ } }
    this.media = this.source = this.worklet = this.listenGain = null;
    this.mediaRecovered = false;
  }

  stop() {
    clearInterval(this.retryTimer); this.retryTimer = null;
    this.teardown();
    this.setStatus('idle');
  }

  setListening(on) {
    this.listening = on;
    this.$('.listen').setAttribute('aria-pressed', String(on));
    this.el.classList.toggle('listening', on);
    if (this.listenGain) this.listenGain.gain.setTargetAtTime(on ? 1 : 0, audioCtx.currentTime, 0.02);
  }

  resetIntegrated() { this.resetI?.(); }

  // -- drawing -------------------------------------------------------------

  draw(dt, now) {
    const m = this.meter;
    m.tick(dt, settings, now);
    if (settings.mode === 'analog') {
      const h = analogHeightFor(this.canvas.clientWidth);
      if (this.canvas.style.height !== h + 'px') this.canvas.style.height = h + 'px';
      drawAnalog(this.canvas, m, settings, now);
    } else {
      if (this.canvas.style.height !== '') this.canvas.style.height = '';
      drawDigital(this.canvas, m, settings, now);
    }

    // footer, ~10 Hz is plenty
    if (now - (this.footAt || 0) > 0.1) {
      this.footAt = now;
      const set = (sel, v, cls) => { const e = this.$(sel); e.textContent = fmtDb(v); e.className = sel.slice(1) + (cls ? ' ' + cls : ''); };
      const near = (v) => (Number.isFinite(v) && Math.abs(v - settings.target) <= 1 ? 'on-target'
        : Number.isFinite(v) && v > settings.target + 2 ? 'hot' : '');
      set('.lM', m.M, near(m.M)); set('.lS', m.S, near(m.S)); set('.lI', m.I, near(m.I));
      const dot = this.$('.corr-dot');
      if (m.corr === null || m.mono) { dot.style.opacity = m.mono ? 1 : 0.25; dot.style.left = (m.mono ? 100 : 50) + '%'; }
      else { dot.style.opacity = 1; dot.style.left = ((m.corr + 1) / 2 * 100) + '%'; }
      dot.classList.toggle('neg', m.corr !== null && m.corr < 0 && !m.mono);
      this.$('.b-mono').hidden = !m.mono || this.status !== 'live';
      const silent = m.silent && this.status === 'live';
      this.$('.b-silence').hidden = !silent;
      this.el.classList.toggle('alarm', silent || this.status === 'error' || this.status === 'stalled');
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const grid = document.getElementById('grid');
const monitors = new Map();     // id -> StreamMonitor
let revision = -1;
let running = false;

function toggleListen(mon) {
  const on = !mon.listening;
  if (on && settings.soloExclusive) for (const m of monitors.values()) if (m !== mon) m.setListening(false);
  mon.setListening(on);
}

async function syncStreams() {
  let data;
  try {
    const res = await fetch('api/streams', { cache: 'no-store' });
    data = await res.json();
  } catch {
    document.getElementById('conn').hidden = false;
    return;
  }
  document.getElementById('conn').hidden = true;
  if (data.revision === revision) return;
  revision = data.revision;

  const seen = new Set();
  for (const cfg of data.streams) {
    seen.add(cfg.id);
    let mon = monitors.get(cfg.id);
    if (mon && (mon.cfg.url !== cfg.url || mon.cfg.proxy !== cfg.proxy)) {
      mon.stop(); mon.el.remove(); monitors.delete(cfg.id); mon = null;
    }
    if (!mon) {
      mon = new StreamMonitor(cfg);
      monitors.set(cfg.id, mon);
      if (running) mon.start();
    } else {
      mon.cfg = cfg;
      mon.$('h2').textContent = cfg.name;
      mon.$('h2').title = cfg.notes || cfg.url;
    }
    grid.appendChild(mon.el); // keeps admin ordering
  }
  for (const [id, mon] of monitors) {
    if (!seen.has(id)) { mon.stop(); mon.el.remove(); monitors.delete(id); }
  }
  document.getElementById('empty').hidden = monitors.size > 0;
  document.getElementById('count').textContent =
    `${monitors.size} stream${monitors.size === 1 ? '' : 's'}`;
}

let lastFrame = performance.now();
function frame(t) {
  const dt = (t - lastFrame) / 1000;
  lastFrame = t;
  const now = t / 1000;
  for (const m of monitors.values()) m.draw(dt, now);
  requestAnimationFrame(frame);
}

// -- controls ----------------------------------------------------------------

function applyMode() {
  document.body.dataset.mode = settings.mode;
  for (const b of document.querySelectorAll('[data-set-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.setMode === settings.mode));
  }
}

function bindControls() {
  for (const b of document.querySelectorAll('[data-set-mode]')) {
    b.addEventListener('click', () => { settings.mode = b.dataset.setMode; saveSettings(); applyMode(); });
  }
  const bindSelect = (id, key, parse = Number) => {
    const el = document.getElementById(id);
    el.value = String(settings[key]);
    el.addEventListener('change', () => { settings[key] = parse(el.value); saveSettings(); });
  };
  bindSelect('ref', 'ref');
  bindSelect('peakmode', 'peak', String);
  bindSelect('s-amber', 'amber');
  bindSelect('s-red', 'red');
  bindSelect('s-hold', 'hold');
  bindSelect('s-silence-db', 'silenceDb');
  bindSelect('s-silence-sec', 'silenceSec');
  bindSelect('s-target', 'target');
  const solo = document.getElementById('s-solo');
  solo.checked = settings.soloExclusive;
  solo.addEventListener('change', () => { settings.soloExclusive = solo.checked; saveSettings(); });

  const vol = document.getElementById('volume');
  vol.value = settings.volume;
  vol.addEventListener('input', () => {
    settings.volume = Number(vol.value); saveSettings();
    if (master) master.gain.setTargetAtTime(settings.volume, audioCtx.currentTime, 0.02);
  });

  document.getElementById('reset-peaks').addEventListener('click', () => {
    for (const m of monitors.values()) m.meter.resetPeaks();
  });
  document.getElementById('reset-loudness').addEventListener('click', () => {
    for (const m of monitors.values()) m.resetIntegrated();
  });
  document.getElementById('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  const dlg = document.getElementById('settings');
  document.getElementById('open-settings').addEventListener('click', () => dlg.showModal());
  document.getElementById('restore-defaults').addEventListener('click', () => {
    try { localStorage.removeItem('vumon.settings'); } catch { /* */ }
    location.reload();
  });

  document.getElementById('start').addEventListener('click', async () => {
    const btn = document.getElementById('start');
    btn.disabled = true;
    try {
      await startAudio();
    } catch (e) {
      btn.disabled = false;
      document.getElementById('start-error').textContent = 'Could not start audio: ' + e.message;
      return;
    }
    document.getElementById('gate').remove();
    running = true;
    for (const m of monitors.values()) m.start();
  });

  // Keyboard: D/A switch meters, R resets peaks, 1-9 solo a stream, 0/Esc stops listening
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, dialog')) return;
    if (e.key === 'd') { settings.mode = 'digital'; saveSettings(); applyMode(); }
    else if (e.key === 'a') { settings.mode = 'analog'; saveSettings(); applyMode(); }
    else if (e.key === 'r') document.getElementById('reset-peaks').click();
    else if (e.key === '0' || e.key === 'Escape') for (const m of monitors.values()) m.setListening(false);
    else if (/^[1-9]$/.test(e.key)) {
      const m = [...monitors.values()][Number(e.key) - 1];
      if (m) toggleListen(m);
    }
  });
}

if (new URLSearchParams(location.search).has('kiosk')) document.body.classList.add('kiosk');
// handy from the browser console: vumon.monitors, vumon.settings
window.vumon = { monitors, settings };

applyMode();
bindControls();
await syncStreams();
setInterval(syncStreams, 10000);
requestAnimationFrame(frame);
