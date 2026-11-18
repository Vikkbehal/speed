(() => {
const $ = id => document.getElementById(id);
const BASE = 'https://speed.cloudflare.com';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// theme
$('themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch {}
  draw();
};

function setWifi(q) {
  const el = $('wifi'); const lv = q == null ? -1 : q >= 75 ? 3 : q >= 50 ? 2 : q >= 25 ? 1 : 0;
  el.style.color = q == null ? '' : qInfo(q)[1];
  ['w0', 'w1', 'w2', 'w3'].forEach((c, i) => el.querySelector('.' + c).classList.toggle('on', i <= lv));
  el.querySelector('title').textContent = q == null ? 'Wi-Fi signal' : `Wi-Fi signal: ${q}/100`;
}
setWifi(null);

const mbps = (bytes, ms) => bytes * 8 / (ms / 1000) / 1e6;
const fmt = n => n >= 100 ? Math.round(n) : n.toFixed(1);
const setStatus = s => $('status').textContent = s;

// ---- measurements ----
async function pingOnce(signal) {
  const t = performance.now();
  await fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`, { cache: 'no-store', signal });
  return performance.now() - t;
}
async function pingTest(n = 10, signal) {
  const s = [];
  for (let i = 0; i < n; i++) { try { s.push(await pingOnce(signal)); } catch (e) { if (signal?.aborted) throw e; } }
  if (!s.length) throw new Error('offline');
  const avg = s.reduce((a, b) => a + b) / s.length;
  const jit = s.length > 1 ? s.slice(1).reduce((a, v, i) => a + Math.abs(v - s[i]), 0) / (s.length - 1) : 0;
  return { ping: Math.min(...s), jitter: jit, avg };
}
async function download(durationMs, onProgress, signal) {
  const ctl = new AbortController();
  signal?.addEventListener('abort', () => ctl.abort());
  let bytes = 0; const start = performance.now();
  const stop = setTimeout(() => ctl.abort(), durationMs);
  const worker = async () => {
    try {
      const r = await fetch(`${BASE}/__down?bytes=50000000&r=${Math.random()}`, { cache: 'no-store', signal: ctl.signal });
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        bytes += value.length;
        onProgress?.(mbps(bytes, performance.now() - start));
      }
    } catch {}
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  clearTimeout(stop);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return mbps(bytes, performance.now() - start);
}
function upload(durationMs, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const chunk = new Uint8Array(2e6); // zeros are fine; compressed uploads are not used
    for (let i = 0; i < chunk.length; i += 4096) chunk[i] = i & 255;
    const start = performance.now(); let total = 0, active = 0, done = false;
    const sent = new Map();
    const finish = () => { if (done) return; done = true; if (signal?.aborted) reject(new DOMException('aborted', 'AbortError')); else resolve(mbps(total, performance.now() - start)); };
    const run = () => {
      if (done) return;
      if (performance.now() - start > durationMs) { if (active === 0) finish(); return; }
      const x = new XMLHttpRequest(); active++;
      x.open('POST', `${BASE}/__up`);
      x.upload.onprogress = e => { total += e.loaded - (sent.get(x) || 0); sent.set(x, e.loaded); onProgress?.(mbps(total, performance.now() - start)); };
      const end = () => { active--; run(); if (active === 0 && performance.now() - start > durationMs) finish(); };
      x.onload = end; x.onerror = end; x.onabort = end;
      signal?.addEventListener('abort', () => x.abort());
      x.send(chunk);
    };
    run(); run(); run();
    signal?.addEventListener('abort', () => setTimeout(finish, 50));
  });
}

// ---- quality score (relative to your best reading) ----
const peak = { dl: 0, ping: Infinity };
function getRef() {
  let dl = peak.dl, ping = peak.ping;
  return { dl, ping };
}
function trackBest(dl, ping) { peak.dl = Math.max(peak.dl, dl); peak.ping = Math.min(peak.ping, ping); }
function quality(speed, ping) {
  const ref = getRef();
  if (!ref.dl || !isFinite(ref.ping)) { // no reference yet: absolute fallback
    const s = Math.min(1, Math.log(1 + speed) / Math.log(1 + 150));
    const l = Math.max(0, Math.min(1, 1 - (ping - 20) / 180));
    return Math.round((0.65 * s + 0.35 * l) * 100);
  }
  const s = Math.min(1, speed / ref.dl);
  const l = Math.min(1, (ref.ping + 10) / (ping + 10));
  return Math.round((0.7 * s + 0.3 * l) * 100);
}
function refNote() {
  const r = getRef();
  $('qNote').textContent = r.dl ? `Compared with your best so far: ${fmt(r.dl)} Mbps, ${fmt(r.ping)} ms` : '';
}
function qInfo(q) { return q >= 75 ? ['Excellent', 'var(--good)'] : q >= 50 ? ['Good', 'var(--good)'] : q >= 30 ? ['Fair', 'var(--ok)'] : ['Weak', 'var(--bad)']; }
function showQuality(q) {
  const [label, color] = qInfo(q);
  $('q').textContent = q; $('qLabel').textContent = label;
  setWifi(q); $('qBar').style.width = q + '%'; $('qBar').style.background = color;
}

// ---- chart ----
const hist = { dl: [], q: [] }; const MAX = 60;
function draw() {
  const cv = $('chart'), dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = n => css.getPropertyValue(n).trim();
  const pad = { l: 36, r: 8, t: 8, b: 8 };
  const max = Math.max(10, ...hist.dl) * 1.15;
  c.font = '11px Inter, sans-serif'; c.fillStyle = col('--muted'); c.strokeStyle = col('--border'); c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h - pad.t - pad.b) * i / 4;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke();
    c.textAlign = 'right'; c.fillText(Math.round(max * (1 - i / 4)), pad.l - 6, y + 4);
  }
  const line = (arr, top, color, fill) => {
    if (arr.length < 2) return;
    const x = i => pad.l + (w - pad.l - pad.r) * (MAX - arr.length + i) / (MAX - 1);
    const y = v => pad.t + (h - pad.t - pad.b) * (1 - v / top);
    c.beginPath(); arr.forEach((v, i) => i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)));
    c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
    if (fill) { c.lineTo(x(arr.length - 1), h - pad.b); c.lineTo(x(0), h - pad.b); c.closePath(); c.globalAlpha = .1; c.fillStyle = color; c.fill(); c.globalAlpha = 1; }
  };
  line(hist.dl, max, col('--a'), true);
  line(hist.q, 100, col('--b'), false);
}
addEventListener('resize', draw);
const push = (dl, q) => { hist.dl.push(dl); hist.q.push(q); if (hist.dl.length > MAX) { hist.dl.shift(); hist.q.shift(); } draw(); };

// ---- speed test ----
let busy = null; // AbortController for whichever mode is running
const last = { dl: null, ping: null, q: null };
$('testBtn').onclick = async () => {
  if (busy) return;
  busy = new AbortController(); const sig = busy.signal;
  $('testBtn').disabled = true; $('liveBtn').disabled = true;
  try {
    setStatus('Measuring ping…');
    const p = await pingTest(10, sig);
    $('ping').textContent = fmt(p.ping); $('jit').textContent = fmt(p.jitter);
    setStatus('Testing download…');
    const dl = await download(8000, v => $('dl').textContent = fmt(v), sig);
    $('dl').textContent = fmt(dl);
    setStatus('Testing upload…');
    const ul = await upload(6000, v => $('ul').textContent = fmt(v), sig);
    $('ul').textContent = fmt(ul);
    trackBest(dl, p.ping); const q = quality(dl, p.ping); showQuality(q); refNote();
    Object.assign(last, { dl, ping: p.ping, q });
    setStatus('Done.');
  } catch (e) { setStatus(sig.aborted ? 'Stopped.' : 'Test failed. Check your connection.'); }
  busy = null; $('testBtn').disabled = false; $('liveBtn').disabled = false;
};

// ---- live mode ----
const sleep = (ms, sig) => new Promise(res => { const t = setTimeout(res, ms); sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
let kick = null; // aborts the in-flight request when the network changes
const nudge = () => kick && kick.abort();
addEventListener('online', nudge); addEventListener('offline', nudge);
if (navigator.connection) navigator.connection.addEventListener?.('change', nudge);

async function liveSample(sig, state) {
  const ctl = new AbortController(); kick = ctl;
  const stop = () => ctl.abort(); sig.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 6000); // never hang on a dead connection
  try {
    const p = await pingOnce(ctl.signal);
    const t = performance.now();
    const r = await fetch(`${BASE}/__down?bytes=1500000&r=${Math.random()}`, { cache: 'no-store', signal: ctl.signal });
    const buf = await r.arrayBuffer();
    const v = mbps(buf.byteLength, performance.now() - t);
    state.ping = state.ping == null ? p : state.ping * .6 + p * .4;
    state.ema = state.ema == null ? v : state.ema * .5 + v * .5;
  } finally { clearTimeout(timer); sig.removeEventListener('abort', stop); if (kick === ctl) kick = null; }
}

$('liveBtn').onclick = async () => {
  if (busy) { busy.abort(); return; }
  busy = new AbortController(); const sig = busy.signal;
  $('liveBtn').textContent = 'Stop live mode'; $('liveBtn').classList.add('live'); $('testBtn').disabled = true;
  hist.dl.length = 0; hist.q.length = 0; setStatus('Live: walk around and watch the numbers.');
  const state = { ema: null, ping: null }; let lost = false;
  while (!sig.aborted) {
    try {
      await liveSample(sig, state);
      if (sig.aborted) break;
      if (lost) { lost = false; setStatus('Reconnected. Live: walk around and watch the numbers.'); }
      trackBest(state.ema, state.ping); const q = quality(state.ema, state.ping);
      $('dl').textContent = fmt(state.ema); $('ping').textContent = fmt(state.ping); showQuality(q); refNote();
      Object.assign(last, { dl: state.ema, ping: state.ping, q }); push(state.ema, q);
    } catch (e) {
      if (sig.aborted) break;
      // connection lost or switching Wi-Fi: keep going and retry until it is back
      lost = true; state.ema = null; state.ping = null; // fresh readings for the new network
      setWifi(null); $('qLabel').textContent = 'Offline'; setStatus('Connection lost. Reconnecting automatically…');
      await sleep(1500, sig);
    }
  }
  setStatus('Stopped.');
  busy = null; $('liveBtn').textContent = 'Start live mode'; $('liveBtn').classList.remove('live'); $('testBtn').disabled = false;
};

$('resetBtn').onclick = () => { peak.dl = 0; peak.ping = Infinity; refNote(); setStatus('Best reading reset.'); };
draw();
})();
