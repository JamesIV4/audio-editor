'use strict';

// window.api comes from preload.js. Without it (plain browser), saving falls back to a download.
const bridge = window.api;
const actx = new AudioContext();

const PAD = 14;        // css px of horizontal padding so selection edges are grabbable at the ends
const RULER = 22;      // css px time ruler under the waveform
const EDGE_HIT = 7;    // css px tolerance for grabbing a selection edge
const GAIN_MIN = -30;
const GAIN_MAX = 30;
const METER_FLOOR = -48;
const UNDO_LIMIT = 50;

const clips = [];
let active = null;
let playing = null;    // { items: [{ clip, source, gainNode, t0, offset, dur }] }
let drag = null;
let nextId = 1;

const $ = (id) => document.getElementById(id);
const canvas = $('wave');
const g = canvas.getContext('2d');
const waveCanvas = document.createElement('canvas');
let waveKey = '';

// ---------- helpers ----------

const dbToGain = (db) => Math.pow(10, db / 20);
const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const lengthOf = (clip) => clip.channels[0].length;

function fmtDb(db, signed = false) {
  if (!isFinite(db)) return '−∞';
  const s = db.toFixed(1).replace('-', '−');
  return signed && db >= 0 ? `+${s}` : s;
}

function fmtTime(sec) {
  if (sec < 60) return `${sec.toFixed(3)} s`;
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`;
}

function editName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base.endsWith('-edit') ? base : `${base}-edit`}.wav`;
}

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 4000 : 2200);
}

// ---------- loading ----------

function readWavFormat(buf) {
  const v = new DataView(buf);
  const tag = (p) => String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  for (let p = 12; p + 8 <= buf.byteLength;) {
    const size = v.getUint32(p + 4, true);
    if (tag(p) === 'fmt ') {
      let format = v.getUint16(p + 8, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(p + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      return { sampleRate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true), float: format === 3 };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

async function decode(buf, sampleRate) {
  // Decoding through an OfflineAudioContext at the file's own rate avoids resampling WAVs.
  try {
    return await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(buf.slice(0));
  } catch {
    return await actx.decodeAudioData(buf);
  }
}

async function loadFile(file) {
  const buf = await file.arrayBuffer();
  const wav = readWavFormat(buf);
  let audio;
  try {
    audio = await decode(buf, wav?.sampleRate || actx.sampleRate);
  } catch {
    toast(`Couldn't read ${file.name} as audio`, true);
    return null;
  }
  if (!audio.length) {
    toast(`${file.name} is empty`, true);
    return null;
  }
  const channels = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).slice());

  const clip = {
    id: nextId++,
    name: file.name,
    path: bridge ? bridge.pathForFile(file) : '',
    sampleRate: audio.sampleRate,
    // Keep float/24-bit sources at their depth; everything else is written as 16-bit.
    format: wav?.float ? { bits: 32, float: true } : { bits: wav?.bits >= 24 ? 24 : 16, float: false },
    channels,
    gainDb: 0,
    sel: null,
    undo: [],
    version: 0,
    dirty: false,
    buffer: null,
    el: null,
  };
  analyze(clip);
  return clip;
}

async function loadFiles(files) {
  let first = null;
  for (const file of files) {
    const clip = await loadFile(file);
    if (!clip) continue;
    clips.push(clip);
    first ??= clip;
  }
  if (first) {
    active = first;
    renderList();
    refresh();
  }
}

// ---------- analysis ----------

// Peak plus a gated RMS loudness (50 ms blocks, -70 dB absolute gate, -10 dB relative gate, LUFS-style but
// unweighted) so silence and tails don't drag down the loudness of short effects.
function analyze(clip) {
  const n = lengthOf(clip);
  const block = Math.max(1, Math.round(clip.sampleRate * 0.05));
  const powers = [];
  let peak = 0;
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block);
    let sum = 0;
    for (const data of clip.channels) {
      for (let i = s; i < e; i++) {
        const x = data[i];
        sum += x * x;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
    }
    powers.push(sum / ((e - s) * clip.channels.length));
  }
  const loudEnough = powers.filter((p) => p > 1e-7);
  let loud = -Infinity;
  if (loudEnough.length) {
    const rel = mean(loudEnough) * 0.1;
    loud = 10 * Math.log10(mean(loudEnough.filter((p) => p >= rel)));
  }
  clip.peakDb = toDb(peak);
  clip.loudDb = loud;
}

// ---------- editing ----------

function selection(clip = active) {
  return clip?.sel && clip.sel.end > clip.sel.start ? clip.sel : null;
}

function setSel(start, end) {
  active.sel = end > start ? { start, end } : null;
  updateStatus();
  draw();
}

function edit(apply, needsSel = true) {
  const clip = active;
  const sel = selection(clip);
  if (!clip || (needsSel && !sel)) return;
  const before = { channels: clip.channels, sel: clip.sel };
  if (apply(clip, sel) === false) return;
  clip.undo.push(before);
  if (clip.undo.length > UNDO_LIMIT) clip.undo.shift();
  changed(clip);
}

function cut() {
  edit((clip, { start, end }) => {
    if (end - start >= lengthOf(clip)) {
      toast("Can't cut the whole sound", true);
      return false;
    }
    clip.channels = clip.channels.map((d) => {
      const out = new Float32Array(d.length - (end - start));
      out.set(d.subarray(0, start));
      out.set(d.subarray(end), start);
      return out;
    });
    clip.sel = null;
  });
}

function silence() {
  edit((clip, { start, end }) => {
    clip.channels = clip.channels.map((d) => {
      const out = d.slice();
      out.fill(0, start, end);
      return out;
    });
  });
}

function trim() {
  edit((clip, { start, end }) => {
    clip.channels = clip.channels.map((d) => d.slice(start, end));
    clip.sel = null;
  });
}

// Averages all channels into one, which removes any left/right panning or stereo movement.
function toMono() {
  edit((clip) => {
    const n = clip.channels.length;
    if (n < 2) return false;
    const out = new Float32Array(lengthOf(clip));
    for (const d of clip.channels) {
      for (let i = 0; i < out.length; i++) out[i] += d[i] / n;
    }
    clip.channels = [out];
  }, false);
}

function undo() {
  const clip = active;
  const prev = clip?.undo.pop();
  if (!prev) return;
  clip.channels = prev.channels;
  clip.sel = prev.sel;
  changed(clip);
}

function changed(clip) {
  clip.version++;
  clip.buffer = null;
  clip.dirty = true;
  analyze(clip);
  if (playing?.items.some((it) => it.clip === clip)) stop();
  updateRow(clip);
  refresh();
}

function setGain(clip, db) {
  clip.gainDb = clamp(Math.round(db * 10) / 10, GAIN_MIN, GAIN_MAX);
  clip.dirty = true;
  for (const it of playing?.items ?? []) {
    if (it.clip === clip) it.gainNode.gain.value = dbToGain(clip.gainDb);
  }
  if (clip.el) clip.el.querySelector('input').value = clip.gainDb;
  // Every meter shows a reference tick at the selected clip's level, so changing it moves all of them.
  if (clip === active) clips.forEach(updateRow);
  else updateRow(clip);
  if (clip === active) draw();
}

function matchToActive() {
  if (!active || clips.length < 2) return;
  if (!isFinite(active.loudDb)) return toast('The selected sound is silent', true);
  const target = active.loudDb + active.gainDb;
  let over = 0;
  for (const clip of clips) {
    if (clip === active || !isFinite(clip.loudDb)) continue;
    setGain(clip, target - clip.loudDb);
    if (clip.peakDb + clip.gainDb > 0) over++;
  }
  toast(over
    ? `Matched — ${over} sound${over > 1 ? 's' : ''} now clip; lower the selected sound and match again`
    : `Matched ${clips.length - 1} sound${clips.length > 2 ? 's' : ''} to ${fmtDb(target)} dB`, over > 0);
}

// ---------- saving ----------

function encodeWav(clip) {
  const { channels, sampleRate } = clip;
  const { bits, float } = clip.format;
  const gain = dbToGain(clip.gainDb);
  const nch = channels.length;
  const len = channels[0].length;
  const bytes = bits / 8;
  const blockAlign = nch * bytes;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const tag = (p, s) => { for (let i = 0; i < 4; i++) v.setUint8(p + i, s.charCodeAt(i)); };

  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  tag(36, 'data');
  v.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = channels[c][i] * gain;
      if (float) {
        v.setFloat32(o, s, true);
      } else {
        const x = clamp(s, -1, 1);
        if (bits === 16) {
          v.setInt16(o, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
        } else {
          const n = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
          v.setUint8(o, n & 0xff);
          v.setUint8(o + 1, (n >> 8) & 0xff);
          v.setUint8(o + 2, (n >> 16) & 0xff);
        }
      }
      o += bytes;
    }
  }
  return buf;
}

async function save(clip) {
  const data = encodeWav(clip);
  let savedAs;
  if (bridge && clip.path) {
    try {
      savedAs = await bridge.saveEdit(clip.path, data);
    } catch (err) {
      toast(`Save failed: ${err.message}`, true);
      return false;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    a.download = savedAs = editName(clip.name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  clip.dirty = false;
  updateRow(clip);
  return savedAs.split(/[\\/]/).pop();
}

async function saveActive() {
  if (!active) return;
  const name = await save(active);
  if (name) toast(`Saved ${name}${peakOver(active) ? ' — warning: it clips' : ''}`, peakOver(active));
}

async function saveAll() {
  const dirty = clips.filter((c) => c.dirty);
  if (!dirty.length) return toast('Nothing to save');
  let ok = 0;
  for (const clip of dirty) if (await save(clip)) ok++;
  if (ok === dirty.length) toast(`Saved ${ok} sound${ok > 1 ? 's' : ''}`);
}

const peakOver = (clip) => clip.peakDb + clip.gainDb > 0.001;

// ---------- playback ----------

function audioBufferFor(clip) {
  if (!clip.buffer) {
    clip.buffer = actx.createBuffer(clip.channels.length, lengthOf(clip), clip.sampleRate);
    clip.channels.forEach((d, i) => clip.buffer.copyToChannel(d, i));
  }
  return clip.buffer;
}

function startPlayback(segments) {
  stop();
  actx.resume();
  let t = actx.currentTime + 0.03;
  const items = segments.map(({ clip, start, end }) => {
    const source = actx.createBufferSource();
    source.buffer = audioBufferFor(clip);
    const gainNode = actx.createGain();
    gainNode.gain.value = dbToGain(clip.gainDb);
    source.connect(gainNode).connect(actx.destination);
    const offset = start / clip.sampleRate;
    const dur = (end - start) / clip.sampleRate;
    source.start(t, offset, dur);
    const item = { clip, source, gainNode, t0: t, offset, dur };
    t += dur + 0.35;
    return item;
  });
  const run = { items };
  items[items.length - 1].source.onended = () => {
    if (playing !== run) return;
    playing = null;
    updatePlayState();
    draw();
  };
  playing = run;
  updatePlayState();
  requestAnimationFrame(tick);
}

function stop() {
  if (!playing) return;
  for (const it of playing.items) {
    try { it.source.stop(); } catch { /* not started yet */ }
  }
  playing = null;
  updatePlayState();
  draw();
}

const isPlaying = (clip, alone = false) =>
  !!playing && playing.items.some((it) => it.clip === clip) && (!alone || playing.items.length === 1);

function preview() {
  if (!active) return;
  if (isPlaying(active, true)) return stop();
  const sel = selection();
  startPlayback([{ clip: active, start: sel ? sel.start : 0, end: sel ? sel.end : lengthOf(active) }]);
}

function playWhole(clip) {
  if (isPlaying(clip, true)) return stop();
  startPlayback([{ clip, start: 0, end: lengthOf(clip) }]);
}

function playAll() {
  if (playing && playing.items.length > 1) return stop();
  if (clips.length) startPlayback(clips.map((clip) => ({ clip, start: 0, end: lengthOf(clip) })));
}

function tick() {
  if (!playing) return;
  draw();
  requestAnimationFrame(tick);
}

// ---------- waveform drawing ----------

function geometry() {
  const dpr = devicePixelRatio || 1;
  const W = canvas.width;
  const H = canvas.height;
  return { dpr, W, H, left: PAD * dpr, inner: W - 2 * PAD * dpr, waveH: H - RULER * dpr };
}

const sampleToX = (s, geo) => geo.left + (s / lengthOf(active)) * geo.inner;
const xToSample = (x, geo) => Math.round(clamp((x - geo.left) / geo.inner, 0, 1) * lengthOf(active));

function renderWave(clip, geo) {
  const { dpr, W, H, left, inner, waveH } = geo;
  waveCanvas.width = W;
  waveCanvas.height = H;
  const w = waveCanvas.getContext('2d');
  const len = lengthOf(clip);
  const gain = dbToGain(clip.gainDb);
  const laneH = waveH / clip.channels.length;

  clip.channels.forEach((data, ci) => {
    const top = ci * laneH;
    const mid = top + laneH / 2;
    const half = laneH / 2 - 6 * dpr;
    if (ci % 2) {
      w.fillStyle = 'rgba(255,255,255,0.015)';
      w.fillRect(0, top, W, laneH);
    }
    w.fillStyle = 'rgba(255,255,255,0.06)';
    w.fillRect(left, Math.round(mid), inner, 1);
    w.fillRect(left, Math.round(mid - half), inner, 1);
    w.fillRect(left, Math.round(mid + half), inner, 1);

    let color = '';
    for (let x = 0; x < inner; x++) {
      const s0 = Math.floor((x * len) / inner);
      if (s0 >= len) break;
      const s1 = Math.max(s0 + 1, Math.floor(((x + 1) * len) / inner));
      let lo = data[s0];
      let hi = lo;
      for (let i = s0 + 1; i < s1 && i < len; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      lo *= gain;
      hi *= gain;
      const over = hi > 1 || lo < -1;
      const c = over ? '#ff5c5c' : '#7fd1b9';
      if (c !== color) w.fillStyle = color = c;
      hi = clamp(hi, -1, 1);
      lo = clamp(lo, -1, 1);
      w.fillRect(left + x, mid - hi * half, 1, Math.max(dpr, (hi - lo) * half));
    }
  });

  // time ruler
  const dur = len / clip.sampleRate;
  const pxPerSec = inner / dur;
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * pxPerSec >= 80 * dpr) ?? 1200;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? (step === 0.25 ? 2 : 1) : 0;
  w.fillStyle = 'rgba(255,255,255,0.08)';
  w.fillRect(0, waveH, W, 1);
  w.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
  w.textBaseline = 'middle';
  for (let i = 0; i * step <= dur + 1e-9; i++) {
    const t = i * step;
    const x = Math.round(left + t * pxPerSec);
    w.fillStyle = 'rgba(255,255,255,0.18)';
    w.fillRect(x, waveH, 1, 5 * dpr);
    w.fillStyle = '#8b93a5';
    const label = t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t.toFixed(decimals)}s`;
    if (x + 3 * dpr + w.measureText(label).width > W) continue;
    w.fillText(label, x + 3 * dpr, waveH + (RULER * dpr) / 2 + dpr);
  }
}

function draw() {
  const geo = geometry();
  g.clearRect(0, 0, geo.W, geo.H);
  if (!active) return;

  const key = `${active.id}:${active.version}:${active.gainDb}:${geo.W}x${geo.H}`;
  if (key !== waveKey) {
    renderWave(active, geo);
    waveKey = key;
  }
  g.drawImage(waveCanvas, 0, 0);

  const sel = selection();
  if (sel) {
    const x0 = sampleToX(sel.start, geo);
    const x1 = sampleToX(sel.end, geo);
    g.fillStyle = 'rgba(77,163,255,0.2)';
    g.fillRect(x0, 0, x1 - x0, geo.waveH);
    g.fillStyle = '#4da3ff';
    for (const x of [x0, x1]) {
      g.fillRect(Math.round(x) - geo.dpr, 0, 2 * geo.dpr, geo.waveH);
      g.fillRect(Math.round(x) - 4 * geo.dpr, 0, 8 * geo.dpr, 14 * geo.dpr); // grab tab
    }
  }

  const item = playing?.items.find((it) => it.clip === active);
  if (item) {
    const t = actx.currentTime - item.t0;
    if (t >= 0 && t <= item.dur) {
      const x = sampleToX((item.offset + t) * active.sampleRate, geo);
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(x), 0, geo.dpr, geo.waveH);
    }
  }
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  draw();
}

// ---------- selection with the mouse ----------

function hitTest(x, geo) {
  const sel = selection();
  if (!sel) return 'none';
  const x0 = sampleToX(sel.start, geo);
  const x1 = sampleToX(sel.end, geo);
  const tol = EDGE_HIT * geo.dpr;
  const d0 = Math.abs(x - x0);
  const d1 = Math.abs(x - x1);
  if (Math.min(d0, d1) <= tol) return d0 < d1 ? 'start' : 'end';
  return x > x0 && x < x1 ? 'inside' : 'none';
}

const canvasX = (e) => (e.clientX - canvas.getBoundingClientRect().left) * (devicePixelRatio || 1);

canvas.addEventListener('pointerdown', (e) => {
  if (!active || e.button !== 0) return;
  const geo = geometry();
  const x = canvasX(e);
  const s = xToSample(x, geo);
  const sel = selection();
  const hit = hitTest(x, geo);
  canvas.setPointerCapture(e.pointerId);
  if (hit === 'start') drag = { mode: 'edge', fixed: sel.end, moved: true };
  else if (hit === 'end') drag = { mode: 'edge', fixed: sel.start, moved: true };
  else if (hit === 'inside') drag = { mode: 'move', grab: s - sel.start, size: sel.end - sel.start, downX: x, moved: false };
  else drag = { mode: 'edge', fixed: s, downX: x, moved: false };
  canvas.style.cursor = drag.mode === 'move' ? 'grabbing' : 'ew-resize';
});

canvas.addEventListener('pointermove', (e) => {
  if (!active) return;
  const geo = geometry();
  const x = canvasX(e);
  if (!drag) {
    const hit = hitTest(x, geo);
    canvas.style.cursor = hit === 'start' || hit === 'end' ? 'ew-resize' : hit === 'inside' ? 'grab' : 'crosshair';
    return;
  }
  if (!drag.moved && Math.abs(x - drag.downX) < 3 * geo.dpr) return;
  drag.moved = true;
  const s = xToSample(x, geo);
  if (drag.mode === 'edge') {
    setSel(Math.min(drag.fixed, s), Math.max(drag.fixed, s));
  } else {
    const start = clamp(s - drag.grab, 0, lengthOf(active) - drag.size);
    setSel(start, start + drag.size);
  }
});

function endDrag() {
  if (!drag) return;
  if (!drag.moved) setSel(0, 0); // plain click clears the selection
  drag = null;
  canvas.style.cursor = 'crosshair';
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', () => active && setSel(0, lengthOf(active)));

// ---------- sidebar ----------

function renderList() {
  const ul = $('clipList');
  ul.textContent = '';
  const tpl = $('clipTpl');
  for (const clip of clips) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    clip.el = li;
    const name = li.querySelector('.name');
    name.textContent = clip.name;
    name.title = clip.path || clip.name;
    const range = li.querySelector('input');
    range.value = clip.gainDb;

    li.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.remove')) setActive(clip);
    });
    li.querySelector('.play').addEventListener('click', () => playWhole(clip));
    li.querySelector('.remove').addEventListener('click', () => removeClip(clip));
    range.addEventListener('input', () => setGain(clip, Number(range.value)));
    range.addEventListener('dblclick', () => setGain(clip, 0));
    ul.appendChild(li);
  }
  clips.forEach(updateRow);
  updatePlayState();
}

function meterPct(db) {
  return `${clamp((db - METER_FLOOR) / -METER_FLOOR, 0, 1) * 100}%`;
}

function updateRow(clip) {
  const li = clip.el;
  if (!li) return;
  li.classList.toggle('active', clip === active);
  li.classList.toggle('dirty', clip.dirty);
  li.querySelector('.db').textContent = `${fmtDb(clip.gainDb, true)} dB`;
  const loud = clip.loudDb + clip.gainDb;
  const peak = clip.peakDb + clip.gainDb;
  const over = peakOver(clip);
  li.querySelector('.loud').style.width = meterPct(loud);
  const peakEl = li.querySelector('.peak');
  peakEl.style.left = `calc(${meterPct(peak)} - 1px)`;
  peakEl.classList.toggle('over', over);
  const ref = li.querySelector('.ref');
  ref.hidden = !active || clip === active || !isFinite(active.loudDb);
  if (active) ref.style.left = meterPct(active.loudDb + active.gainDb);
  li.querySelector('.levels').innerHTML =
    `Loudness ${fmtDb(loud)} dB · <span class="${over ? 'over' : ''}">Peak ${fmtDb(peak)} dB${over ? ' (clips)' : ''}</span>`;
}

function setActive(clip) {
  if (clip === active) return;
  active = clip;
  drag = null;
  clips.forEach(updateRow);
  refresh();
}

function removeClip(clip) {
  if (isPlaying(clip)) stop();
  const i = clips.indexOf(clip);
  clips.splice(i, 1);
  if (active === clip) active = clips[Math.min(i, clips.length - 1)] ?? null;
  renderList();
  refresh();
}

// ---------- chrome: status, buttons ----------

function updateStatus() {
  const sel = selection();
  $('cutBtn').disabled = $('silenceBtn').disabled = $('trimBtn').disabled = !sel;
  $('previewBtn').disabled = $('saveBtn').disabled = !active;
  $('monoBtn').disabled = !active || active.channels.length < 2;
  $('undoBtn').disabled = !active?.undo.length;
  $('matchBtn').disabled = clips.length < 2;
  $('playAllBtn').disabled = $('saveAllBtn').disabled = !clips.length;
  $('empty').hidden = clips.length > 0;

  if (!active) {
    $('clipInfo').textContent = '';
    $('selInfo').textContent = '';
    return;
  }
  const len = lengthOf(active);
  const rate = active.sampleRate;
  const nch = active.channels.length;
  const layout = nch === 1 ? 'mono' : nch === 2 ? 'stereo' : `${nch} ch`;
  const fmt = active.format.float ? '32-bit float' : `${active.format.bits}-bit`;
  $('clipInfo').textContent = `${active.name} · ${fmtTime(len / rate)} · ${rate} Hz · ${layout} · saves as ${fmt} WAV`;
  $('selInfo').textContent = sel
    ? `Selection ${fmtTime(sel.start / rate)} → ${fmtTime(sel.end / rate)}  (${fmtTime((sel.end - sel.start) / rate)})`
    : 'Drag on the waveform to select · double-click selects all';
}

function updatePlayState() {
  $('previewBtn').firstChild.textContent = active && isPlaying(active, true) ? '■ Stop' : '▶ Preview';
  $('playAllBtn').textContent = playing && playing.items.length > 1 ? '■ Stop' : '▶ Play all';
  for (const clip of clips) {
    if (clip.el) clip.el.querySelector('.play').textContent = isPlaying(clip, true) ? '■' : '▶';
  }
}

function refresh() {
  updateStatus();
  updatePlayState();
  draw();
}

// ---------- wiring ----------

$('previewBtn').addEventListener('click', preview);
$('cutBtn').addEventListener('click', cut);
$('silenceBtn').addEventListener('click', silence);
$('trimBtn').addEventListener('click', trim);
$('monoBtn').addEventListener('click', toMono);
$('undoBtn').addEventListener('click', undo);
$('saveBtn').addEventListener('click', saveActive);
$('saveAllBtn').addEventListener('click', saveAll);
$('matchBtn').addEventListener('click', matchToActive);
$('playAllBtn').addEventListener('click', playAll);

const fileInput = $('fileInput');
const browse = () => fileInput.click();
$('addBtn').addEventListener('click', browse);
$('empty').addEventListener('click', browse);
fileInput.addEventListener('change', () => {
  loadFiles([...fileInput.files]);
  fileInput.value = '';
});

// Buttons never take focus, so Space always means "preview" instead of re-clicking the last button.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  const inRange = e.target instanceof HTMLInputElement;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  let handled = true;
  if (key === ' ') preview();
  else if (key === 'delete' || key === 'backspace' || (key === 'x' && !mod)) cut();
  else if (key === 'm' && !mod) silence();
  else if (key === 't' && !mod) trim();
  else if (key === 'o' && !mod) toMono();
  else if (key === 's' && mod) saveActive();
  else if (key === 'z' && mod) undo();
  else if (key === 'a' && mod) active && setSel(0, lengthOf(active));
  else if (key === 'escape') active && (playing ? stop() : setSel(0, 0));
  else if ((key === 'arrowup' || key === 'arrowdown') && !inRange && active) {
    const i = clips.indexOf(active) + (key === 'arrowup' ? -1 : 1);
    if (clips[i]) setActive(clips[i]);
  } else handled = false;
  if (handled) e.preventDefault();
});

// Drag and drop anywhere in the window.
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files]);
});

new ResizeObserver(resizeCanvas).observe($('stage'));
refresh();
