'use strict';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const COLORS = ['#5b8cff', '#3ecf8e', '#ffc44d', '#ff7a59', '#c77dff', '#4dd0e1', '#ff5c93', '#a3e635'];

const state = {
  tracks: [],          // { id, name, buffer, volume, pan, muted, solo, offset, color }
  playhead: 0,         // segundos na linha do tempo
  playing: false,
  recording: false,
  bpm: 100,
  metronome: false,
  countIn: true,
  latencyAdjustMs: 0,
  inputDeviceId: '',
  inputChannel: 'mix',
  monitor: false,
};

let ctx = null;
let master = null;
let workletReady = null;
let micStream = null;
let micSource = null;
let micAnalyser = null;
let recorderNode = null;
let monitorGain = null;

// Sessão de reprodução atual
let session = null; // { startAt, startPos, nodes: Map(id -> {src, gain, pan}), metro }
// Gravação atual
let rec = null;     // { startAt, startPos, chunks, row, stopResolve }

const $ = (sel) => document.querySelector(sel);
const els = {
  tracks: $('#tracks'), empty: $('#empty'), status: $('#status'), timer: $('#timer'),
  btnPlay: $('#btnPlay'), btnRec: $('#btnRec'), btnHome: $('#btnHome'),
  bpm: $('#bpm'), btnMetro: $('#btnMetro'), btnCount: $('#btnCount'),
  fileImport: $('#fileImport'), btnExport: $('#btnExport'), btnSettings: $('#btnSettings'),
  settings: $('#settings'), inputDevice: $('#inputDevice'), inputChannel: $('#inputChannel'),
  latAdjust: $('#latAdjust'), latAdjustOut: $('#latAdjustOut'), latAuto: $('#latAuto'), latTotal: $('#latTotal'),
  monitor: $('#monitor'), btnNew: $('#btnNew'), tpl: $('#trackTpl'),
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function setStatus(msg, isErr = false) {
  els.status.textContent = msg || '';
  els.status.classList.toggle('err', !!isErr);
}

function fmtTime(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function trackEnd(t) { return t.offset + t.buffer.duration; }

function projectEnd() {
  return state.tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);
}

// Escala da linha do tempo: sempre mostra um pouco além do fim do projeto.
function timelineLength() {
  const end = Math.max(projectEnd(), state.playhead);
  return Math.max(15, end * 1.1);
}

function isAudible(t) {
  const anySolo = state.tracks.some((x) => x.solo);
  return anySolo ? t.solo && !t.muted : !t.muted;
}

// ---------------------------------------------------------------------------
// Áudio: contexto, microfone, worklet
// ---------------------------------------------------------------------------
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function ensureWorklet() {
  ensureCtx();
  if (!workletReady) workletReady = ctx.audioWorklet.addModule('recorder-worklet.js');
  await workletReady;
}

async function ensureMic() {
  await ensureWorklet();
  if (micStream && micStream.active) return;
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
  };
  if (state.inputDeviceId) audio.deviceId = { exact: state.inputDeviceId };
  micStream = await navigator.mediaDevices.getUserMedia({ audio });
  micSource = ctx.createMediaStreamSource(micStream);

  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 1024;
  micSource.connect(micAnalyser);

  if (!recorderNode) {
    recorderNode = new AudioWorkletNode(ctx, 'recorder-processor');
    // O worklet precisa estar ligado ao destino para ser processado; ganho 0 = silêncio.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    recorderNode.connect(sink).connect(ctx.destination);
    recorderNode.port.onmessage = onWorkletMessage;
  }
  micSource.connect(recorderNode);

  monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;
  micSource.connect(monitorGain).connect(ctx.destination);

  refreshDevices();
  updateLatencyUi();
}

function releaseMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micSource) micSource.disconnect();
  micStream = null;
  micSource = null;
}

function autoLatencySec() {
  if (!ctx) return 0;
  const out = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  let inp = 0;
  if (micStream) {
    const s = micStream.getAudioTracks()[0]?.getSettings?.() || {};
    inp = typeof s.latency === 'number' ? s.latency : 0;
  }
  return out + inp;
}

function totalLatencySec() {
  return autoLatencySec() + state.latencyAdjustMs / 1000;
}

function onWorkletMessage(e) {
  const msg = e.data;
  if (!rec) return;
  if (msg.type === 'chunk') rec.chunks.push(msg);
  else if (msg.type === 'stopped' && rec.stopResolve) rec.stopResolve();
}

// ---------------------------------------------------------------------------
// Metrônomo (agendamento com lookahead)
// ---------------------------------------------------------------------------
function click(time, accent) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  osc.connect(g).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.08);
  return osc;
}

// Agenda cliques alinhados à grade de tempos da linha do tempo (tempo 0 = início).
function startMetronome(startAt, startPos) {
  const beat = 60 / state.bpm;
  let idx = Math.ceil(startPos / beat - 1e-6);
  const oscs = [];
  const tick = () => {
    const horizon = ctx.currentTime + 0.15;
    while (true) {
      const t = startAt + (idx * beat - startPos);
      if (t > horizon) break;
      if (t >= ctx.currentTime - 0.01) oscs.push(click(t, idx % 4 === 0));
      idx++;
    }
    while (oscs.length > 32) oscs.shift();
  };
  tick();
  const timer = setInterval(tick, 25);
  return {
    stop() {
      clearInterval(timer);
      oscs.forEach((o) => { try { o.stop(); } catch (_) {} });
    },
  };
}

function scheduleCountIn(startAt) {
  const beat = 60 / state.bpm;
  const oscs = [];
  for (let i = 0; i < 4; i++) oscs.push(click(startAt - (4 - i) * beat, i === 0));
  return { stop() { oscs.forEach((o) => { try { o.stop(); } catch (_) {} }); } };
}

// ---------------------------------------------------------------------------
// Reprodução
// ---------------------------------------------------------------------------
function buildTrackChain(c, t, dest) {
  const gain = c.createGain();
  gain.gain.value = isAudible(t) ? t.volume : 0;
  let pan;
  if (c.createStereoPanner) {
    pan = c.createStereoPanner();
    pan.pan.value = t.pan;
    gain.connect(pan).connect(dest);
  } else {
    gain.connect(dest);
  }
  return { gain, pan };
}

function scheduleTrack(c, t, dest, startAt, startPos) {
  const chain = buildTrackChain(c, t, dest);
  const src = c.createBufferSource();
  src.buffer = t.buffer;
  src.connect(chain.gain);
  const rel = t.offset - startPos; // quando a pista começa, relativo ao início da reprodução
  if (rel >= 0) src.start(startAt + rel, 0);
  else if (-rel < t.buffer.duration) src.start(startAt, -rel);
  else return null;
  return { src, ...chain };
}

function startPlayback(startAt, { metronome = state.metronome } = {}) {
  stopPlayback(false);
  const nodes = new Map();
  for (const t of state.tracks) {
    const n = scheduleTrack(ctx, t, master, startAt, state.playhead);
    if (n) nodes.set(t.id, n);
  }
  session = {
    startAt,
    startPos: state.playhead,
    nodes,
    metro: metronome ? startMetronome(startAt, state.playhead) : null,
  };
  state.playing = true;
  els.btnPlay.textContent = '⏸';
  els.btnPlay.classList.add('active');
  requestAnimationFrame(animate);
}

function currentPos() {
  if (!session) return state.playhead;
  return session.startPos + Math.max(0, ctx.currentTime - session.startAt);
}

function stopPlayback(keepPosition = true) {
  if (session) {
    if (keepPosition) state.playhead = currentPos();
    session.nodes.forEach((n) => { try { n.src.stop(); } catch (_) {} n.src.disconnect(); });
    if (session.metro) session.metro.stop();
    session = null;
  }
  state.playing = false;
  els.btnPlay.textContent = '▶';
  els.btnPlay.classList.remove('active');
  drawPlayhead();
}

function togglePlay() {
  if (state.recording) { stopRecording(); return; }
  ensureCtx();
  if (state.playing) {
    stopPlayback();
  } else {
    if (state.tracks.length === 0) { setStatus('Nada para tocar ainda. Grave ou importe uma pista.'); return; }
    if (state.playhead >= projectEnd() - 0.05) state.playhead = 0;
    startPlayback(ctx.currentTime + 0.05);
  }
}

function seek(pos) {
  if (state.recording) return;
  state.playhead = Math.max(0, pos);
  if (state.playing) startPlayback(ctx.currentTime + 0.05);
  else drawPlayhead();
}

function updateLiveMix() {
  if (!session) return;
  for (const t of state.tracks) {
    const n = session.nodes.get(t.id);
    if (!n) continue;
    n.gain.gain.setTargetAtTime(isAudible(t) ? t.volume : 0, ctx.currentTime, 0.01);
    if (n.pan) n.pan.pan.setTargetAtTime(t.pan, ctx.currentTime, 0.01);
  }
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
async function startRecording() {
  try {
    ensureCtx();
    await ensureMic();
  } catch (err) {
    console.error(err);
    setStatus('Não consegui acessar o microfone. Verifique a permissão do navegador. (' + err.message + ')', true);
    return;
  }
  if (state.playing) stopPlayback();

  const beat = 60 / state.bpm;
  const lead = 0.15 + (state.countIn ? 4 * beat : 0);
  const startAt = ctx.currentTime + lead;
  const startPos = state.playhead;

  rec = { startAt, startPos, chunks: [], row: createRecordingRow(), stopResolve: null };
  rec.countIn = state.countIn ? scheduleCountIn(startAt) : null;
  recorderNode.port.postMessage({ cmd: 'start', channelMode: state.inputChannel });
  if (monitorGain) monitorGain.gain.value = state.monitor ? 1 : 0;

  startPlayback(startAt);
  state.recording = true;
  els.btnRec.classList.add('active');
  els.empty.hidden = true;
  setStatus(state.countIn ? 'Contagem… a gravação começa no 5º tempo.' : 'Gravando…');
}

async function stopRecording() {
  if (!rec) return;
  const r = rec;
  const stoppedEarly = ctx.currentTime < r.startAt;
  await new Promise((resolve) => {
    r.stopResolve = resolve;
    recorderNode.port.postMessage({ cmd: 'stop' });
  });
  if (r.countIn) r.countIn.stop();
  if (monitorGain) monitorGain.gain.value = 0;
  stopPlayback(false);
  state.recording = false;
  els.btnRec.classList.remove('active');
  r.row.remove();
  rec = null;

  if (stoppedEarly) {
    state.playhead = r.startPos;
    setStatus('Gravação cancelada durante a contagem.');
    render();
    return;
  }

  const sr = ctx.sampleRate;
  const startFrame = Math.round((r.startAt + totalLatencySec()) * sr);
  const last = r.chunks[r.chunks.length - 1];
  const endFrame = last ? last.frame + last.data.length : startFrame;
  const length = endFrame - startFrame;
  if (length < sr * 0.2) {
    state.playhead = r.startPos;
    setStatus('Gravação muito curta, descartada.');
    render();
    return;
  }

  const data = new Float32Array(length);
  for (const ch of r.chunks) {
    const from = ch.frame - startFrame;
    const a = Math.max(0, -from);
    const b = Math.min(ch.data.length, length - from);
    if (b > a) data.set(ch.data.subarray(a, b), from + a);
  }
  const buffer = ctx.createBuffer(1, length, sr);
  buffer.copyToChannel(data, 0);

  const t = addTrack(buffer, { offset: r.startPos });
  state.playhead = r.startPos;
  setStatus(`"${t.name}" gravada (${buffer.duration.toFixed(1)} s). Grave a próxima camada quando quiser.`);
  render();
  saveTrack(t);
}

function toggleRecord() {
  if (state.recording) stopRecording();
  else startRecording();
}

function createRecordingRow() {
  const row = document.createElement('div');
  row.className = 'track recording';
  row.innerHTML = `
    <div class="controls"><div class="row1"><span class="swatch" style="background:var(--rec)"></span>
      <strong>Nova pista</strong></div><div class="row2">Nível do microfone</div></div>
    <div class="lane"><span class="reclabel">● GRAVANDO</span><div class="meter"><i></i></div></div>`;
  els.tracks.appendChild(row);
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return row;
}

const meterBuf = new Float32Array(1024);
function updateMeter() {
  if (!rec || !micAnalyser) return;
  micAnalyser.getFloatTimeDomainData(meterBuf);
  let peak = 0;
  for (let i = 0; i < meterBuf.length; i++) peak = Math.max(peak, Math.abs(meterBuf[i]));
  const db = 20 * Math.log10(peak || 1e-6);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const bar = rec.row.querySelector('.meter > i');
  if (bar) bar.style.width = pct + '%';
  const label = rec.row.querySelector('.reclabel');
  if (label) {
    const counting = ctx.currentTime < rec.startAt;
    label.textContent = counting
      ? `CONTAGEM ${Math.min(4, 4 - Math.ceil((rec.startAt - ctx.currentTime) / (60 / state.bpm)) + 1)}`
      : (peak > 0.98 ? '● GRAVANDO — CLIPANDO! baixe o volume' : '● GRAVANDO');
  }
}

// ---------------------------------------------------------------------------
// Pistas
// ---------------------------------------------------------------------------
function addTrack(buffer, opts = {}) {
  const n = state.tracks.length;
  const t = {
    id: opts.id || uid(),
    name: opts.name || `Pista ${n + 1}`,
    buffer,
    volume: opts.volume ?? 1,
    pan: opts.pan ?? 0,
    muted: !!opts.muted,
    solo: !!opts.solo,
    offset: opts.offset ?? 0,
    color: opts.color || COLORS[n % COLORS.length],
  };
  state.tracks.push(t);
  return t;
}

function removeTrack(t) {
  state.tracks = state.tracks.filter((x) => x !== t);
  dbDelete(t.id);
  if (state.playing) startPlayback(ctx.currentTime + 0.05);
  render();
}

function render() {
  els.tracks.querySelectorAll('.track:not(.recording)').forEach((n) => n.remove());
  const recRow = els.tracks.querySelector('.track.recording');
  for (const t of state.tracks) {
    const node = buildTrackRow(t);
    els.tracks.insertBefore(node, recRow);
  }
  els.empty.hidden = state.tracks.length > 0 || state.recording;
  drawAllWaves();
  drawPlayhead();
}

function buildTrackRow(t) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = t.id;
  node.querySelector('.swatch').style.background = t.color;

  const name = node.querySelector('.name');
  name.value = t.name;
  name.addEventListener('change', () => { t.name = name.value.trim() || t.name; saveMeta(t); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });

  const mute = node.querySelector('.mute');
  const solo = node.querySelector('.solo');
  const syncButtons = () => {
    mute.classList.toggle('on', t.muted);
    solo.classList.toggle('on', t.solo);
    document.querySelectorAll('.track[data-id]').forEach((row) => {
      const tr = state.tracks.find((x) => x.id === row.dataset.id);
      if (tr) row.classList.toggle('silenced', !isAudible(tr));
    });
  };
  mute.addEventListener('click', () => { t.muted = !t.muted; syncButtons(); updateLiveMix(); saveMeta(t); });
  solo.addEventListener('click', () => { t.solo = !t.solo; syncButtons(); updateLiveMix(); saveMeta(t); });
  mute.classList.toggle('on', t.muted);
  solo.classList.toggle('on', t.solo);
  node.classList.toggle('silenced', !isAudible(t));

  const vol = node.querySelector('.vol');
  vol.value = t.volume;
  vol.addEventListener('input', () => { t.volume = +vol.value; updateLiveMix(); saveMeta(t); });
  vol.addEventListener('dblclick', () => { vol.value = t.volume = 1; updateLiveMix(); saveMeta(t); });

  const pan = node.querySelector('.pan');
  pan.value = t.pan;
  pan.addEventListener('input', () => { t.pan = +pan.value; updateLiveMix(); saveMeta(t); });
  pan.addEventListener('dblclick', () => { pan.value = t.pan = 0; updateLiveMix(); saveMeta(t); });

  const extra = node.querySelector('.extra');
  node.querySelector('.more').addEventListener('click', () => { extra.hidden = !extra.hidden; });
  node.querySelectorAll('.nudge').forEach((b) => b.addEventListener('click', () => {
    t.offset = Math.max(0, t.offset + (+b.dataset.ms) / 1000);
    saveMeta(t);
    drawAllWaves();
    if (state.playing) startPlayback(ctx.currentTime + 0.05);
    setStatus(`"${t.name}" começa em ${t.offset.toFixed(3)} s.`);
  }));
  node.querySelector('.download').addEventListener('click', () => {
    downloadBlob(encodeWav([t.buffer.getChannelData(0)], t.buffer.sampleRate), `${t.name}.wav`);
  });
  node.querySelector('.delete').addEventListener('click', () => {
    if (confirm(`Excluir "${t.name}"? Isso não pode ser desfeito.`)) removeTrack(t);
  });

  const lane = node.querySelector('.lane');
  lane.addEventListener('click', (e) => {
    const r = lane.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * timelineLength());
  });
  return node;
}

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------
function drawAllWaves() {
  const len = timelineLength();
  document.querySelectorAll('.track[data-id]').forEach((row) => {
    const t = state.tracks.find((x) => x.id === row.dataset.id);
    if (t) drawWave(row.querySelector('canvas'), t, len);
  });
}

function drawWave(canvas, t, len) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);

  // grade de compassos
  const bar = (60 / state.bpm) * 4;
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let x = 0; x <= len; x += bar) g.fillRect(Math.round((x / len) * w), 0, 1, h);

  const data = t.buffer.getChannelData(0);
  const sr = t.buffer.sampleRate;
  const x0 = (t.offset / len) * w;
  const x1 = (trackEnd(t) / len) * w;
  g.fillStyle = t.color + '22';
  g.fillRect(x0, 0, x1 - x0, h);
  g.fillStyle = t.color;
  const mid = h / 2;
  const secPerPx = len / w;
  for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
    const s0 = Math.floor((px * secPerPx - t.offset) * sr);
    const s1 = Math.floor(((px + 1) * secPerPx - t.offset) * sr);
    let min = 0, max = 0;
    const step = Math.max(1, Math.floor((s1 - s0) / 200));
    for (let i = Math.max(0, s0); i < Math.min(data.length, s1); i += step) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y0 = mid - max * mid * 0.95;
    const y1 = mid - min * mid * 0.95;
    g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
  }
}

function drawPlayhead() {
  const pos = state.playing ? currentPos() : state.playhead;
  const pct = Math.min(100, (pos / timelineLength()) * 100);
  document.querySelectorAll('.ph').forEach((ph) => { ph.style.left = pct + '%'; });
  els.timer.textContent = fmtTime(state.recording && ctx.currentTime < rec?.startAt ? state.playhead : pos);
}

function animate() {
  if (!state.playing) return;
  drawPlayhead();
  updateMeter();
  // Para sozinho quando acaba o projeto (exceto gravando).
  if (!state.recording && currentPos() > projectEnd() + 0.1) {
    stopPlayback(false);
    state.playhead = 0;
    drawPlayhead();
    return;
  }
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------
async function exportMix() {
  if (state.tracks.length === 0) { setStatus('Não há pistas para exportar.'); return; }
  ensureCtx();
  setStatus('Renderizando a mix…');
  const sr = ctx.sampleRate;
  const dur = projectEnd();
  const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  for (const t of state.tracks) scheduleTrack(off, t, off.destination, 0, 0);
  const out = await off.startRendering();
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak > 0.99) {
    const k = 0.99 / peak;
    for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadBlob(encodeWav([L, R], sr), `mix-${stamp}.wav`);
  setStatus(peak > 0.99
    ? `Mix exportada (${dur.toFixed(1)} s). O volume foi reduzido para não distorcer.`
    : `Mix exportada (${dur.toFixed(1)} s).`);
}

function encodeWav(channels, sampleRate) {
  const nch = channels.length;
  const len = channels[0].length;
  const buf = new ArrayBuffer(44 + len * nch * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * nch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nch * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------
async function importFile(file) {
  ensureCtx();
  setStatus(`Importando ${file.name}…`);
  try {
    const arr = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arr);
    // Guarda em mono para manter tudo simples e leve.
    const mono = ctx.createBuffer(1, decoded.length, decoded.sampleRate);
    const d = mono.getChannelData(0);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const s = decoded.getChannelData(c);
      for (let i = 0; i < s.length; i++) d[i] += s[i] / decoded.numberOfChannels;
    }
    const t = addTrack(mono, { name: file.name.replace(/\.[^.]+$/, ''), offset: 0 });
    render();
    saveTrack(t);
    setStatus(`"${t.name}" importada.`);
  } catch (err) {
    console.error(err);
    setStatus('Não consegui ler esse arquivo de áudio.', true);
  }
}

// ---------------------------------------------------------------------------
// Persistência (IndexedDB para áudio, localStorage para preferências)
// ---------------------------------------------------------------------------
const DB_NAME = 'multipista';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function dbTx(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction('tracks', mode);
      const store = tx.objectStore('tracks');
      const result = fn(store);
      tx.oncomplete = () => resolve(result && result.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB indisponível', err);
    return null;
  }
}

function meta(t) {
  return {
    id: t.id, name: t.name, volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo,
    offset: t.offset, color: t.color, order: state.tracks.indexOf(t),
  };
}

function saveTrack(t) {
  return dbTx('readwrite', (s) => s.put({
    ...meta(t), sampleRate: t.buffer.sampleRate, data: t.buffer.getChannelData(0).slice(),
  }));
}

const metaTimers = new Map();
function saveMeta(t) {
  clearTimeout(metaTimers.get(t.id));
  metaTimers.set(t.id, setTimeout(() => {
    dbTx('readwrite', (s) => {
      const req = s.get(t.id);
      req.onsuccess = () => { if (req.result) s.put({ ...req.result, ...meta(t) }); };
    });
  }, 300));
}

function dbDelete(id) { return dbTx('readwrite', (s) => s.delete(id)); }

async function loadProject() {
  const rows = await dbTx('readonly', (s) => s.getAll());
  if (!rows || rows.length === 0) return;
  ensureCtx();
  rows.sort((a, b) => a.order - b.order);
  for (const r of rows) {
    const buf = ctx.createBuffer(1, r.data.length, r.sampleRate);
    buf.copyToChannel(r.data, 0);
    addTrack(buf, r);
  }
  setStatus(`Projeto restaurado: ${rows.length} pista(s).`);
}

function savePrefs() {
  try {
    localStorage.setItem('multipista.prefs', JSON.stringify({
      bpm: state.bpm, metronome: state.metronome, countIn: state.countIn,
      latencyAdjustMs: state.latencyAdjustMs, inputDeviceId: state.inputDeviceId,
      inputChannel: state.inputChannel, monitor: state.monitor,
    }));
  } catch (_) {}
}

function loadPrefs() {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem('multipista.prefs') || '{}'));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = els.inputDevice;
  sel.innerHTML = '<option value="">Padrão do sistema</option>';
  devs.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default') return;
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Entrada ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = state.inputDeviceId;
  if (sel.value !== state.inputDeviceId) sel.value = '';
}

function updateLatencyUi() {
  els.latAdjust.value = state.latencyAdjustMs;
  els.latAdjustOut.textContent = `${state.latencyAdjustMs > 0 ? '+' : ''}${state.latencyAdjustMs} ms`;
  els.latAuto.textContent = ctx ? Math.round(autoLatencySec() * 1000) : '—';
  els.latTotal.textContent = ctx ? Math.round(totalLatencySec() * 1000) : '—';
}

function syncTopbar() {
  els.bpm.value = state.bpm;
  els.btnMetro.setAttribute('aria-pressed', state.metronome);
  els.btnCount.setAttribute('aria-pressed', state.countIn);
  els.inputChannel.value = state.inputChannel;
  els.monitor.checked = state.monitor;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
els.btnPlay.addEventListener('click', togglePlay);
els.btnRec.addEventListener('click', toggleRecord);
els.btnHome.addEventListener('click', () => seek(0));

els.bpm.addEventListener('change', () => {
  state.bpm = Math.max(30, Math.min(300, +els.bpm.value || 100));
  els.bpm.value = state.bpm;
  savePrefs();
  drawAllWaves();
});
els.bpm.addEventListener('keydown', (e) => e.stopPropagation());
els.btnMetro.addEventListener('click', () => {
  state.metronome = !state.metronome;
  syncTopbar();
  savePrefs();
  if (state.playing && !state.recording) startPlayback(ctx.currentTime + 0.05);
});
els.btnCount.addEventListener('click', () => { state.countIn = !state.countIn; syncTopbar(); savePrefs(); });

els.fileImport.addEventListener('change', () => {
  const f = els.fileImport.files[0];
  if (f) importFile(f);
  els.fileImport.value = '';
});
els.btnExport.addEventListener('click', exportMix);

els.btnSettings.addEventListener('click', () => {
  updateLatencyUi();
  refreshDevices();
  els.settings.showModal();
});
els.inputDevice.addEventListener('change', () => {
  state.inputDeviceId = els.inputDevice.value;
  savePrefs();
  releaseMic();
});
els.inputChannel.addEventListener('change', () => { state.inputChannel = els.inputChannel.value; savePrefs(); });
els.latAdjust.addEventListener('input', () => { state.latencyAdjustMs = +els.latAdjust.value; updateLatencyUi(); savePrefs(); });
els.monitor.addEventListener('change', () => { state.monitor = els.monitor.checked; savePrefs(); });
els.btnNew.addEventListener('click', async () => {
  if (!confirm('Apagar todas as pistas e começar do zero?')) return;
  if (state.recording) await stopRecording();
  stopPlayback(false);
  for (const t of state.tracks) await dbDelete(t.id);
  state.tracks = [];
  state.playhead = 0;
  render();
  els.settings.close();
  setStatus('Novo projeto.');
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input[type=number], select') || els.settings.open) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecord(); }
  else if (e.key === 'Home') { e.preventDefault(); seek(0); }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawAllWaves, 100);
});

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
(async function init() {
  loadPrefs();
  syncTopbar();
  if (!window.AudioContext && !window.webkitAudioContext) {
    setStatus('Seu navegador não suporta gravação de áudio. Use Chrome, Edge, Firefox ou Safari atualizados.', true);
    return;
  }
  await loadProject();
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
