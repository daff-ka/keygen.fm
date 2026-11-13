/* Keygen FM — 8-bit converter (MIDI → chip).
   Plays a MIDI file on a console-style sound chip and saves it as an MP3 or an XM tracker module:
   - drums (channel 10): kick → a falling triangle "thump", snare / hats / toms / cymbals → noise
     with their own pitch and decay
   - bass: tracks with a bass instrument (General MIDI 33–40) or a low register → stepped triangle
   - lead: the highest sounding note → pulse 1, re-struck on every note-on
   - chords: the other notes → pulse 2, stepped through as a fast arpeggio (the classic chip trick)
   Volumes come from note velocity, in the chip's 16 steps. 60 frames a second, like the NES.
   Runs entirely in the browser; the file is never uploaded. */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const dlg = $('conv');
if (!dlg) return;

const RATES = [4000, 5512, 8000, 11025, 16000, 22050];
const MAX_SECONDS = 15 * 60;
const BASE_RATE = 44100, FPS = 60, TAIL = .5;   /* seconds of release after the last note */

const pad = n => String(n).padStart(2, '0');
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + pad(s % 60); };
const kHz = r => (r % 1000 === 0 || r >= 10000 ? Math.round(r / 1000) : (r / 1000).toFixed(1)) + ' kHz';
const IC = {
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
};
$('convBtn').innerHTML = IC.chip;
$('convClose').innerHTML = IC.close;

/* ---------- state ---------- */
let song = null;         /* parsed MIDI: { notes, duration, tracks } */
let score = null;        /* chip arrangement, 60 frames a second */
let preview = null;      /* rendered AudioBuffer (44.1 kHz) */
let xmCache = null;      /* XM module for the current settings */
let fileName = '', loadToken = 0;
let params = { bits: 8, rate: 5, duty: .25, drums: true, arp: true };
let ac = null, node = null, playing = false, startedAt = 0, offset = 0, dragging = false, renderTimer = null;
const length = () => song ? song.duration + TAIL : 0;

const status = msg => { $('convStatus').textContent = msg || ''; };
const yieldUI = () => new Promise(r => setTimeout(r, 0));

/* ---------- open / close ---------- */
$('convBtn').onclick = () => { dlg.showModal(); document.dispatchEvent(new CustomEvent('kgfm:pause-player')); };
$('convClose').onclick = () => dlg.close();
dlg.addEventListener('close', () => stopPreview(true));
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

/* ---------- file input ---------- */
const drop = $('drop');
$('convFile').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

async function loadFile(file) { loadBuffer(file.name, () => file.arrayBuffer()); }
async function loadBuffer(name, getBuffer) {
  const my = ++loadToken;
  stopPreview(true);
  $('convBody').hidden = true;
  $('cAdd').textContent = 'Add to playlist';
  status(`Reading ${name}…`);
  try {
    const parsed = parseMidi(await getBuffer());
    if (my !== loadToken) return;
    if (!parsed.notes.length) { status('This MIDI file has no notes.'); return; }
    if (parsed.duration > MAX_SECONDS) { status(`This file is ${mmss(parsed.duration)} long. Please use one up to 15 minutes.`); return; }
    song = parsed; score = arrange(song);
    fileName = name.replace(/\.[^.]+$/, '');
    $('convName').textContent = name;
    const pitched = song.notes.filter(n => n.ch !== 9).length, drumN = song.notes.length - pitched;
    $('convInfo').textContent = `${mmss(song.duration)} · ${song.tracks} ${song.tracks === 1 ? 'track' : 'tracks'} · ${pitched} notes${drumN ? ` · ${drumN} drum hits` : ''}`;
    $('dropText').textContent = 'Choose another file or drop it here';
    offset = 0;
    await render();
    if (my !== loadToken) return;
    $('convBody').hidden = false;
  } catch (e) {
    console.error('Keygen FM converter: MIDI read failed', e);
    status('This file could not be read as MIDI. Use a standard .mid file.');
  }
}

/* ---------- BitMidi browser ----------
   bitmidi.com has a public JSON search API and serves its files with CORS, so the converter can
   search and load MIDI straight from the browser (no server of ours involved). */
const BITMIDI = 'https://bitmidi.com';
let findTimer = null, findToken = 0, findPage = 0, findQuery = '', findItems = [];
const fmtPlays = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k plays' : n + ' plays';
async function searchMidi(q, page) {
  const my = ++findToken, list = $('findList');
  if (!page) { findItems = []; list.innerHTML = '<li class="conv-note-row">Searching BitMidi…</li>'; }
  list.hidden = false; $('findCredit').hidden = false;
  try {
    const r = await fetch(`${BITMIDI}/api/midi/search?q=${encodeURIComponent(q)}&page=${page}`);
    if (!r.ok) throw new Error(r.status);
    const res = (await r.json()).result;
    if (my !== findToken) return;
    findItems = findItems.concat(res.results || []); findPage = page; findQuery = q;
    if (!findItems.length) { list.innerHTML = `<li class="conv-note-row">Nothing found for “${q.replace(/[<&]/g, '')}”. Try fewer or other words.</li>`; return; }
    list.innerHTML = findItems.map((it, i) => {
      const alt = (it.alternateNames || []).filter(n => n !== it.name).slice(0, 3).join(' · ');
      return `<li><button class="conv-res" type="button" data-i="${i}"><span>${it.name.replace(/[<&]/g, '')}${alt ? `<span class="alt">${alt.replace(/[<&]/g, '')}</span>` : ''}</span><span class="plays">${fmtPlays(it.plays || 0)}</span></button></li>`;
    }).join('') + (res.pageTotal > page + 1 ? '<li><button class="conv-more" type="button" id="findMore">More results</button></li>' : '');
  } catch (e) {
    if (my !== findToken) return;
    console.error('Keygen FM converter: BitMidi search failed', e);
    list.innerHTML = '<li class="conv-note-row">BitMidi could not be reached. Check your connection or try again later.</li>';
  }
}
['focus', 'click'].forEach(t => $('findQ').addEventListener(t, () => { if (findItems.length) $('findList').hidden = false; }));
$('findForm').addEventListener('submit', e => { e.preventDefault(); clearTimeout(findTimer); const q = $('findQ').value.trim(); if (q) searchMidi(q, 0); });
$('findQ').addEventListener('input', e => {
  clearTimeout(findTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('findList').hidden = true; return; }
  findTimer = setTimeout(() => searchMidi(q, 0), 450);
});
$('findList').addEventListener('click', e => {
  if (e.target.closest('#findMore')) { searchMidi(findQuery, findPage + 1); return; }
  const b = e.target.closest('.conv-res'); if (!b) return;
  const it = findItems[+b.dataset.i];
  $('findList').querySelectorAll('.conv-res').forEach(x => x.setAttribute('aria-current', x === b));
  $('findList').hidden = true;                              /* collapse after choosing; focus the field to see them again */
  loadBuffer(it.name, async () => { const r = await fetch(BITMIDI + it.downloadUrl); if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
});

/* ---------- MIDI parser (Standard MIDI File, format 0 and 1) ---------- */
function parseMidi(buffer) {
  const d = new DataView(buffer);
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
  if (str(4) !== 'MThd') throw new Error('not a MIDI file');
  const hlen = u32(), hstart = p; u16(); const ntrks = u16(), div = u16(); p = hstart + hlen;
  const smpte = div & 0x8000, tpq = div;
  const ev = [];          /* { tick, ord, trk, kind, … } across all tracks */
  let ord = 0, tracks = 0;
  for (let t = 0; t < ntrks && p + 8 <= d.byteLength; t++) {
    const id = str(4), len = u32(), end = Math.min(d.byteLength, p + len);
    if (id !== 'MTrk') { p = end; continue; }
    tracks++;
    let tick = 0, run = 0;
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st < 0x80) st = run; else { p++; if (st < 0xF0) run = st; }
      if (st === 0xFF) {                                        /* meta */
        const type = d.getUint8(p++), l = vlq();
        if (type === 0x51 && l === 3) ev.push({ tick, ord: ord++, kind: 'tempo', us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        p += l; if (type === 0x2F) break;
      } else if (st === 0xF0 || st === 0xF7) { p += vlq(); }    /* sysex */
      else {
        const type = st & 0xF0, ch = st & 15, a = d.getUint8(p++), b = (type === 0xC0 || type === 0xD0) ? 0 : d.getUint8(p++);
        if (type === 0x90 && b > 0) ev.push({ tick, ord: ord++, trk: t, kind: 'on', ch, key: a, vel: b });
        else if (type === 0x80 || (type === 0x90 && b === 0)) ev.push({ tick, ord: ord++, trk: t, kind: 'off', ch, key: a });
        else if (type === 0xC0) ev.push({ tick, ord: ord++, trk: t, kind: 'prog', ch, prog: a });
      }
    }
    p = end;
  }
  ev.sort((x, y) => x.tick - y.tick || (x.kind === 'off' ? -1 : 0) - (y.kind === 'off' ? -1 : 0) || x.ord - y.ord);
  /* ticks → seconds through the tempo map */
  let usPerQ = 500000, lastTick = 0, lastSec = 0;
  const secPerTick = () => smpte ? 1 / ((256 - (div >> 8)) * (div & 255)) : usPerQ / 1e6 / tpq;
  const prog = new Array(16).fill(0), open = new Map(), notes = [];
  for (const e of ev) {
    const sec = lastSec + (e.tick - lastTick) * secPerTick(); lastTick = e.tick; lastSec = sec;
    if (e.kind === 'tempo') usPerQ = e.us;
    else if (e.kind === 'prog') prog[e.ch] = e.prog;
    else {
      const k = e.trk * 2048 + e.ch * 128 + e.key;
      if (e.kind === 'on') { if (!open.has(k)) open.set(k, []); open.get(k).push({ t0: sec, p: e.key, v: e.vel / 127, ch: e.ch, prog: prog[e.ch], trk: e.trk }); }
      else { const q = open.get(k); if (q && q.length) { const n = q.shift(); n.t1 = Math.max(sec, n.t0 + .02); notes.push(n); } }
    }
  }
  open.forEach(q => q.forEach(n => { n.t1 = Math.max(lastSec, n.t0 + .25); notes.push(n); }));   /* notes never released */
  notes.sort((a, b) => a.t0 - b.t0 || a.p - b.p);
  const duration = notes.reduce((m, n) => Math.max(m, n.t1), 0);
  return { notes, duration, tracks };
}

/* ---------- arrangement for the chip ---------- */
/* General MIDI drum keys → chip sound: kick on the triangle, the rest on noise with
   [LFSR clock divider (higher = lower pitch), decay per frame] */
const DRUM = {
  kick: new Set([35, 36]),
  noise: {
    37: [6, .5], 38: [5, .62], 39: [4, .6], 40: [5, .62],                    /* side stick, snare, clap */
    42: [1, .4], 44: [1, .45], 46: [1, .82],                                  /* hi-hats: closed, pedal, open */
    41: [12, .66], 43: [11, .66], 45: [10, .66], 47: [9, .66], 48: [8, .66], 50: [7, .66],  /* toms */
    49: [2, .9], 52: [2, .9], 55: [2, .88], 57: [2, .9], 51: [1, .8], 53: [1, .75], 59: [1, .8]   /* cymbals, rides */
  }
};
function arrange(s) {
  const frames = Math.max(1, Math.ceil(length() * FPS));
  const fr = t => Math.max(0, Math.min(frames - 1, Math.round(t * FPS)));
  /* bass parts: General MIDI bass programs (32–39), or tracks whose notes sit mostly low */
  const parts = new Map();
  s.notes.forEach(n => { if (n.ch === 9) return; const k = n.trk * 16 + n.ch; const q = parts.get(k) || { sum: 0, cnt: 0, bassProg: false }; q.sum += n.p; q.cnt++; q.bassProg = q.bassProg || (n.prog >= 32 && n.prog <= 39); parts.set(k, q); });
  const isBass = n => { const q = parts.get(n.trk * 16 + n.ch); return q && (q.bassProg || q.sum / q.cnt < 48); };

  const tri = new Int16Array(frames), p1 = new Int16Array(frames), p2 = new Int16Array(frames);
  const triV = new Uint8Array(frames), p1V = new Uint8Array(frames), p2V = new Uint8Array(frames);
  const trT = new Uint8Array(frames), tr1 = new Uint8Array(frames), tr2 = new Uint8Array(frames);
  const chord = new Int16Array(frames * 3), chordN = new Uint8Array(frames);
  const hit = new Uint8Array(frames), hitP = new Uint8Array(frames), hitD = new Float32Array(frames), kick = new Uint8Array(frames);
  const vol = v => Math.max(4, Math.min(15, Math.round(v * 15)));

  /* drums */
  s.notes.filter(n => n.ch === 9).forEach(n => {
    const f = fr(n.t0);
    if (DRUM.kick.has(n.p)) kick[f] = Math.max(kick[f], vol(n.v));
    else { const d = DRUM.noise[n.p] || [3, .6]; if (vol(n.v) >= hit[f]) { hit[f] = vol(n.v); hitP[f] = d[0]; hitD[f] = d[1]; } }
  });

  /* pitched notes per frame */
  const startAt = Array.from({ length: frames }, () => []);
  s.notes.filter(n => n.ch !== 9).forEach(n => { const f0 = fr(n.t0); startAt[f0].push({ p: n.p, v: n.v, s: f0, end: Math.max(f0 + 1, fr(n.t1)), bass: isBass(n) }); });
  let active = [], lead = null, bass = null, prevChord = '';
  for (let f = 0; f < frames; f++) {
    active = active.filter(n => n.end > f).concat(startAt[f]);
    if (!active.length) { lead = bass = null; continue; }
    /* bass: lowest note of a bass part; with no bass part sounding, the lowest note if it is low (< E3) */
    const bassNotes = active.filter(n => n.bass), others = active.filter(n => !n.bass);
    const bassCand = bassNotes.length ? bassNotes.reduce((a, b) => a.p <= b.p ? a : b) :
      (others.length > 1 ? others.reduce((a, b) => a.p <= b.p ? a : b) : null);
    if (bassCand && (bassNotes.length || bassCand.p < 52)) {
      if (bass !== bassCand && (!bass || bassCand.s === f || !active.includes(bass))) { if (bassCand.s === f || bass === null || bass.p !== bassCand.p) trT[f] = 1; bass = bassCand; }
      tri[f] = bass.p; triV[f] = vol(bass.v);
    } else bass = null;
    /* lead: the highest of the remaining notes; keep it while it sounds unless a higher note starts */
    const rest = active.filter(n => n !== bass && !n.bass);
    if (!rest.length) { lead = null; continue; }
    const top = rest.reduce((a, b) => a.p >= b.p ? a : b);
    if (!lead || !rest.includes(lead) || (top !== lead && top.s === f && top.p >= lead.p)) { if (lead !== top) tr1[f] = 1; lead = top; }
    p1[f] = lead.p; p1V[f] = vol(lead.v);
    /* chord: other notes below the lead, distinct note names, up to three */
    const seen = new Set([lead.p % 12]), under = [];
    rest.filter(n => n !== lead && n.p < lead.p).sort((a, b) => b.p - a.p).forEach(n => { if (under.length < 3 && !seen.has(n.p % 12)) { seen.add(n.p % 12); under.push(n); } });
    if (under.length) {
      p2[f] = under[0].p; p2V[f] = vol(Math.max(...under.map(n => n.v)) * .9);
      under.forEach((n, k) => { chord[f * 3 + k] = n.p; }); chordN[f] = under.length;
      const key = under.map(n => n.p).join(','); if (key !== prevChord || under.some(n => n.s === f)) tr2[f] = 1; prevChord = key;
    } else prevChord = '';
  }
  return { frames, hop44: BASE_RATE / FPS, tri, triV, p1, p1V, p2, p2V, chord, chordN, trT, tr1, tr2, hit, hitP, hitD, kick };
}

/* ---------- synthesis ---------- */
const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
function synth(s, duty, drums, arp) {
  const n = Math.ceil(length() * BASE_RATE), out = new Float32Array(n), spf = s.hop44;
  let ph1 = 0, ph2 = 0, pht = 0, lfsr = 1, noiseOut = 1, noiseAcc = 0, noiseVol = 0, noiseDiv = 4, noiseDecay = .6;
  let v1 = 0, v2 = 0, vt = 0, kickT = 0, kickV = 1;
  for (let f = 0; f < s.frames; f++) {
    const a = Math.floor(f * spf), b = Math.min(n, Math.floor((f + 1) * spf));
    /* arpeggio: with a chord under the lead, pulse 2 steps through its notes every 2 frames (30 Hz) */
    const n2 = arp && s.chordN[f] > 1 ? s.chord[f * 3 + ((f >> 1) % s.chordN[f])] : s.p2[f];
    if (drums && s.kick[f]) { kickT = 4; kickV = s.kick[f] / 15; }    /* kick: triangle falls ~180 → ~50 Hz over 4 frames */
    const kicking = kickT > 0, kickHz = kicking ? 50 + 130 * (kickT - 1) / 3 : 0;
    const f1 = s.p1V[f] ? mtof(s.p1[f]) / BASE_RATE : 0, f2 = s.p2V[f] ? mtof(n2) / BASE_RATE : 0, ft = kicking ? kickHz / BASE_RATE : s.triV[f] ? mtof(s.tri[f]) / BASE_RATE : 0;
    const t1 = s.p1V[f] / 15, t2 = s.p2V[f] / 15, tt = kicking ? kickV : s.triV[f] ? Math.max(.6, s.triV[f] / 15) : 0;
    if (kicking) kickT--;
    /* re-strike: a new note dips the voice to near silence, the fast attack brings it back */
    if (s.tr1[f]) v1 *= .05;
    if (s.tr2[f] && !arp) v2 *= .05;
    if (s.trT[f] && !kicking) vt *= .05;
    if (drums && s.hit[f]) { noiseVol = s.hit[f] / 15; noiseDiv = s.hitP[f]; noiseDecay = s.hitD[f]; }
    for (let i = a; i < b; i++) {
      /* fast attack (~1 ms), soft release (~30 ms) */
      v1 += (t1 - v1) * (t1 > v1 ? .02 : .0008); v2 += (t2 - v2) * (t2 > v2 ? .02 : .0008); vt += (tt - vt) * (tt > vt ? .02 : .0008);
      ph1 = (ph1 + f1) % 1; ph2 = (ph2 + f2) % 1; pht = (pht + ft) % 1;
      const pulse1 = ph1 < duty ? 1 : -1, pulse2 = ph2 < .5 ? 1 : -1;
      const triStep = Math.round((pht < .5 ? pht * 2 : 2 - pht * 2) * 15) / 15 * 2 - 1;   /* 16-step triangle */
      let x = pulse1 * v1 * .24 + pulse2 * v2 * .16 + triStep * vt * .3;
      if (noiseVol > .001) {
        if (++noiseAcc >= noiseDiv) { noiseAcc = 0; const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << 14); noiseOut = lfsr & 1 ? 1 : -1; } /* 15-bit LFSR */
        x += noiseOut * noiseVol * .2;
      }
      out[i] = x;
    }
    noiseVol *= noiseDecay;   /* per-frame decay: short for hats, long for cymbals */
  }
  return out;
}

/* ---------- 8-bit stage ---------- */
function normalise(d, to = .95) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  const g = peak > 0 ? to / peak : 1;
  for (let i = 0; i < d.length; i++) d[i] *= g;
  return d;
}
/* sample-and-hold to the target rate + quantise to 2^bits levels, at 44.1 kHz for the preview */
function crush(d, bits, rate) {
  const n = d.length, step = BASE_RATE / RATES[rate], levels = Math.pow(2, bits) - 1;
  const q = v => Math.round((Math.max(-1, Math.min(1, v)) * .5 + .5) * levels) / levels * 2 - 1;
  const out = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: BASE_RATE }), o = out.getChannelData(0);
  let held = 0, next = 0;
  for (let i = 0; i < n; i++) { if (i >= next) { held = q(d[Math.floor(next)]); next += step; } o[i] = held; }
  return out;
}

/* ---------- render the preview ---------- */
async function render() {
  if (!song) return;
  const wasPlaying = playing, pos = position();
  if (wasPlaying) stopPreview(false);
  status('Synthesising…'); await yieldUI();
  preview = crush(normalise(synth(score, params.duty, params.drums, params.arp)), params.bits, params.rate);
  /* the XM is built right away (milliseconds), so its exact size can be shown and the download is instant */
  try { xmCache = xmBytes(); } catch (e) { xmCache = null; console.error('Keygen FM converter: XM build failed', e); }
  const fmt = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
  $('cSize').textContent = `MP3 ≈ ${fmt(length() * 16000)} · XM ${xmCache ? fmt(xmCache.length) : '—'}`;
  status('');
  if (wasPlaying) startPreview(pos);
  paintTime(pos);
}
const scheduleRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 120); };

/* ---------- controls ---------- */
function setFill(r) { r.style.setProperty('--fill', ((r.value - r.min) / (r.max - r.min) * 100) + '%'); }
function paintControls() {
  $('cBits').value = params.bits; $('oBits').textContent = `${params.bits} bit`;
  $('cRate').value = params.rate; $('oRate').textContent = kHz(RATES[params.rate]);
  $('cDrums').checked = params.drums; $('cArp').checked = params.arp;
  $('cDuty').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.d === params.duty));
  ['cBits', 'cRate'].forEach(id => setFill($(id)));
}
$('cDuty').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; params.duty = +b.dataset.d; paintControls(); scheduleRender(); });
$('cBits').addEventListener('input', e => { params.bits = +e.target.value; paintControls(); scheduleRender(); });
$('cRate').addEventListener('input', e => { params.rate = +e.target.value; paintControls(); scheduleRender(); });
$('cDrums').addEventListener('change', e => { params.drums = e.target.checked; scheduleRender(); });
$('cArp').addEventListener('change', e => { params.arp = e.target.checked; scheduleRender(); });
paintControls();

/* ---------- preview ---------- */
function position() { return !playing || !ac ? offset : Math.min(length(), offset + ac.currentTime - startedAt); }
function startPreview(pos) {
  if (!preview) return;
  if (!ac) {
    if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
    ac = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ac.state !== 'running') ac.resume();
  node = ac.createBufferSource(); node.buffer = preview; node.connect(ac.destination);
  offset = Math.max(0, Math.min(pos, length() - .05));
  node.start(0, offset); startedAt = ac.currentTime; playing = true;
  node.onended = () => { if (node && playing && position() >= length() - .1) { stopPreview(false); offset = 0; paintTime(0); } };
  paintPlay();
}
function stopPreview(reset) {
  if (node) { const n = node; node = null; try { n.stop(); } catch (e) {} n.disconnect(); }
  if (playing) offset = position();
  playing = false;
  if (reset) offset = 0;
  paintPlay();
}
function paintPlay() {
  const b = $('cPlay');
  b.innerHTML = playing ? IC.pause : IC.play;
  b.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
}
$('cPlay').onclick = () => { if (playing) stopPreview(false); else { document.dispatchEvent(new CustomEvent('kgfm:pause-player')); startPreview(offset); } };
const seek = $('cSeek');
seek.addEventListener('input', () => { dragging = true; paintTime(seek.value / 1000 * length(), false); });
seek.addEventListener('change', () => {
  dragging = false;
  const pos = seek.value / 1000 * length();
  if (playing) { stopPreview(false); startPreview(pos); } else { offset = pos; paintTime(pos); }
});
function paintTime(p, setSeek = true) {
  if (!song) return;
  $('cTime').textContent = `${mmss(p)} / ${mmss(length())}`;
  if (setSeek) seek.value = Math.round(p / length() * 1000);
  seek.style.setProperty('--fill', (seek.value / 10) + '%');
  seek.setAttribute('aria-valuetext', `${mmss(p)} of ${mmss(length())}`);
}
(function tick() { if (dlg.open && playing && !dragging) paintTime(position()); requestAnimationFrame(tick); })();

/* ---------- export ---------- */
function download(bytes, type, ext) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = `${fileName || 'keygen-fm'}-chip.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(`Saved ${a.download}`);
}
/* MP3: the preview as heard, mono 44.1 kHz 128 kbps, encoded with lamejs (LAME), loaded on first use */
let lamePromise = null;
function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (!lamePromise) lamePromise = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'lib/lamejs-1.2.1/lame.min.js';
    sc.onload = () => window.lamejs && window.lamejs.Mp3Encoder ? res(window.lamejs) : rej(new Error('lamejs did not load'));
    sc.onerror = () => { lamePromise = null; rej(new Error('lamejs could not be downloaded')); };
    document.head.appendChild(sc);
  });
  return lamePromise;
}
async function mp3Bytes() {
  status('Loading the MP3 encoder…');
  const lame = await loadLame(), enc = new lame.Mp3Encoder(1, BASE_RATE, 128), data = preview.getChannelData(0);
  const chunks = [], block = 1152, pcm = new Int16Array(block);
  for (let i = 0, k = 0; i < data.length; i += block, k++) {
    const n = Math.min(block, data.length - i);
    for (let j = 0; j < n; j++) pcm[j] = Math.max(-32768, Math.min(32767, Math.round(data[i + j] * 32767)));
    const out = enc.encodeBuffer(n === block ? pcm : pcm.subarray(0, n));
    if (out.length) chunks.push(out);
    if (k % 400 === 0) { status(`Encoding MP3… ${Math.round(i / data.length * 100)} %`); await yieldUI(); }
  }
  const tail = enc.flush(); if (tail.length) chunks.push(tail);
  const bytes = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0; chunks.forEach(c => { bytes.set(c, o); o += c.length; });
  return bytes;
}
/* XM: a FastTracker 2 module built from the arrangement. One row per frame (speed 1, 150 BPM =
   60 rows a second, like the chip), six channels: lead, harmony, bass, noise, kick, spare.
   Instruments are the chip waveforms as tiny looped samples: a 32-sample cycle at 8363 Hz sounds
   C-4 (261.3 Hz, finetune +2 → 261.6 Hz), so XM note = MIDI note − 11. */
function xmBytes() {
  const s = score, rows = s.frames, CH = 6, PAT = 256;
  /* samples (8-bit signed) */
  const A = 100;
  const pulse = duty => Int8Array.from({ length: 32 }, (_, i) => i < 32 * duty ? A : -A);
  const triangle = Int8Array.from({ length: 32 }, (_, i) => { const ph = i / 32; return Math.round((Math.round((ph < .5 ? ph * 2 : 2 - ph * 2) * 15) / 15 * 2 - 1) * 120); });
  const noise = (() => { const n = new Int8Array(16384); let l = 1; for (let i = 0; i < n.length; i++) { const bit = (l ^ (l >> 1)) & 1; l = (l >> 1) | (bit << 14); n[i] = l & 1 ? 80 : -80; } return n; })();
  const kick = (() => { const sr = 8363, len = Math.round(sr * 5 / 60), k = new Int8Array(len); let ph = 0;
    for (let i = 0; i < len; i++) { const fr = Math.min(3, Math.floor(i / (sr / 60))), hz = 50 + 130 * (3 - fr) / 3; ph = (ph + hz / sr) % 1; const env = i < sr * 4 / 60 ? 1 : 1 - (i - sr * 4 / 60) / (sr / 60);
      k[i] = Math.round((Math.round((ph < .5 ? ph * 2 : 2 - ph * 2) * 15) / 15 * 2 - 1) * 120 * env); } return k; })();
  const INS = [
    { name: 'Lead pulse', data: pulse(params.duty), loop: true, vol: 48, fine: 2 },
    { name: 'Harmony pulse', data: pulse(.5), loop: true, vol: 34, fine: 2 },
    { name: 'Triangle bass', data: triangle, loop: true, vol: 64, fine: 2 },
    { name: 'Noise', data: noise, loop: true, vol: 44, fine: 0 },
    { name: 'Kick', data: kick, loop: false, vol: 64, fine: 0 }
  ];
  const xmNote = midi => Math.max(1, Math.min(96, midi - 11)), KEYOFF = 97;
  const noiseNote = div => Math.max(1, Math.min(96, Math.round(49 + 12 * Math.log2((BASE_RATE / div) / 8363))));
  const v64 = v15 => Math.max(1, Math.min(64, Math.round(v15 / 15 * 64)));
  /* cells: one Int16 per field, -1 = empty */
  const cell = new Int16Array(rows * CH * 3).fill(-1);   /* note, instrument, volume */
  const put = (r, c, note, ins, vol) => { const o = (r * CH + c) * 3; if (note != null) cell[o] = note; if (ins != null) cell[o + 1] = ins; if (vol != null) cell[o + 2] = 0x10 + vol; };
  const voice = (c, ins, notes, vols, strikes, noteAt) => {
    let on = false, cur = 0, curV = -1;
    for (let r = 0; r < rows; r++) {
      const v = vols[r];
      if (!v) { if (on) { put(r, c, KEYOFF, null, null); on = false; } continue; }
      const n = noteAt ? noteAt(r) : notes[r], vv = v64(v);
      if (!on || n !== cur || (strikes && strikes[r])) { put(r, c, xmNote(n), ins, vv); on = true; cur = n; curV = vv; }
      else if (vv !== curV) { put(r, c, null, null, vv); curV = vv; }
    }
  };
  voice(0, 1, s.p1, s.p1V, s.tr1);
  voice(1, 2, s.p2, s.p2V, params.arp ? null : s.tr2, params.arp ? r => (s.chordN[r] > 1 ? s.chord[r * 3 + ((r >> 1) % s.chordN[r])] : s.p2[r]) : null);
  voice(2, 3, s.tri, Uint8Array.from(s.triV, (v, r) => v ? Math.max(9, v) : 0), s.trT);
  if (params.drums) {
    let nv = 0, decay = .6;
    for (let r = 0; r < rows; r++) {
      if (s.hit[r]) { nv = s.hit[r] / 15; decay = s.hitD[r]; put(r, 3, noiseNote(s.hitP[r]), 4, v64(s.hit[r])); }
      else if (nv > 0) { const before = v64(nv * 15); nv *= decay; if (nv < .03) { put(r, 3, KEYOFF, null, null); nv = 0; } else if (v64(nv * 15) !== before) put(r, 3, null, null, v64(nv * 15)); }
      if (s.kick[r]) put(r, 4, 49, 5, v64(s.kick[r]));
    }
  }
  /* assemble */
  const bytes = [], u8 = v => bytes.push(v & 255), u16 = v => { u8(v); u8(v >> 8); }, u32 = v => { u16(v); u16(v >>> 16); };
  const txt = (s, n) => { for (let i = 0; i < n; i++) u8(i < s.length ? s.charCodeAt(i) & 127 : 0); };
  const npat = Math.max(1, Math.ceil(rows / PAT));
  if (npat > 256) throw new Error('song too long for one XM');
  txt('Extended Module: ', 17); txt((fileName || 'Keygen FM').slice(0, 20), 20); u8(0x1A); txt('Keygen FM converter', 20);
  u16(0x0104); u32(276); u16(npat); u16(0); u16(CH); u16(npat); u16(INS.length); u16(1); u16(1); u16(150);
  for (let i = 0; i < 256; i++) u8(i < npat ? i : 0);
  for (let p = 0; p < npat; p++) {
    const r0 = p * PAT, nr = Math.min(PAT, rows - r0), packed = [];
    for (let r = r0; r < r0 + nr; r++) for (let c = 0; c < CH; c++) {
      const o = (r * CH + c) * 3, note = cell[o], ins = cell[o + 1], vol = cell[o + 2];
      let flag = 0x80; if (note >= 0) flag |= 1; if (ins >= 0) flag |= 2; if (vol >= 0) flag |= 4;
      packed.push(flag); if (note >= 0) packed.push(note); if (ins >= 0) packed.push(ins); if (vol >= 0) packed.push(vol);
    }
    u32(9); u8(0); u16(nr); u16(packed.length); packed.forEach(u8);
  }
  INS.forEach(ins => {
    const start = bytes.length;
    u32(263); txt(ins.name, 22); u8(0); u16(1); u32(40);
    while (bytes.length - start < 263) u8(0);            /* keymap, envelopes, vibrato, fadeout: all zero */
    const n = ins.data.length;
    u32(n); u32(0); u32(ins.loop ? n : 0); u8(ins.vol); u8(ins.fine); u8(ins.loop ? 1 : 0); u8(128); u8(0); u8(0); txt(ins.name, 22);
    let prev = 0; for (let i = 0; i < n; i++) { u8(ins.data[i] - prev); prev = ins.data[i]; }   /* delta-encoded */
  });
  return new Uint8Array(bytes);
}
/* Add to my tracks: hand the XM to the player, which keeps it in this browser (Added tab) */
$('cAdd').addEventListener('click', () => {
  if (!preview) return;
  const b = $('cAdd'); b.disabled = true;
  const data = (xmCache || xmBytes()).slice().buffer, title = fileName.replace(/_+/g, ' ').trim() || 'Untitled';
  document.dispatchEvent(new CustomEvent('kgfm:add-track', { detail: {
    meta: { title, group: 'My conversions', release: fileName + '.mid', kind: '8-bit conversion', ch: 6, dur: Math.floor(length()) },
    data,
    done: (ok, err) => {
      b.disabled = false;
      if (ok) { b.textContent = 'Added'; status(`Added “${title}” to the playlist. Find it in the Added tab.`); }
      else status(`Could not add it to the playlist${err ? ': ' + err.message : ''}. Download the XM instead.`);
    }
  } }));
});
$('cExport').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !preview) return;
  const btns = $('cExport').querySelectorAll('button'); btns.forEach(x => x.disabled = true);
  try {
    if (b.dataset.f === 'mp3') download(await mp3Bytes(), 'audio/mpeg', 'mp3');
    else download(xmCache || xmBytes(), 'audio/x-xm', 'xm');
  } catch (err) {
    console.error('Keygen FM converter: export failed', err);
    status(`Could not save the ${b.dataset.f.toUpperCase()} file: ${err.message}`);
  } finally { btns.forEach(x => x.disabled = false); }
});
})();
