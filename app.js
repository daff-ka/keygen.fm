/* Keygen FM — web player.
   Tracks come from tracks.json; audio files live in audio/.
   Needs to be served over http(s): fetch() does not work from file://. */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const mmss = s => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + pad(s % 60); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const mobile = matchMedia('(max-width: 860px)');
const rootEl = document.documentElement;
const app = document.querySelector('.app');

const IC = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  vol: '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  mute: '<path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M22 9l-6 6"/><path d="M16 9l6 6"/>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};

let tracks = [];

/* ---------- Audio ----------
   Playback streams through an <audio> element, so a track starts after the first few KB
   instead of after downloading and decoding the whole file. The element is routed into
   Web Audio (MediaElementSource → gain → analyser) for volume and the spectrum display. */
const audio = new Audio();
audio.preload = 'metadata';
let ac, master, analyser, loading = false, muted = false;

function initAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain();
  analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = .75;
  ac.createMediaElementSource(audio).connect(master);
  master.connect(analyser);
  analyser.connect(ac.destination);
  applyVolume();
}

let idx = 0, cur = null, state = 'stop', shuffle = false, repeatMode = 'off', dragging = false; /* repeatMode: off | all | one */

const position = () => audio.currentTime || 0;

function setLoading(on) { if (loading !== on) { loading = on; refresh(); } }

function startAt(pos) {
  initAudio();
  if (ac.state === 'suspended') ac.resume();
  if (Math.abs(audio.currentTime - pos) > .05) audio.currentTime = pos;
  state = 'play';
  loading = audio.readyState < 3; /* HAVE_FUTURE_DATA */
  refresh();
  audio.play().catch(err => {
    if (err.name === 'AbortError') return; /* superseded by another load or pause */
    console.error('Keygen FM: could not play track', err);
    state = 'stop'; loading = false; refresh();
  });
}
function load(i, autoplay) {
  state = 'stop'; loading = false;
  audio.pause();
  idx = i; cur = tracks[i];
  audio.src = cur.src;
  renderNow(); updateRows(); updateMedia(); prefetchNext();
  if (autoplay) startAt(0); else refresh();
}
function toggle() {
  if (!cur) return;
  if (state === 'play') { state = 'pause'; loading = false; audio.pause(); refresh(); }
  else startAt(state === 'pause' ? audio.currentTime : 0);
}
function stop() { state = 'stop'; loading = false; audio.pause(); audio.currentTime = 0; refresh(); }
function next(auto) {
  if (!cur) return;
  let n;
  if (shuffle && tracks.length > 1) { do n = Math.floor(Math.random() * tracks.length); while (n === idx); }
  else n = idx + 1;
  /* end of playlist: auto-advance stops unless Repeat all; manual Next always wraps */
  if (n >= tracks.length) { if (auto && repeatMode !== 'all') { stop(); return; } n = 0; }
  load(n, auto || state === 'play');
}
function prev() {
  if (!cur) return;
  if (position() > 3) { audio.currentTime = 0; return; }
  load((idx - 1 + tracks.length) % tracks.length, state === 'play');
}
function seekTo(pos) {
  if (!cur) return;
  audio.currentTime = Math.max(0, Math.min(cur.dur - .05, pos));
  if (state === 'stop') { state = 'pause'; refresh(); }
}

/* Warm the browser cache with the next track in playlist order. */
function prefetchNext() {
  if (tracks.length < 2) return;
  const n = tracks[(idx + 1) % tracks.length];
  if (document.querySelector(`link[rel="prefetch"][href="${n.src}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'prefetch'; l.as = 'audio'; l.href = n.src;
  document.head.appendChild(l);
}

audio.addEventListener('loadedmetadata', () => {
  if (cur && isFinite(audio.duration)) { cur.dur = audio.duration; if (!dragging) paintTime(position()); }
});
audio.addEventListener('playing', () => setLoading(false));
audio.addEventListener('waiting', () => { if (state === 'play') setLoading(true); });
/* Repeat one uses audio.loop, so 'ended' only fires when the track should advance */
audio.addEventListener('ended', () => { if (state === 'play') next(true); });
/* paused from outside the page (headphones unplugged, OS controls) */
audio.addEventListener('pause', () => { if (state === 'play' && !audio.ended) { state = 'pause'; loading = false; refresh(); } });
audio.addEventListener('error', () => {
  if (!cur || !audio.error) return;
  console.error('Keygen FM: could not load track', cur.src, audio.error);
  state = 'stop'; loading = false; refresh();
});
function applyVolume() {
  const v = +$('vol').value, b = $('muteBtn');
  $('vol').style.setProperty('--fill', v + '%');
  if (master) master.gain.value = muted ? 0 : Math.pow(v / 100, 2);
  b.setAttribute('aria-pressed', muted);
  b.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  setTip(b, (muted ? 'Unmute' : 'Mute') + ' (M)');
  $('muteIco').innerHTML = muted ? IC.mute : IC.vol;
}

/* ---------- Now playing ---------- */
function refresh() {
  const playing = state === 'play', b = $('playBtn');
  b.innerHTML = loading ? '<span class="spin" aria-hidden="true"></span>' : (playing ? IC.pause : IC.play);
  b.setAttribute('aria-label', loading ? 'Loading track' : playing ? 'Pause' : 'Play');
  b.setAttribute('aria-busy', loading);
  setTip(b, (playing ? 'Pause' : 'Play') + ' (Space)');
  updateRows();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : state === 'pause' ? 'paused' : 'none';
}
function renderNow() {
  $('title').textContent = cur.title;
  $('meta').textContent = `${cur.group}, ${cur.release} ${cur.kind}`;
  document.title = `${cur.title} · Keygen FM`;
  paintTime(0);
}
function paintTime(p, setSeek = true) {
  $('tEl').textContent = mmss(p);
  $('tRem').textContent = '-' + mmss(cur.dur - p);
  const seek = $('seek');
  if (setSeek) seek.value = Math.round(p / cur.dur * 1000);
  seek.style.setProperty('--fill', (seek.value / 10) + '%');
  seek.setAttribute('aria-valuetext', `${mmss(p)} of ${mmss(cur.dur)}`);
}

/* ---------- Playlist ---------- */
let fmtFilter = 'All', query = '';

function renderSeg() {
  $('seg').innerHTML = ['All', ...new Set(tracks.map(t => t.fmt))]
    .map(f => `<button data-f="${esc(f)}" aria-pressed="${f === 'All'}">${esc(f)}</button>`).join('');
}
function renderList() {
  const vis = tracks.filter(t => (fmtFilter === 'All' || t.fmt === fmtFilter) &&
    (!query || (t.title + ' ' + t.group + ' ' + t.release).toLowerCase().includes(query)));
  const tot = vis.reduce((a, t) => a + t.dur, 0);
  $('sum').textContent = `${vis.length} ${vis.length === 1 ? 'track' : 'tracks'}, ${Math.floor(tot / 60)} min ${Math.round(tot % 60)} s`;
  $('list').innerHTML = vis.length
    ? vis.map(t => `<li><button class="row" data-i="${t.i}" aria-current="${t.i === idx}"><span class="lead"></span><span class="txt"><span class="t">${esc(t.title)}</span><span class="g">${esc(t.group)}</span></span><span class="du">${mmss(t.dur)}</span></button></li>`).join('')
    : `<li class="empty">No tracks match “${esc(query)}”. Try a group name or a program, like Photoshop.<button id="clearQ">Clear search</button></li>`;
  updateRows();
}
function updateRows() {
  document.querySelectorAll('.row').forEach(r => {
    const i = +r.dataset.i, on = i === idx;
    r.setAttribute('aria-current', on);
    r.querySelector('.lead').innerHTML = on
      ? `<span class="eq${state === 'play' && !loading ? ' on' : ''}" role="img" aria-label="${state === 'play' ? 'Playing' : 'Selected'}"><i></i><i></i><i></i></span>`
      : pad(i + 1);
  });
}

$('seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  fmtFilter = b.dataset.f;
  $('seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderList();
});
$('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });
$('list').addEventListener('click', e => {
  if (e.target.id === 'clearQ') { $('q').value = ''; query = ''; renderList(); $('q').focus(); return; }
  const r = e.target.closest('.row'); if (!r) return;
  load(+r.dataset.i, true);
  if (mobile.matches) document.querySelector('.np').scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'start' });
});

/* ---------- Controls ---------- */
$('playBtn').onclick = toggle;
$('prevBtn').onclick = prev;
$('nextBtn').onclick = () => next(false);
/* Toggle buttons: tooltip says what the click will do (Figma: Toggle button) */
function paintToggles() {
  $('shufBtn').setAttribute('aria-pressed', shuffle);
  setTip($('shufBtn'), shuffle ? 'Disable shuffle' : 'Enable shuffle');
  /* Repeat cycles off → all (playlist) → one (track) → off */
  const r = $('repBtn');
  r.setAttribute('aria-pressed', repeatMode !== 'off');
  r.dataset.mode = repeatMode;
  audio.loop = repeatMode === 'one';
  r.setAttribute('aria-label', 'Repeat: ' + repeatMode);
  setTip(r, { off: 'Enable repeat', all: 'Enable repeat one', one: 'Disable repeat' }[repeatMode]);
}
$('shufBtn').onclick = () => { shuffle = !shuffle; paintToggles(); };
$('repBtn').onclick = () => { repeatMode = { off: 'all', all: 'one', one: 'off' }[repeatMode]; paintToggles(); };
$('muteBtn').onclick = () => { muted = !muted; applyVolume(); };
$('vol').addEventListener('input', () => { if (muted) muted = false; applyVolume(); });
const seek = $('seek');
seek.addEventListener('input', () => { if (!cur) return; dragging = true; paintTime(seek.value / 1000 * cur.dur, false); });
seek.addEventListener('change', () => { if (!cur) return; dragging = false; seekTo(seek.value / 1000 * cur.dur); });

/* Keyboard: Space play/pause, Z prev, X play, C pause, B next, M mute, [ sidebar, ←/→ seek 5 s */
document.addEventListener('keydown', e => {
  if (!cur || e.metaKey || e.ctrlKey || e.altKey || e.target.matches('input[type="search"]')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && !e.target.matches('button,input')) { e.preventDefault(); toggle(); }
  else if (k === 'z') prev();
  else if (k === 'b') next(false);
  else if (k === 'x' && state !== 'play') toggle();
  else if (k === 'c' && state === 'play') toggle();
  else if (k === 'm') { muted = !muted; applyVolume(); }
  else if (k === '[' && !mobile.matches) setSide(app.classList.contains('collapsed'));
  else if ((k === 'arrowright' || k === 'arrowleft') && !e.target.matches('input[type="range"]')) seekTo(position() + (k === 'arrowright' ? 5 : -5));
});

function updateMedia() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: cur.title, artist: cur.group, album: cur.release });
    navigator.mediaSession.setActionHandler('play', () => { if (state !== 'play') toggle(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (state === 'play') toggle(); });
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  } catch (e) {}
}

/* ---------- Spectrum display (Figma: Motion → Spectrum display) ----------
   20 log-spaced bands; rise instant, fall 2.2 heights/s, peak falls 0.6 heights/s, glow 12.
   Reduced motion: fall 3 heights/s, no peaks, no glow. */
const cv = $('stage'), g = cv.getContext('2d');
let SW = 0, SH = 0, last = performance.now();
const freq = new Uint8Array(128), eqH = [], eqP = [];
const cssVar = name => getComputedStyle(rootEl).getPropertyValue(name).trim();
const ACC = cssVar('--color-accent-screen') || '#34E08A';
const ACC_HI = cssVar('--color-accent-screen-hi') || '#A6F7CF';
const SCREEN = cssVar('--screen-black') || '#07070B';

function sizeStage() {
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  SW = r.width; SH = r.height;
  cv.width = Math.round(SW * dpr); cv.height = Math.round(SH * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawStage(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (!SW) return;
  const playing = state === 'play' && !loading, still = reduce.matches;
  if (playing && analyser) analyser.getByteFrequencyData(freq); else freq.fill(0);

  g.globalAlpha = 1; g.fillStyle = SCREEN; g.fillRect(0, 0, SW, SH);
  const padX = 18, padY = 18, seg = 2, sgap = 2, n = 20;
  const colGap = Math.max(6, (SW - padX * 2) / n * .38);
  const bw = (SW - padX * 2 - colGap * (n - 1)) / n;
  const pitch = seg + sgap, rows = Math.floor((SH - padY * 2 + sgap) / pitch);
  const base = SH - padY, top = base - rows * pitch + sgap;
  const grad = g.createLinearGradient(0, base, 0, top);
  grad.addColorStop(0, ACC); grad.addColorStop(1, ACC_HI);

  /* unlit columns */
  g.fillStyle = ACC; g.globalAlpha = .1;
  for (let b = 0; b < n; b++) g.fillRect(padX + b * (bw + colGap), top, bw, base - top);

  /* levels */
  g.globalAlpha = 1; g.fillStyle = grad; g.shadowColor = ACC; g.shadowBlur = still ? 0 : 12;
  for (let b = 0; b < n; b++) {
    const bin = 1 + Math.floor(Math.pow(b / n, 1.5) * 95);
    const v = Math.min(1, freq[bin] / 235);
    eqH[b] = Math.max(v * rows, (eqH[b] || 0) - dt * rows * (still ? 3 : 2.2));
    eqP[b] = still ? 0 : (eqH[b] >= (eqP[b] || 0) ? eqH[b] : Math.max(0, eqP[b] - dt * rows * .6));
    const lit = Math.round(eqH[b]);
    if (lit > 0) g.fillRect(padX + b * (bw + colGap), base - lit * pitch + sgap, bw, lit * pitch - sgap);
  }

  /* peaks */
  g.shadowBlur = 0; g.fillStyle = ACC_HI;
  for (let b = 0; b < n; b++) {
    const pk = Math.round(eqP[b]);
    if (pk > Math.round(eqH[b]) && pk <= rows) g.fillRect(padX + b * (bw + colGap), base - pk * pitch + sgap, bw, seg);
  }

  /* LCD segment gaps */
  g.fillStyle = SCREEN;
  for (let r = 0; r < rows; r++) g.fillRect(0, base - (r + 1) * pitch, SW, sgap);
}
new ResizeObserver(sizeStage).observe(cv);

function loop(now) {
  if (cur && !dragging) paintTime(position());
  drawStage(now);
  requestAnimationFrame(loop);
}

/* ---------- Theme and sidebar ---------- */
const sysDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : sysDark.matches;
function paintTheme() {
  const d = isDark(), b = $('themeBtn'), l = d ? 'Switch to light theme' : 'Switch to dark theme';
  b.innerHTML = d ? IC.sun : IC.moon;
  b.setAttribute('aria-label', l);
  setTip(b, l);
}
$('themeBtn').onclick = () => {
  rootEl.dataset.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('kgfm-theme', rootEl.dataset.theme); } catch (e) {}
  paintTheme();
};
sysDark.addEventListener('change', paintTheme);

function setSide(open) {
  app.classList.toggle('collapsed', !open);
  const b = $('sideBtn'), l = open ? 'Collapse playlist' : 'Expand playlist';
  b.setAttribute('aria-expanded', open);
  b.setAttribute('aria-label', l);
  setTip(b, l + ' ([)');
  try { localStorage.setItem('kgfm-side', open ? 'open' : 'closed'); } catch (e) {}
}
$('sideBtn').onclick = () => setSide(app.classList.contains('collapsed'));

/* ---------- Tooltips (Figma: Motion → Tooltip) ----------
   Icon buttons carry their label in data-tip; the native title is removed so it does not double up. */
const tip = document.createElement('div');
tip.className = 'tip'; tip.setAttribute('aria-hidden', 'true');
document.body.appendChild(tip);
let tipFor = null, tipTimer = null;

function setTip(el, text) { el.dataset.tip = text; el.removeAttribute('title'); if (tipFor === el) showTip(el); }
document.querySelectorAll('[title]').forEach(el => setTip(el, el.getAttribute('title')));

function showTip(el) {
  const t = el.dataset.tip; if (!t) return;
  const m = t.match(/^(.*?)\s*\(([^)]+)\)$/);
  tip.textContent = '';
  const s = document.createElement('span'); s.textContent = m ? m[1] : t; tip.appendChild(s);
  if (m) { const k = document.createElement('kbd'); k.textContent = m[2]; tip.appendChild(k); }
  tipFor = el;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  let y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
  tip.classList.add('on');
}
function hideTip() { clearTimeout(tipTimer); tip.classList.remove('on'); tipFor = null; }
const tipDelay = () => parseFloat(cssVar('--delay-tooltip')) || 400;

document.addEventListener('pointerover', e => {
  const el = e.target.closest('[data-tip]');
  if (!el || e.pointerType === 'touch' || el === tipFor) return;
  clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el), tipDelay());
});
document.addEventListener('pointerout', e => {
  const el = e.target.closest('[data-tip]'); if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideTip();
});
document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); }, true);
window.addEventListener('scroll', hideTip, true);

/* ---------- Boot ---------- */
paintTheme();
paintToggles();
try { if (localStorage.getItem('kgfm-side') === 'closed') setSide(false); } catch (e) {}
applyVolume();
requestAnimationFrame(loop);

fetch('tracks.json')
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(data => {
    tracks = data.map((d, i) => ({ i, fmt: 'XM', ...d }));
    renderSeg(); renderList(); load(0, false);
  })
  .catch(err => {
    console.error('Keygen FM: could not load tracks.json', err);
    $('sum').textContent = 'Playlist unavailable';
    $('list').innerHTML = '<li class="empty">The playlist could not be loaded. Open the player through a web server, not as a local file.</li>';
  });
})();
