/* Keygen FM — web player.
   Tracks come from tracks.json; tracker modules live in audio/.
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
  visualizer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h3l2.5-6 4 12 3-9 2 3H21"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};

let tracks = [];

/* ---------- Audio ----------
   Tracks are tracker modules (.xm, .mod, .it, .s3m) rendered live by libopenmpt
   (WebAssembly) in an AudioWorklet, via chiptune3 — vendored in lib/chiptune3-0.8.9
   (MIT; libopenmpt BSD). A module is a few KB to a few hundred KB, so tracks load fast.
   Output: worklet → player gain → master gain (volume) → analyser (spectrum) → speakers. */
const PLAYER_LIB = 'lib/chiptune3-0.8.9/chiptune3.js';
let ac, master, analyser, scopeAnalyser, player = null, playerReady = null, loading = false, muted = false;
let posSec = 0, loadedSrc = null, endHandled = false, playToken = 0;
const modules = new Map(); /* src → Promise<ArrayBuffer> */

let idx = 0, cur = null, state = 'stop', shuffle = false, repeatMode = 'off', dragging = false; /* repeatMode: off | all | one */
const repeatCount = () => repeatMode === 'one' ? -1 : 0; /* libopenmpt: -1 loops forever, 0 plays once */

function getModule(t) {
  if (t.data) return Promise.resolve(t.data);              /* My tracks: the module is stored with the track */
  if (!modules.has(t.src)) {
    const p = fetch(t.src).then(r => { if (!r.ok) throw new Error(r.status + ' ' + t.src); return r.arrayBuffer(); });
    p.catch(() => modules.delete(t.src));
    modules.set(t.src, p);
  }
  return modules.get(t.src);
}

/* Must first run inside a user gesture: creates and unlocks the AudioContext. */
function initAudio() {
  if (playerReady) return playerReady;
  /* iOS 17+: play like a music app, ignoring the ring/silent switch */
  if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch (e) {} }
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain();
  analyser = ac.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = .75;
  master.connect(analyser);
  analyser.connect(ac.destination);
  /* Scope mode: a longer window (~21 ms) than the 256-point spectrum analyser */
  scopeAnalyser = ac.createAnalyser();
  scopeAnalyser.fftSize = 1024;
  master.connect(scopeAnalyser);
  applyVolume();
  playerReady = import('./' + PLAYER_LIB).then(({ ChiptuneJsPlayer }) => new Promise((resolve, reject) => {
    if (!ac.audioWorklet) { reject(new Error('AudioWorklet not supported')); return; }
    const p = new ChiptuneJsPlayer({ context: ac, repeatCount: repeatCount() });
    const timer = setTimeout(() => reject(new Error('Player did not initialise')), 20000);
    p.onInitialized(() => { clearTimeout(timer); p.gain.connect(master); player = p; resolve(p); });
    p.onProgress(d => {
      /* when looping (Repeat one) libopenmpt keeps counting past the end: wrap for display */
      posSec = cur && cur.dur > 0 && d.pos > cur.dur ? d.pos % cur.dur : d.pos;
      if (loading && state === 'play') setLoading(false);
    });
    p.onMetadata(m => {
      if (!cur || !(m && m.dur > 0)) return;
      cur.dur = m.dur;
      const du = document.querySelector(`.row[data-i="${cur.i}"] .du`);
      if (du) du.textContent = mmss(cur.dur);
      if (!dragging) paintTime(position());
    });
    /* the worklet keeps reporting 'end' until the module is replaced: act once per track */
    p.onEnded(() => {
      if (endHandled) return;
      endHandled = true;
      if (state === 'play') next(true);
    });
    p.onError(e => {
      console.error('Keygen FM: player error', e);
      if (state === 'play') { state = 'stop'; loading = false; refresh(); }
    });
  }));
  playerReady.catch(err => {
    console.error('Keygen FM: could not start the player', err);
    playerReady = null;
    state = 'stop'; loading = false; refresh();
  });
  return playerReady;
}

const position = () => posSec;

function setLoading(on) { if (loading !== on) { loading = on; refresh(); } }

function startAt(pos) {
  if (!cur) return;
  const my = ++playToken, t = cur;
  state = 'play'; loading = true; refresh();
  const ready = initAudio();
  if (ac.state !== 'running') ac.resume(); /* iOS: 'suspended' or 'interrupted' */
  Promise.all([ready, getModule(t)]).then(([p, buf]) => {
    if (my !== playToken || state !== 'play') return;
    if (loadedSrc !== t.src) {
      endHandled = false;
      p.setRepeatCount(repeatCount());
      p.play(buf);            /* copies the module into the worklet and starts it */
      loadedSrc = t.src;
      if (pos > .05) p.setPos(pos);
    } else {
      if (Math.abs(pos - posSec) > .05) p.setPos(pos);
      p.unpause();
    }
  }).catch(err => {
    if (my !== playToken) return;
    console.error('Keygen FM: could not play track', err);
    state = 'stop'; loading = false; refresh();
  });
}
function unloadModule() {
  playToken++;
  if (player) player.stop();
  loadedSrc = null; posSec = 0;
}
function load(i, autoplay) {
  state = 'stop'; loading = false;
  unloadModule();
  idx = i; cur = tracks[i];
  renderNow(); updateRows(); updateMedia(); prefetchNext();
  if (autoplay) startAt(0); else refresh();
}
function toggle() {
  if (!cur) return;
  if (state === 'play') {
    playToken++;
    state = 'pause'; loading = false;
    if (player) player.pause();
    refresh();
  } else startAt(state === 'pause' ? posSec : 0);
}
function stop() { state = 'stop'; loading = false; unloadModule(); refresh(); }
/* the track after / before the current one in the order the current view plays
   (in Favourites the current track may not be liked: then the nearest favourite in playlist order) */
function stepIndex(dir) {
  const order = playOrder(), at = order.indexOf(idx);
  if (at !== -1) return { i: order[(at + dir + order.length) % order.length], wrapped: dir > 0 ? at + 1 >= order.length : at === 0 };
  const after = order.find(i => i > idx), before = [...order].reverse().find(i => i < idx);
  if (dir > 0) return after !== undefined ? { i: after, wrapped: false } : { i: order[0], wrapped: true };
  return before !== undefined ? { i: before, wrapped: false } : { i: order[order.length - 1], wrapped: true };
}
function next(auto) {
  if (!cur) return;
  const order = playOrder();
  if (shuffle && order.length > 1) {
    let n; do n = order[Math.floor(Math.random() * order.length)]; while (n === idx);
    load(n, auto || state === 'play'); return;
  }
  const s = stepIndex(1);
  /* end of the list: auto-advance stops unless Repeat all; manual Next always wraps */
  if (s.wrapped && auto && repeatMode !== 'all') { stop(); return; }
  load(s.i, auto || state === 'play');
}
function prev() {
  if (!cur) return;
  if (position() > 3) { seekTo(0); return; }
  load(stepIndex(-1).i, state === 'play');
}
function seekTo(pos) {
  if (!cur) return;
  pos = Math.max(0, Math.min(cur.dur - .05, pos));
  posSec = pos;
  if (player && loadedSrc === cur.src) player.setPos(pos);
  if (state === 'stop') { state = 'pause'; refresh(); }
}

/* Modules are tiny: fetch the next one ahead of time. */
function prefetchNext() {
  if (tracks.length < 2) return;
  getModule(tracks[stepIndex(1).i]).catch(() => {});
}
/* Warm the HTTP cache with the player library while the page is idle, so the first
   Play does not wait for ~1.5 MB of WebAssembly. */
function prefetchPlayer() {
  const base = PLAYER_LIB.replace(/[^/]+$/, '');
  [PLAYER_LIB, base + 'chiptune3.worklet.js', base + 'libopenmpt.worklet.js'].forEach(href => {
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = href;
    document.head.appendChild(l);
  });
}

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
  /* tracker readout in the title bar: track number, channels, tempo; the format only when
     the playlist mixes formats (all XM today, so it would say nothing) */
  const mixed = new Set(tracks.map(t => t.fmt)).size > 1;
  $('readout').textContent = [`${pad(idx + 1)}/${pad(tracks.length)}`, mixed && cur.fmt, cur.ch && `${cur.ch} CH`, cur.bpm && `${cur.bpm} BPM`].filter(Boolean).join(' · ');
  document.title = `${cur.title} · Keygen FM`;
  paintLike();
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

/* ---------- My tracks ----------
   Modules saved by the 8-bit converter, kept in this browser (IndexedDB, database "kgfm", store
   "tracks"). They join the playlist after the tracks from tracks.json, with src "mine:<id>". */
let baseTracks = [], idbPromise = null;
function idb() {
  if (!idbPromise) idbPromise = new Promise((res, rej) => {
    if (!('indexedDB' in window)) { rej(new Error('IndexedDB unavailable')); return; }
    const r = indexedDB.open('kgfm', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tracks', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  idbPromise.catch(() => { idbPromise = null; });
  return idbPromise;
}
const idbReq = (mode, fn) => idb().then(db => new Promise((res, rej) => {
  const tx = db.transaction('tracks', mode), q = fn(tx.objectStore('tracks'));
  tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
}));
const idbAll = () => idbReq('readonly', st => st.getAll());
const idbPut = rec => idbReq('readwrite', st => st.put(rec));
const idbDel = id => idbReq('readwrite', st => st.delete(id));
function buildTracks(mine) {
  const own = mine.slice().sort((a, b) => a.created - b.created).map(m => ({ ...m, src: 'mine:' + m.id, fmt: 'XM', mine: true }));
  tracks = baseTracks.concat(own).map((d, i) => ({ i, fmt: (d.src.split('.').pop() || '').toUpperCase(), ...d }));
}
/* reload My tracks and keep playing what was playing (indices may shift) */
async function refreshMine() {
  const curSrc = cur && cur.src;
  buildTracks(await idbAll());
  const at = tracks.findIndex(t => t.src === curSrc);
  if (at >= 0) { idx = at; cur = tracks[at]; renderNow(); }
  else if (tracks.length) load(0, false);
  renderList(); prefetchNext();
}
/* the converter hands over a finished XM: { meta: { title, group, release, kind, ch, dur }, data, done } */
document.addEventListener('kgfm:add-track', async e => {
  const { meta, data, done } = e.detail;
  const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(), ...meta, data };
  try { await idbPut(rec); await refreshMine(); if (done) done(true); }
  catch (err) { console.error('Keygen FM: could not save to My tracks', err); if (done) done(false, err); }
});
async function removeMine(t) {
  if (!t || !t.mine || !confirm(`Remove “${t.title}” from Added? This cannot be undone.`)) return;
  if (cur && cur.src === t.src) stop();
  favs.delete(t.src); try { localStorage.setItem('kgfm-favs', JSON.stringify([...favs])); } catch (e) {}
  try { await idbDel(t.id); await refreshMine(); } catch (err) { console.error('Keygen FM: could not remove the track', err); }
}

/* ---------- Playlist ----------
   Three views: All (playlist order), Favourites (liked tracks) and Added (modules saved from the
   8-bit converter, kept in this browser). Next/Previous follow the current view. */
let view = 'all', query = '';
try { const v = localStorage.getItem('kgfm-view'); if (v === 'fav' || v === 'mine') view = v; } catch (e) {}

/* favourites, kept per viewer by track file */
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem('kgfm-favs') || '[]')); } catch (e) {}
const isFav = t => favs.has(t.src);
function toggleFav(t) {
  if (!t) return;
  if (favs.has(t.src)) favs.delete(t.src); else favs.add(t.src);
  try { localStorage.setItem('kgfm-favs', JSON.stringify([...favs])); } catch (e) {}
  renderList(); paintLike(); prefetchNext();
}

/* pixel heart on a 7 × 6 grid (square, like the rest of the UI): outline = not liked, filled = liked */
const HEART = {
  on:  ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'],
  off: ['.XX.XX.', 'X..X..X', 'X.....X', '.X...X.', '..X.X..', '...X...']
};
const heart = on => `<svg width="14" height="12" viewBox="0 0 7 6" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${
  HEART[on ? 'on' : 'off'].flatMap((row, y) => [...row].map((p, x) => p === 'X' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : '')).join('')}</svg>`;

/* track indices in the order the current view plays them (ignoring search) */
function playOrder() {
  if (view === 'fav') { const f = tracks.filter(isFav).map(t => t.i); if (f.length) return f; }
  if (view === 'mine') { const m = tracks.filter(t => t.mine).map(t => t.i); if (m.length) return m; }
  return tracks.map(t => t.i);
}

function renderSeg() {
  $('seg').innerHTML = [['all', 'All'], ['fav', 'Favourites'], ['mine', 'Added']]
    .map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === view}">${l}</button>`).join('');
}
const DEL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
/* in Added the row's button removes the track (the card's heart still likes it) */
const rowHtml = t => `<li class="item"><button class="row" data-i="${t.i}" aria-current="${t.i === idx}"><span class="lead"></span><span class="txt"><span class="t">${esc(t.title)}</span><span class="g">${esc(t.group)}</span></span><span class="du">${mmss(t.dur)}</span></button>${view === 'mine' && t.mine
  ? `<button class="fav del" data-del="${t.i}" aria-label="Remove ${esc(t.title)} from Added">${DEL_ICON}</button>`
  : `<button class="fav" data-fav="${t.i}" aria-pressed="${isFav(t)}" aria-label="${isFav(t) ? 'Remove' : 'Add'} ${esc(t.title)} ${isFav(t) ? 'from' : 'to'} favourites">${heart(isFav(t))}</button>`}</li>`;
function renderList() {
  const base = view === 'fav' ? tracks.filter(isFav) : view === 'mine' ? tracks.filter(t => t.mine) : tracks;
  const vis = base.filter(t => !query || (t.title + ' ' + t.group + ' ' + t.release).toLowerCase().includes(query));
  const tot = vis.reduce((a, t) => a + t.dur, 0);
  /* total length: "6 min 31 s" under an hour, "3 h 19 min" above */
  const len = tot >= 3600 ? `${Math.floor(tot / 3600)} h ${Math.floor(tot % 3600 / 60)} min` : `${Math.floor(tot / 60)} min ${Math.round(tot % 60)} s`;
  $('sum').textContent = `${vis.length} ${vis.length === 1 ? 'track' : 'tracks'}, ${len}`;
  if (view === 'mine' && !base.length) {
    $('list').innerHTML = `<li class="empty">Nothing added yet. Convert a MIDI file in the 8-bit converter and choose Add to playlist. Added tracks are kept in this browser.<button id="openConv">Open the converter</button></li>`;
  } else if (view === 'fav' && !base.length) {
    $('list').innerHTML = `<li class="empty">No favourites yet. Use the heart on a track to keep it here.<button id="showAll">Show all tracks</button></li>`;
  } else if (!vis.length) {
    $('list').innerHTML = `<li class="empty">No tracks match “${esc(query)}”. Try a group name or a program, like Photoshop.<button id="clearQ">Clear search</button></li>`;
  } else {
    $('list').innerHTML = vis.map(rowHtml).join('');
  }
  updateRows(); fitList();
}
function paintLike() {
  const b = $('likeBtn'); if (!cur) return;
  const on = isFav(cur), l = on ? 'Remove from favourites' : 'Add to favourites';
  b.innerHTML = heart(on);
  b.setAttribute('aria-pressed', on);
  b.setAttribute('aria-label', l);
  setTip(b, l + ' (L)');
}
function setView(v) {
  view = v;
  $('seg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === v));
  try { localStorage.setItem('kgfm-view', view); } catch (e) {}
  renderList(); prefetchNext();
}
/* width of the list's own scrollbar (0 for overlay scrollbars and on mobile, where the page scrolls) */
function fitList() { const l = $('list'); l.style.setProperty('--sbw', (l.offsetWidth - l.clientWidth) + 'px'); }
new ResizeObserver(fitList).observe($('list'));
function updateRows() {
  document.querySelectorAll('.row').forEach(r => {
    const i = +r.dataset.i, on = i === idx;
    r.setAttribute('aria-current', on);
    r.querySelector('.lead').innerHTML = on
      ? `<span class="eq${state === 'play' && !loading ? ' on' : ''}" role="img" aria-label="${state === 'play' ? 'Playing' : 'Selected'}"><i></i><i></i><i></i></span>`
      : pad(i + 1);
  });
}

$('seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
$('likeBtn').onclick = () => toggleFav(cur);
$('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });
$('list').addEventListener('click', e => {
  if (e.target.id === 'clearQ') { $('q').value = ''; query = ''; renderList(); $('q').focus(); return; }
  if (e.target.id === 'showAll') { setView('all'); return; }
  if (e.target.id === 'openConv') { $('convBtn').click(); return; }
  const del = e.target.closest('.del');
  if (del) { removeMine(tracks[+del.dataset.del]); return; }
  const f = e.target.closest('.fav');
  if (f) { toggleFav(tracks[+f.dataset.fav]); const again = document.querySelector(`.fav[data-fav="${f.dataset.fav}"]`); if (again) again.focus(); return; }
  const r = e.target.closest('.row'); if (!r) return;
  load(+r.dataset.i, true); /* no auto-scroll to the player: the list stays where the user is */
});

/* the 8-bit converter pauses the player while it previews */
document.addEventListener('kgfm:pause-player', () => { if (state === 'play') toggle(); });

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
  if (player) player.setRepeatCount(repeatCount());
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
  if (!cur || e.metaKey || e.ctrlKey || e.altKey || e.target.matches('input[type="search"]') || document.querySelector('dialog[open]')) return; /* no player shortcuts while a dialog is open */
  const k = e.key.toLowerCase();
  if (k === ' ' && !e.target.matches('button,input')) { e.preventDefault(); toggle(); }
  else if (k === 'z') prev();
  else if (k === 'b') next(false);
  else if (k === 'x' && state !== 'play') toggle();
  else if (k === 'c' && state === 'play') toggle();
  else if (k === 'm') { muted = !muted; applyVolume(); }
  else if (k === 'v') nextVis();
  else if (k === 'l') toggleFav(cur);
  else if (k === 'f') setFs(!np.classList.contains('is-fs'));
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
const freq = new Uint8Array(128);
const cssVar = name => getComputedStyle(rootEl).getPropertyValue(name).trim();
const ACC = cssVar('--color-accent-screen') || '#34E08A';
const ACC_HI = cssVar('--color-accent-screen-hi') || '#A6F7CF';
const SCREEN = cssVar('--screen-black') || '#08090B';

function sizeStage() {
  const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  /* leaving native full screen, the card is briefly out of layout (0 × 0); never keep that size,
     measure again next frame instead (no further resize event comes once it is back to its old size) */
  if (!r.width || !r.height) { requestAnimationFrame(sizeStage); return; }
  SW = r.width; SH = r.height;
  cv.width = Math.round(SW * dpr); cv.height = Math.round(SH * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
/* Band levels and peaks, 0…1 of the display height. */
const BANDS = 20, lvl = new Float32Array(BANDS), pk = new Float32Array(BANDS);
function updateLevels(dt) {
  const playing = state === 'play' && !loading, still = reduce.matches;
  if (playing && analyser) analyser.getByteFrequencyData(freq); else freq.fill(0);
  for (let b = 0; b < BANDS; b++) {
    const bin = 1 + Math.floor(Math.pow(b / BANDS, 1.5) * 95);
    const v = Math.min(1, freq[bin] / 235);
    lvl[b] = Math.max(v, lvl[b] - dt * (still ? 3 : 2.2));
    pk[b] = still ? 0 : (lvl[b] >= pk[b] ? lvl[b] : Math.max(0, pk[b] - dt * .6));
  }
}
/* ---------- Visualizer modes ----------
   All modes share the LCD look: screen black, 2 px segments on a 4 px pitch, green gradient,
   glow (off with reduced motion). Switch with the title bar button, a click on the display or V. */
const VIS = [ /* first = default; Mirror and Spectrum are hidden for now (drawMirror/drawSpectrum kept) */
  { id: 'scope', name: 'Scope' },
  { id: 'ring', name: 'Ring' },
  { id: 'pulsar', name: 'Pulsar' },
  { id: 'waterfall', name: 'Waterfall' }
];
let visIdx = 0;
try { const v = VIS.findIndex(m => m.id === localStorage.getItem('kgfm-vis')); if (v >= 0) visIdx = v; } catch (e) {}
const wave = new Uint8Array(1024).fill(128);
let scopeGain = 1; /* auto gain: the trace fills the display at any volume */
let fall = [], fallRows = 0, fallCols = 0, fallT = 0;

function drawStage(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (!SW || (np.classList.contains('min') && !np.classList.contains('is-fs'))) return; /* nothing to draw while minimized */
  updateLevels(dt);
  const still = reduce.matches;
  g.globalAlpha = 1; g.shadowBlur = 0; g.fillStyle = SCREEN; g.fillRect(0, 0, SW, SH);
  const mode = VIS[visIdx].id;
  if (mode === 'spectrum') drawSpectrum(still);
  else if (mode === 'mirror') drawMirror(still);
  else if (mode === 'scope') drawScope(still);
  else if (mode === 'ring') drawRing(still, dt);
  else if (mode === 'pulsar') drawPulsar(still, dt);
  else if (mode === 'waterfall') drawWaterfall(dt);
  g.globalAlpha = 1; g.shadowBlur = 0;
}

/* shared grid: 18 px padding, 2 px segments, 2 px gaps */
const PAD = 18, SEG = 2, SGAP = 2, PITCH = SEG + SGAP;
function columns() {
  const n = BANDS, colGap = Math.max(6, (SW - PAD * 2) / n * .38);
  return { n, colGap, bw: (SW - PAD * 2 - colGap * (n - 1)) / n };
}
function lcdGradient(y0, y1) { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, ACC); gr.addColorStop(1, ACC_HI); return gr; }

/* 1. Spectrum: bars rising from the bottom with peak markers */
function drawSpectrum(still) {
  const { n, colGap, bw } = columns();
  const rows = Math.floor((SH - PAD * 2 + SGAP) / PITCH);
  const base = SH - PAD, top = base - rows * PITCH + SGAP;
  g.fillStyle = ACC; g.globalAlpha = .1;
  for (let b = 0; b < n; b++) g.fillRect(PAD + b * (bw + colGap), top, bw, base - top);
  g.globalAlpha = 1; g.fillStyle = lcdGradient(base, top); g.shadowColor = ACC; g.shadowBlur = still ? 0 : 12;
  for (let b = 0; b < n; b++) {
    const lit = Math.round(lvl[b] * rows);
    if (lit > 0) g.fillRect(PAD + b * (bw + colGap), base - lit * PITCH + SGAP, bw, lit * PITCH - SGAP);
  }
  g.shadowBlur = 0; g.fillStyle = ACC_HI;
  for (let b = 0; b < n; b++) {
    const p = Math.round(pk[b] * rows);
    if (p > Math.round(lvl[b] * rows) && p <= rows) g.fillRect(PAD + b * (bw + colGap), base - p * PITCH + SGAP, bw, SEG);
  }
  g.fillStyle = SCREEN;
  for (let r = 0; r < rows; r++) g.fillRect(0, base - (r + 1) * PITCH, SW, SGAP);
}

/* 2. Mirror: the same bars growing up and down from a centre line */
function drawMirror(still) {
  const { n, colGap, bw } = columns();
  const half = Math.floor((SH / 2 - PAD + SGAP) / PITCH), mid = Math.round(SH / 2);
  const seg = (x, r, up) => g.fillRect(x, up ? mid - (r + 1) * PITCH + SGAP / 2 : mid + r * PITCH + SGAP / 2, bw, SEG);
  g.fillStyle = ACC; g.globalAlpha = .1;
  for (let b = 0; b < n; b++) { const x = PAD + b * (bw + colGap); for (let r = 0; r < half; r++) { seg(x, r, true); seg(x, r, false); } }
  g.globalAlpha = 1; g.shadowColor = ACC; g.shadowBlur = still ? 0 : 10;
  g.fillStyle = lcdGradient(mid, mid - half * PITCH);
  for (let b = 0; b < n; b++) { const x = PAD + b * (bw + colGap), lit = Math.round(lvl[b] * half); for (let r = 0; r < lit; r++) seg(x, r, true); }
  g.fillStyle = lcdGradient(mid, mid + half * PITCH);
  for (let b = 0; b < n; b++) { const x = PAD + b * (bw + colGap), lit = Math.round(lvl[b] * half); for (let r = 0; r < lit; r++) seg(x, r, false); }
  g.shadowBlur = 0; g.fillStyle = ACC_HI;
  for (let b = 0; b < n; b++) {
    const x = PAD + b * (bw + colGap), p = Math.round(pk[b] * half);
    if (p > Math.round(lvl[b] * half) && p <= half) { seg(x, p - 1, true); seg(x, p - 1, false); }
  }
}

/* 3. Scope: an oscilloscope on the LCD grid.
   - trigger: the trace starts at a rising zero crossing, so it stands still
   - each column spans the min…max of its samples (fast detail survives), joined to its neighbour
   - graticule: brighter lines every 10 cells and a centre axis
   - phosphor: the two previous traces fade behind the current one (off with reduced motion) */
const scopeTrail = [];
let scopeEase = new Float32Array(0);
/* shared by Scope and Ring: read the waveform, update auto gain, return the trigger index */
const wv = new Float32Array(1024);   /* smoothed waveform, −1…1, shared by Scope and Ring */
const trigRef = new Float32Array(64); /* previous window, sampled, for a stable trigger */
let trigPrev = 0;
function readWave() {
  const playing = state === 'play' && !loading;
  if (playing && scopeAnalyser) scopeAnalyser.getByteTimeDomainData(wave); else wave.fill(128);
  let sum = 0, peak = 0;
  for (let i = 0; i < wave.length; i++) {
    /* light 3-tap smoothing: tames noise-channel spikes, keeps the shape */
    const d = ((wave[Math.max(0, i - 1)] + 2 * wave[i] + wave[Math.min(wave.length - 1, i + 1)]) / 4 - 128) / 128;
    wv[i] = d; sum += d * d; peak = Math.max(peak, Math.abs(d));
  }
  const rms = Math.sqrt(sum / wave.length);
  /* auto gain: peaks reach ~85 % of the half height, capped by RMS so sparse spikes cannot squash the trace */
  const target = rms > .002 ? Math.min(40, .85 / peak, .5 / rms) : scopeGain;
  scopeGain += (target - scopeGain) * (target < scopeGain ? .3 : .05); /* fast attack, slow release */

  /* trigger: rising crossings with hysteresis (arm below −h, fire at 0) in the first half; of up to
     8 candidates take the one whose window best matches the previous frame, so the trace stands still */
  const half = wave.length >> 1, span = half, h = Math.max(.01, rms * .35);
  const cands = [];
  let armed = false;
  for (let i = 1; i < half && cands.length < 8; i++) {
    if (wv[i] < -h) armed = true;
    else if (armed && wv[i - 1] < 0 && wv[i] >= 0) { cands.push(i); armed = false; }
  }
  let t0 = cands.length ? cands[0] : Math.min(trigPrev, half - 1);
  if (cands.length > 1) {
    let best = Infinity;
    for (const c of cands) {
      let e = 0;
      for (let k = 0; k < 64; k++) e += Math.abs(wv[c + Math.floor(k * span / 64)] - trigRef[k]);
      if (e < best) { best = e; t0 = c; }
    }
  }
  for (let k = 0; k < 64; k++) trigRef[k] = wv[t0 + Math.floor(k * span / 64)];
  trigPrev = t0;
  return t0;
}
function drawScope(still) {
  const t0 = readWave();
  /* same LCD cell size as every other mode, also in full screen */
  const sc = 1, P = PITCH * sc, Z = SEG * sc;
  const cols = Math.floor((SW - PAD * 2 + SGAP * sc) / P), rows = Math.floor((SH - PAD * 2 + SGAP * sc) / P);
  const midRow = Math.floor(rows / 2), halfRows = Math.min(midRow, rows - 1 - midRow);
  const ox = Math.round((SW - (cols * P - SGAP * sc)) / 2), oy = Math.round((SH - (rows * P - SGAP * sc)) / 2);
  const cell = (c, r) => g.fillRect(ox + c * P, oy + r * P, Z, Z);

  /* graticule */
  g.fillStyle = ACC;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const major = r === midRow || c % 10 === 0 || (r - midRow) % 10 === 0;
    g.globalAlpha = r === midRow ? .22 : major ? .12 : .05;
    cell(c, r);
  }

  const span = wave.length >> 1;

  /* trace: per column the mean of its samples, eased over time (each column moves part of the way
     to its new value every frame), joined into one continuous line */
  if (scopeEase.length !== cols) scopeEase = new Float32Array(cols);
  const ease = still ? 1 : .45;
  const toRow = v => Math.max(0, Math.min(rows - 1, Math.round(midRow - Math.max(-1, Math.min(1, v * scopeGain)) * halfRows)));
  const trace = new Array(cols);
  const means = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = t0 + Math.floor(c / cols * span), b = Math.max(a + 1, t0 + Math.floor((c + 1) / cols * span));
    let m = 0; for (let i = a; i < b; i++) m += wv[i]; means[c] = m / (b - a);
  }
  /* the window holds only part of a bass cycle, always its rising half (the trigger fires on a
     rising crossing), so the trace leaned to the right and floated above the axis. Like a scope's
     AC coupling, remove that slow part: the line through the mean of the first and last 10 % of the
     window (tilt), then the window's mean (offset). */
  const edge = Math.max(1, Math.round(cols * .1));
  let head = 0, tail = 0, total = 0;
  for (let c = 0; c < edge; c++) { head += means[c]; tail += means[cols - 1 - c]; }
  const tilt = (tail - head) / edge;
  for (let c = 0; c < cols; c++) { means[c] -= tilt * ((c - (edge - 1) / 2) / (cols - edge) - .5); total += means[c]; }
  const level = total / cols;
  let prev = midRow;
  for (let c = 0; c < cols; c++) {
    const m = means[c] - level;
    scopeEase[c] += (m - scopeEase[c]) * ease;
    const r = toRow(scopeEase[c]);
    trace[c] = c ? [Math.min(prev, r), Math.max(prev, r)] : [r, r]; /* join to the previous column */
    prev = r;
  }

  /* phosphor persistence: one faint previous frame */
  if (!still) {
    scopeTrail.unshift(trace);
    if (scopeTrail.length > 2) scopeTrail.length = 2;
    g.fillStyle = ACC;
    [.18].forEach((alpha, k) => {
      const old = scopeTrail[k + 1]; if (!old || old.length !== cols) return;
      g.globalAlpha = alpha;
      for (let c = 0; c < cols; c++) for (let r = old[c][0]; r <= old[c][1]; r++) cell(c, r);
    });
  } else scopeTrail.length = 0;

  /* current trace: brighter towards the extremes, with glow */
  const grad = g.createLinearGradient(0, oy, 0, oy + rows * P);
  grad.addColorStop(0, ACC_HI); grad.addColorStop(.5, ACC); grad.addColorStop(1, ACC_HI);
  g.globalAlpha = 1; g.fillStyle = grad; g.shadowColor = ACC; g.shadowBlur = still ? 0 : 8;
  for (let c = 0; c < cols; c++) for (let r = trace[c][0]; r <= trace[c][1]; r++) cell(c, r);
  g.shadowBlur = 0;
}

/* 4. Ring: the triggered waveform wrapped around a circle; the radius follows the signal.
   - whole periods: the window runs from one rising zero crossing to another, ends cross-faded,
     so the ring closes without a seam
   - polar graticule: base ring, outer ring and axes on the LCD grid
   - one turn per 4 bars at the track's BPM, and a bass "breath" in the base radius
     (both follow the music, both off with reduced motion)
   - phosphor trail of the two previous rings */
const ringTrail = [];
let ringAngle = 0, ringBreath = 0;
function drawRing(still, dt) {
  const t0 = readWave();
  const playing = state === 'play' && !loading;
  const cols = Math.floor((SW - PAD * 2 + SGAP) / PITCH), rows = Math.floor((SH - PAD * 2 + SGAP) / PITCH);
  const cc = (cols - 1) / 2, cr = (rows - 1) / 2;
  const maxR = Math.min(cr, cc) - .5;
  const cell = (c, r) => g.fillRect(PAD + c * PITCH, PAD + r * PITCH, SEG, SEG);
  const ring = (rad, n) => { for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; cell(Math.round(cc + Math.cos(a) * rad), Math.round(cr + Math.sin(a) * rad)); } };

  /* motion from the music */
  const bass = (lvl[0] + lvl[1] + lvl[2]) / 3;
  ringBreath += ((still ? 0 : bass) - ringBreath) * .25;
  if (playing && !still && cur && cur.bpm) ringAngle += dt * (cur.bpm / 60) / 16 * Math.PI * 2; /* 16 beats per turn */
  const baseR = maxR * (.52 + .08 * ringBreath), amp = maxR - baseR;

  /* polar graticule */
  g.fillStyle = ACC;
  g.globalAlpha = .04; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cell(c, r);
  g.globalAlpha = .1;
  for (let c = Math.round(cc - maxR); c <= Math.round(cc + maxR); c++) cell(c, Math.round(cr));
  for (let r = Math.round(cr - maxR); r <= Math.round(cr + maxR); r++) cell(Math.round(cc), r);
  ring(maxR, 200);
  g.globalAlpha = .22; ring(baseR, 160);

  /* window of whole periods: t0 → the rising crossing closest to t0 + span */
  const span = wave.length >> 1;
  let t1 = t0 + span;
  for (let d = 0; d < span * .4; d++) {
    const a = t0 + span + d, b = t0 + span - d;
    if (a < wave.length && wv[a - 1] < 0 && wv[a] >= 0) { t1 = a; break; }
    if (b > t0 + 8 && wv[b - 1] < 0 && wv[b] >= 0) { t1 = b; break; }
  }
  t1 = Math.min(t1, wave.length - 1);
  const len = t1 - t0, fade = Math.floor(len * .08);
  const sample = i => { /* cross-fade the last 8 % into the first samples */
    let v = wv[t0 + i];
    if (i > len - fade) { const w = (i - (len - fade)) / fade; v = v * (1 - w) + wv[t0 + i - len + fade] * w; }
    return Math.max(-1, Math.min(1, v * scopeGain));
  };

  /* the curve as grid cells, consecutive points joined so the ring stays closed */
  const N = 260, pts = new Set();
  const at = k => {
    const a = k / N * Math.PI * 2 - Math.PI / 2 + ringAngle, rad = baseR + sample(Math.floor(k / N * len)) * amp;
    return [Math.round(cc + Math.cos(a) * rad), Math.round(cr + Math.sin(a) * rad)];
  };
  let [pc, pr] = at(0);
  for (let k = 1; k <= N; k++) {
    const [c, r] = at(k % N), steps = Math.max(Math.abs(c - pc), Math.abs(r - pr), 1);
    for (let s = 0; s <= steps; s++) pts.add(Math.round(pc + (c - pc) * s / steps) * 1000 + Math.round(pr + (r - pr) * s / steps));
    pc = c; pr = r;
  }
  const cells = [...pts];

  if (!still) {                                      /* phosphor persistence */
    ringTrail.unshift(cells);
    if (ringTrail.length > 3) ringTrail.length = 3;
    [.28, .12].forEach((alpha, k) => { const old = ringTrail[k + 1]; if (!old) return; g.globalAlpha = alpha; old.forEach(p => cell(Math.floor(p / 1000), p % 1000)); });
  } else ringTrail.length = 0;

  const cx = PAD + cc * PITCH + SEG / 2, cy = PAD + cr * PITCH + SEG / 2;
  const grad = g.createRadialGradient(cx, cy, baseR * PITCH * .6, cx, cy, maxR * PITCH);
  grad.addColorStop(0, ACC); grad.addColorStop(1, ACC_HI);  /* brighter as the signal swings out */
  g.globalAlpha = 1; g.fillStyle = grad; g.shadowColor = ACC; g.shadowBlur = still ? 0 : 8;
  cells.forEach(p => cell(Math.floor(p / 1000), p % 1000));
  g.shadowBlur = 0;
}

/* 5. Pulsar: stacked spectrum lines in the manner of the classic pulsar plot (CP 1919) —
   lows in the centre, highs at the edges, edges damped so the peaks gather in the middle.
   A new line every 70 ms enters at the bottom and the stack moves up; each nearer line hides
   what lies behind its peaks. Older lines are dimmer. LCD cells on the shared grid. */
let pulsarLines = [], pulsarCols = 0, pulsarT = 0, pulsarGain = 2;
function drawPulsar(still, dt) {
  const cols = Math.floor((SW - PAD * 2 + SGAP) / PITCH), rows = Math.floor((SH - PAD * 2 + SGAP) / PITCH);
  /* like the plot: a central column with dark margins, a dozen or two lines, peaks ~4 lines tall */
  const gap = Math.max(3, Math.round(rows / 24));
  const amp = Math.min(Math.round(rows * .36), gap * 5);
  const count = Math.min(26, Math.floor((rows - amp - 1) / gap) + 1);
  const pc = Math.min(cols, Math.round(rows * 1.9)), x0 = Math.floor((cols - pc) / 2);
  const top = rows - 1 - (count - 1) * gap;                             /* baseline of the farthest line */
  if (pc !== pulsarCols) { pulsarCols = pc; pulsarLines = []; }
  while (pulsarLines.length < count) pulsarLines.unshift(new Float32Array(pc)); /* start as flat lines */
  if (pulsarLines.length > count) pulsarLines.splice(0, pulsarLines.length - count);

  const playing = state === 'play' && !loading;
  pulsarT += dt;
  if (playing && pulsarT >= .07) {
    pulsarT = 0;
    const raw = new Float32Array(pc), line = new Float32Array(pc);
    if (scopeAnalyser) scopeAnalyser.getByteTimeDomainData(wave);
    let max = 0;
    for (let c = 0; c < pc; c++) {
      const u = c / (pc - 1), d = Math.abs(u - .5) * 2;                 /* 0 centre … 1 edge */
      const win = Math.pow(Math.cos(d * Math.PI / 2), 1.4);             /* calm, flat edges */
      /* lows in the middle, higher bands outwards; left and right take neighbouring bands, so the
         peaks gather in the centre without being a mirror image */
      const v = freq[2 + 2 * Math.floor(Math.pow(d, 1.15) * 34) + (u < .5 ? 0 : 1)] / 255;
      const peak = Math.pow(Math.max(0, (v - .2) / .8), 1.3);
      const grain = Math.abs(wave[Math.floor(u * (wave.length - 1))] - 128) / 128 * .3; /* texture from the waveform */
      raw[c] = (peak + grain) * win;
    }
    const k = Math.max(1, Math.round(pc / 110));                        /* light smoothing: keep the teeth */
    for (let c = 0; c < pc; c++) {
      let sum = 0, n = 0;
      for (let j = -k; j <= k; j++) { const x = c + j; if (x >= 0 && x < pc) { sum += raw[x]; n++; } }
      line[c] = sum / n; max = Math.max(max, line[c]);
    }
    /* auto gain: the tallest peak reaches the full height at any volume */
    const target = max > .02 ? Math.min(8, 1 / max) : pulsarGain;
    pulsarGain += (target - pulsarGain) * (target < pulsarGain ? .4 : .08);
    for (let c = 0; c < pc; c++) line[c] = Math.min(1, line[c] * pulsarGain);
    pulsarLines.push(line); pulsarLines.shift();
  }

  const cell = (c, r) => g.fillRect(PAD + c * PITCH, PAD + r * PITCH, SEG, SEG);
  g.fillStyle = ACC; g.globalAlpha = .04;                                /* dot matrix */
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cell(c, r);

  for (let i = 0; i < count; i++) {                                      /* far (top) to near (bottom) */
    const line = pulsarLines[i], base = top + i * gap;
    const alpha = .3 + .7 * (i + 1) / count;                             /* depth: older lines dimmer */
    let prev = base - Math.round(line[0] * amp);
    for (let c = 0; c < pc; c++) {
      const r = Math.max(0, base - Math.round(line[c] * amp)), x = x0 + c;
      /* occlusion: blank this column from the curve down to the baseline, hiding the lines behind */
      g.globalAlpha = 1; g.shadowBlur = 0; g.fillStyle = SCREEN;
      g.fillRect(PAD + x * PITCH - 1, PAD + r * PITCH, PITCH, (base - r + 1) * PITCH);
      g.globalAlpha = alpha; g.fillStyle = i === count - 1 ? ACC_HI : ACC;
      g.shadowColor = ACC; g.shadowBlur = still ? 0 : 6;
      const lo = Math.min(prev, r), hi = Math.max(prev, r);
      for (let k = lo; k <= hi; k++) cell(x, k);                         /* continuous trace */
      prev = r;
    }
  }
  g.shadowBlur = 0;
}

/* 6. Waterfall: a spectrogram scrolling right to left, brightness = level */
function drawWaterfall(dt) {
  const rows = Math.floor((SH - PAD * 2 + 1) / PITCH), cols = Math.floor((SW - PAD * 2 + 1) / PITCH);
  if (rows !== fallRows || cols !== fallCols) { fallRows = rows; fallCols = cols; fall = []; }
  const playing = state === 'play' && !loading;
  fallT += dt;
  if (playing && fallT >= .05) {                       /* new column every 50 ms while playing */
    fallT = 0;
    const col = new Float32Array(rows);
    /* threshold + curve so only the loud bands light up */
    for (let r = 0; r < rows; r++) col[r] = Math.pow(Math.max(0, (freq[1 + Math.floor(Math.pow(r / rows, 1.6) * 100)] / 255 + r / rows * .12 - .32) / .68), 1.3); /* + tilt: lift the quieter highs */
    fall.push(col);
    if (fall.length > cols) fall.shift();
  }
  const cellSz = PITCH - 1, x0 = PAD + (cols - fall.length) * PITCH, base = SH - PAD;
  g.fillStyle = ACC; g.globalAlpha = .07;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) g.fillRect(PAD + c * PITCH, base - (r + 1) * PITCH + 1, cellSz, cellSz);
  for (let c = 0; c < fall.length; c++) {
    const col = fall[c], x = x0 + c * PITCH;
    for (let r = 0; r < rows; r++) {
      const v = col[r];
      if (v < .04) continue;
      g.globalAlpha = Math.min(1, .15 + v * .85);
      g.fillStyle = v > .7 ? ACC_HI : ACC;
      g.fillRect(x, base - (r + 1) * PITCH + 1, cellSz, cellSz);
    }
  }
}

/* switching */
let labelTimer = null;
function setVis(i, announce) {
  visIdx = (i + VIS.length) % VIS.length;
  const m = VIS[visIdx], b = $('visBtn');
  b.setAttribute('aria-label', `Visualizer: ${m.name}`);
  setTip(b, 'Change visualizer (V)');
  try { localStorage.setItem('kgfm-vis', m.id); } catch (e) {}
  if (!announce) return;
  const l = $('visLabel');
  l.textContent = `${pad(visIdx + 1)} ${m.name}`;
  l.classList.add('on');
  clearTimeout(labelTimer); labelTimer = setTimeout(() => l.classList.remove('on'), 1400);
}
const nextVis = () => { if (!np.classList.contains('min') || np.classList.contains('is-fs')) setVis(visIdx + 1, true); };
$('visBtn').onclick = nextVis;
document.querySelector('.screen').addEventListener('click', nextVis);
new ResizeObserver(sizeStage).observe(cv);

function loop(now) {
  requestAnimationFrame(loop); /* schedule first: an error in one frame must not stop the display */
  try {
    if (cur && !dragging) paintTime(position());
    drawStage(now);
  } catch (e) { console.error('Keygen FM: frame error', e); }
}

/* ---------- Theme and sidebar ---------- */
/* dark is the default theme (set in <head>); the toggle switches and remembers the choice */
const isDark = () => rootEl.dataset.theme !== 'light';
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

function setSide(open) {
  app.classList.toggle('collapsed', !open);
  const b = $('sideBtn'), l = open ? 'Collapse playlist' : 'Expand playlist';
  b.setAttribute('aria-expanded', open);
  b.setAttribute('aria-label', l);
  setTip(b, l + ' ([)');
  try { localStorage.setItem('kgfm-side', open ? 'open' : 'closed'); } catch (e) {}
}
$('sideBtn').onclick = () => setSide(app.classList.contains('collapsed'));

/* Minimize player: the visualizer collapses under the title bar (200 ms, instant with reduced motion);
   title, seek bar and controls stay */
const np = document.querySelector('.np');
function setMin(min) {
  np.classList.toggle('min', min);
  const b = $('minBtn'), l = min ? 'Restore player' : 'Minimize player';
  b.innerHTML = min ? IC.restore : IC.minimize;
  b.setAttribute('aria-expanded', !min);
  b.setAttribute('aria-label', l);
  setTip(b, l);
  try { localStorage.setItem('kgfm-player', min ? 'min' : 'full'); } catch (e) {}
}
$('minBtn').onclick = () => setMin(!np.classList.contains('min'));

/* Full screen player: native Fullscreen API on the card, or a pinned full-window card where element
   fullscreen is unavailable (iPhone Safari). Exit with the same button, Esc or F. */
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const canNativeFs = !!(np.requestFullscreen || np.webkitRequestFullscreen);
function paintFs() {
  const on = np.classList.contains('is-fs'), b = $('fsBtn'), l = on ? 'Exit full screen' : 'Full screen';
  b.innerHTML = on ? IC.exitFullscreen : IC.fullscreen;
  b.setAttribute('aria-pressed', on);
  b.setAttribute('aria-label', l);
  setTip(b, l + ' (F)');
}
function setFs(on) {
  if (on === np.classList.contains('is-fs')) return;
  if (canNativeFs) {
    if (on) {
      const p = (np.requestFullscreen || np.webkitRequestFullscreen).call(np);
      if (p && p.catch) p.catch(() => { np.classList.add('is-fs'); paintFs(); }); /* refused: pin the card instead */
    }
    else if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { np.classList.remove('is-fs'); paintFs(); } /* leaving the pinned fallback */
  } else {
    np.classList.toggle('is-fs', on);
    document.documentElement.style.overflow = on ? 'hidden' : '';
    paintFs();
    requestAnimationFrame(() => requestAnimationFrame(sizeStage));
  }
}
const onFsChange = () => {
  np.classList.toggle('is-fs', fsElement() === np); paintFs();
  requestAnimationFrame(() => requestAnimationFrame(sizeStage)); /* re-measure once the layout has settled */
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
$('fsBtn').onclick = () => setFs(!np.classList.contains('is-fs'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !canNativeFs && np.classList.contains('is-fs')) setFs(false); });

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
$('visBtn').innerHTML = IC.visualizer;
paintFs();
setVis(visIdx, false);
try { if (localStorage.getItem('kgfm-side') === 'closed') setSide(false); } catch (e) {}
let startMin = false;
try { startMin = localStorage.getItem('kgfm-player') === 'min'; } catch (e) {}
setMin(startMin);
applyVolume();
requestAnimationFrame(loop);

Promise.all([
  fetch('tracks.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }), /* always revalidate */
  idbAll().catch(() => [])                                                                                          /* My tracks; none when storage is unavailable */
])
  .then(([data, mine]) => {
    baseTracks = data;
    buildTracks(mine);
    renderSeg(); renderList();
    /* opening in Favourites or Mine: start on one of those */
    const first = view === 'fav' ? tracks.find(isFav) : view === 'mine' ? tracks.find(t => t.mine) : null;
    load(first ? first.i : 0, false);
    (window.requestIdleCallback || (f => setTimeout(f, 1500)))(prefetchPlayer);
  })
  .catch(err => {
    console.error('Keygen FM: could not load tracks.json', err);
    $('sum').textContent = 'Playlist unavailable';
    $('list').innerHTML = '<li class="empty">The playlist could not be loaded. Open the player through a web server, not as a local file.</li>';
  });
})();
