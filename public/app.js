'use strict';
// Sift's page. Three views on the hash: #/ the queues, #/album/<id>, #/bin.
// Every change is a POST of an id and a decision name; the server does the rest.

const $ = (id) => document.getElementById(id);
const view = $('view');

const QUEUES = [
  ['ready', 'Ready', 'Exact matches: every track matches the MP3 by fingerprint and every FLAC file decodes cleanly.'],
  ['different', 'Different or unconfirmed version', "The fingerprints don't prove the FLAC is the same recording as the MP3."],
  ['lineup', "Doesn't line up", 'Fewer tracks, a noticeably different length, or an MP3 folder shared with another album.'],
  ['damaged', 'Damaged FLAC', 'Files fail flac -t, usually truncated downloads.'],
  ['look', 'Needs a look', "Something about the folders means Sift won't move it for you."],
  ['arriving', 'Arriving', 'Imported in the last few hours; checked once Soularr has finished with them.'],
];
const SHORT = { different: 'Different or unconfirmed' };
const DECISION_TEXT = {
  keep_flac: ['Keep FLAC', 'The FLAC moves into the Roon FLAC library and the MP3 goes in the bin.'],
  keep_mp3: ['Keep MP3', "The FLAC goes in the bin and Soularr won't fetch this album again."],
  refetch: ['Get a better FLAC', 'The FLAC goes in the bin and Soularr looks for another copy.'],
};

let state = null;
let csrf = null;
let album = null;            // the album on screen, with its rows
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- api -------------------------------------------------------------------

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf || '' },
    body: JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  if (r.status === 401 && path !== '/api/bin/empty') { location.href = '/'; throw new Error('signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `failed (${r.status})`), { status: r.status });
  return data;
}

async function loadState() {
  state = await api('/api/state');
  renderStatus();
  if (state.job && !state.job.done) watchJob();
}

// ---- formatting --------------------------------------------------------------

function clock(s) {
  if (s == null || isNaN(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const isNew = (i) => state.previous_check && i.first_seen > state.previous_check;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

// A promise-shaped <dialog>. With `password`, resolves to the password typed.
function ask({ title, body, ok = 'OK', password = false, danger = false, error = '' }) {
  const d = $('dialog');
  $('dtitle').textContent = title;
  $('dbody').textContent = body;
  $('dok').textContent = ok;
  $('dok').classList.toggle('danger', danger);
  $('dpassword').hidden = !password;
  $('dpassword').value = '';
  $('derror').hidden = !error;
  $('derror').textContent = error;
  d.returnValue = '';
  d.showModal();
  if (password) $('dpassword').focus();
  return new Promise((resolve) => {
    $('dcancel').onclick = () => d.close('cancel');
    d.onclose = () => resolve(d.returnValue === 'ok' ? (password ? $('dpassword').value : true) : null);
  });
}

// ---- status and jobs ---------------------------------------------------------

function renderStatus() {
  const items = state.items;
  const fresh = items.filter(isNew).length;
  const ready = items.filter((i) => i.queue === 'ready').length;
  const binBytes = state.bin.reduce((n, e) => n + e.bytes, 0);
  $('status').textContent = `Checked ${ago(state.checked)}`
    + (fresh ? ` · ${fresh} new since the check before` : '')
    + ` · ${ready} ready · ${items.length - ready} to review`;
  $('binlink').textContent = state.bin.length ? `Bin (${gb(binBytes)})` : 'Bin';
}

let polling = false;
async function watchJob() {
  if (polling) return;
  polling = true;
  const bar = $('jobbar');
  bar.hidden = false;
  $('jobspin').hidden = false;
  $('jobclose').hidden = true;
  $('joboutput').hidden = true;
  try {
    for (;;) {
      const { job } = await api('/api/job');
      if (!job) break;
      $('joblabel').textContent = job.label + (job.done ? (job.ok ? ' — done' : ' — failed') : '…');
      if (job.done) {
        $('jobspin').hidden = true;
        await loadState();
        if (job.ok) {
          setTimeout(() => { bar.hidden = true; }, 2500);
          const note = { keep_flac: 'Moved into the FLAC library. Undo is in the bin.',
            keep_mp3: 'FLAC is in the bin. Undo is in the bin.', refetch: 'FLAC is in the bin and Soularr will look again.',
            'empty-bin': 'Bin emptied.', undo: 'Undone. The album may take a few minutes to reappear, while Lidarr rescans.' }[job.kind];
          if (note) toast(note);
        } else {
          $('joboutput').textContent = job.output;
          $('joboutput').hidden = false;
          $('jobclose').hidden = false;
        }
        route();
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { polling = false; }
}
$('jobclose').onclick = () => { $('jobbar').hidden = true; };

// Stop playback and let go of the files before anything moves them.
function releaseAudio() {
  if (!playing) return;
  $('pclose').onclick();
}

async function run(path, body) {
  releaseAudio();
  try {
    await api(path, body);
    watchJob();
  } catch (e) { toast(e.message); }
}

// ---- the queues --------------------------------------------------------------

function row(i) {
  const badges = [];
  if (isNew(i)) badges.push('<span class="badge new">new</span>');
  if (i.flac) badges.push(`<span class="badge">FLAC ${esc(i.flac.fmt)} · ${i.flac.n}</span>`);
  if (i.mp3) badges.push(`<span class="badge">MP3 ${esc(i.mp3.fmt)} · ${i.mp3.n}</span>`);
  if (i.flac && i.flac.damaged) badges.push(`<span class="badge bad">${i.flac.damaged} damaged</span>`);
  return `<a class="row" href="#/album/${i.id}">
    ${i.cover ? `<img class="thumb" src="/api/cover/${i.id}" alt="" loading="lazy">` : '<span class="thumb none"></span>'}
    <span class="rtext"><span class="rtitle">${esc(i.artist)} — ${esc(i.title)}</span>
    <span class="rreason">${esc((i.reasons || [])[0] || '')}</span>
    <span class="badges">${badges.join('')}</span></span></a>`;
}

function renderList() {
  document.title = 'Sift';
  const parts = [];
  for (const [key, name, blurb] of QUEUES) {
    const items = state.items.filter((i) => i.queue === key);
    if (!items.length && key !== 'ready') continue;
    const head = `<div class="qhead"><h2>${name} <span class="count">${items.length}</span></h2>`
      + (key === 'ready' && items.length ? `<button class="primary" id="approve">Approve all ${items.length}</button>` : '')
      + '</div>';
    parts.push(`<section class="queue" id="q-${key}">${head}<p class="blurb">${blurb}</p>`
      + (items.length ? items.map(row).join('') : '<p class="empty">Nothing waiting.</p>') + '</section>');
  }
  const jump = QUEUES.map(([key, name]) => [key, name, state.items.filter((i) => i.queue === key).length])
    .filter(([key, , n]) => n || key === 'ready')
    .map(([key, name, n]) => `<a href="#/" data-jump="${key}">${esc(SHORT[key] || name)} <span class="count">${n}</span></a>`);
  view.innerHTML = `<nav class="jump">${jump.join('')}</nav>` + parts.join('');
  view.querySelectorAll('[data-jump]').forEach((l) => {
    l.onclick = (ev) => {
      ev.preventDefault();
      $(`q-${l.dataset.jump}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  const approve = $('approve');
  if (approve) {
    approve.onclick = async () => {
      const n = state.items.filter((i) => i.queue === 'ready').length;
      const ok = await ask({ title: `Approve all ${n}?`, ok: 'Approve all',
        body: 'Each FLAC moves into the Roon FLAC library and its MP3 goes in the bin. Each one can be undone from the bin.' });
      if (ok) run('/api/approve-ready', {});
    };
  }
}

// ---- an album ----------------------------------------------------------------

function buildRows(a) {
  const flac = a.flac ? a.flac.tracks : [];
  const mp3 = a.mp3 ? a.mp3.tracks : [];
  const rows = [];
  if (a.pairs && a.pairs.length) {
    const used = new Set();
    for (const p of a.pairs) {
      rows.push({ m: p.m, f: p.f, sim: p.sim, same: p.same });
      if (p.f != null) used.add(p.f);
    }
    flac.forEach((_, f) => { if (!used.has(f)) rows.push({ m: null, f }); });
  } else {
    const n = Math.max(flac.length, mp3.length);
    for (let k = 0; k < n; k++) rows.push({ m: k < mp3.length ? k : null, f: k < flac.length ? k : null });
  }
  return rows;
}

function cell(a, side, idx, rowIdx) {
  if (idx == null) return '<div class="cell empty">—</div>';
  const t = a[side].tracks[idx];
  const damaged = t.damaged
    ? `<span class="badge bad">damaged${t.decoded_s != null ? ` · decodes to ${clock(t.decoded_s)} of ${clock(t.secs)}` : ''}</span>` : '';
  return `<div class="cell"><button class="play" data-side="${side}" data-idx="${idx}" data-row="${rowIdx}" aria-label="Play">▶</button>
    <span class="ttext"><span class="ttitle">${esc(t.title || t.name)}</span>
    <span class="tmeta">${clock(t.secs)} · ${esc(t.fmt)}</span>${damaged}</span></div>`;
}

let mode = 'view';            // view | pair | order
let picked = null;           // MP3 index chosen in pair mode
let pending = null;          // FLAC order being edited

function matchCell(r, k) {
  if (r.sim == null && !r.manual) return `<div class="match ${r.m != null && r.f == null ? 'diff' : ''}">${r.m != null && r.f == null ? '≠' : ''}</div>`;
  if (r.manual) {
    return `<div class="match same manual" title="Paired by hand">✓<button class="unpair" data-unpair="${r.m}" title="Forget this pair" aria-label="Forget this pair">×</button></div>`;
  }
  return `<div class="match ${r.same ? 'same' : 'diff'}" title="similarity ${r.sim}">${r.same ? '✓' : '≠'}</div>`;
}

function toolbar(a) {
  const hasBoth = a.mp3 && a.flac && a.flac.tracks.length;
  if (mode === 'pair') {
    return `<div class="tools"><span class="hint">${picked == null ? 'Tap an MP3 track, then the FLAC track it matches.'
      : 'Now tap the FLAC track that matches it.'}</span><button id="tdone" class="primary">Done</button></div>`;
  }
  if (mode === 'order') {
    const dirty = pending.some((v, k) => v !== k);
    return `<div class="tools"><span class="hint">Move FLAC tracks with the arrows. Saving renumbers and renames the files.</span>
      ${a.mp3 ? '<button id="tmatch">Match MP3 order</button>' : ''}
      <button id="tsave" class="primary" ${dirty ? '' : 'disabled'}>Save order</button><button id="tcancel" class="ghost">Done</button></div>`;
  }
  const b = [];
  if (hasBoth) b.push('<button id="tpair">Pair tracks by hand</button>');
  if (a.flac && a.flac.tracks.length) b.push(`<button id="torder">Edit FLAC tracks</button>`);
  if (a.foreign || a.one_album) {
    b.push(`<button id="tone">${a.one_album ? 'Undo "folder is all one album"' : 'This folder is all one album'}</button>`);
  }
  return b.length ? `<div class="tools">${b.join('')}</div>` : '';
}

function alignedTable(a) {
  return `<div class="tracks ${mode === 'pair' ? 'pairing' : ''}">
    <div class="thead"><div>MP3</div><div></div><div>FLAC</div></div>
    ${album.rows.map((r, k) => `<div class="trow">
      ${a.mp3 ? cell(a, 'mp3', r.m, k) : '<div class="cell empty">—</div>'}
      ${matchCell(r, k)}
      ${cell(a, 'flac', r.f, k)}</div>`).join('')}
  </div>`;
}

function orderTable(a) {
  const n = Math.max(pending.length, a.mp3 ? a.mp3.tracks.length : 0);
  const rows = [];
  for (let k = 0; k < n; k++) {
    const f = pending[k];
    const right = f == null ? '<div class="cell empty">—</div>'
      : `<div class="cell">${cell(a, 'flac', f, -1).replace(/^<div class="cell">|<\/div>$/g, '')}
        <span class="arrows"><button data-up="${k}" ${k === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button data-down="${k}" ${k === pending.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button data-bin="${f}" class="binbtn" aria-label="Put this track in the bin" title="Put this track in the bin">🗑</button></span></div>`;
    rows.push(`<div class="trow"><span class="pos">${k + 1}</span>
      ${a.mp3 && k < a.mp3.tracks.length ? cell(a, 'mp3', k, -1) : '<div class="cell empty">—</div>'}
      ${right}</div>`);
  }
  return `<div class="tracks ordering"><div class="thead"><div></div><div>MP3, in file order</div><div>FLAC, new order</div></div>${rows.join('')}</div>`;
}

async function renderAlbum(id, keepMode = false) {
  let a;
  try { a = await api(`/api/album/${id}`); } catch {
    view.innerHTML = '<p class="empty">This album is no longer in the queue. <a href="#/">Back to the list</a></p>';
    return;
  }
  if (!keepMode || !album || album.id !== a.id) { mode = 'view'; picked = null; }
  album = { ...a, rows: buildRows(a) };
  if (mode === 'order' && (!pending || pending.length !== a.flac.tracks.length)) pending = a.flac.tracks.map((_, k) => k);
  document.title = `${a.artist} — ${a.title} · Sift`;
  const qname = (QUEUES.find((q) => q[0] === a.queue) || [])[1] || a.queue;
  const buttons = ['keep_flac', 'keep_mp3', 'refetch'].filter((d) => a.allowed.includes(d))
    .map((d) => `<button class="${d === 'keep_flac' ? 'primary' : ''}" data-decide="${d}">${DECISION_TEXT[d][0]}</button>`);
  if (a.allowed.length) buttons.push('<a class="button ghost" href="#/">Later</a>');
  const watch = a.allowed.includes('watch')
    ? `<label class="switch"><input type="checkbox" id="watch" ${a.watch ? 'checked' : ''}><span>Watch for a better copy</span></label>` : '';
  const totals = [a.mp3 ? `MP3 ${clock(a.mp3.seconds)} · ${a.mp3.tracks.length} tracks` : 'No MP3',
    `FLAC ${clock(a.flac.seconds)} · ${a.flac.tracks.length} tracks`].join('  vs  ');

  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="ahead">
      ${a.cover ? `<img class="cover" src="/api/cover/${a.id}" alt="">` : '<span class="cover none"></span>'}
      <div><p class="qname">${esc(qname)}</p><h2>${esc(a.title)}</h2><p class="artist">${esc(a.artist)}</p>
      <p class="totals">${esc(totals)}</p></div>
    </div>
    <ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <div class="decisions">${mode === 'view' ? buttons.join('') : ''}</div>
    ${mode === 'view' ? watch : ''}
    ${toolbar(a)}
    ${mode === 'order' ? orderTable(a) : alignedTable(a)}`;

  view.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = async () => {
      const [title, body] = DECISION_TEXT[b.dataset.decide];
      if (await ask({ title: `${title}?`, body, ok: title })) {
        run('/api/decide', { id: a.id, decision: b.dataset.decide });
      }
    };
  });
  view.querySelectorAll('.play').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const row = Number(b.dataset.row);
      play(b.dataset.side, Number(b.dataset.idx), row);
    };
  });
  const w = $('watch');
  if (w) {
    w.onchange = async () => {
      try {
        await api('/api/decide', { id: a.id, decision: w.checked ? 'watch_on' : 'watch_off' });
        await watchJob();
        toast(w.checked ? 'Soularr will look for a better copy.' : 'Soularr will stop looking.');
      } catch (e) { w.checked = !w.checked; toast(e.message); }
    };
  }

  // ---- track tools
  const tool = async (body, note) => {
    if (body.tool === 'reorder' || body.tool === 'bin_track') releaseAudio();
    try {
      await api('/api/track', { id: a.id, ...body });
      await watchJob();
      if (note) toast(note);
    } catch (e) { toast(e.message); }
  };
  const on = (idOrSel, fn) => { const el = typeof idOrSel === 'string' ? $(idOrSel) : idOrSel; if (el) el.onclick = fn; };
  on('tpair', () => { mode = 'pair'; picked = null; renderAlbum(a.id, true); });
  on('tdone', () => { mode = 'view'; picked = null; renderAlbum(a.id, true); });
  on('torder', () => { mode = 'order'; pending = a.flac.tracks.map((_, k) => k); renderAlbum(a.id, true); });
  on('tcancel', () => { mode = 'view'; renderAlbum(a.id, true); });
  on('tone', async () => {
    const turnOn = !a.one_album;
    const ok = await ask(turnOn
      ? { title: 'Treat the whole folder as this album?', ok: 'Yes, one album',
        body: 'Lidarr filed some tracks in this folder under another album. Sift will check the folder as one album, and any decision on it covers every track in the folder. The other entry is unmonitored when you decide.' }
      : { title: 'Stop treating the folder as one album?', ok: 'Undo', body: 'The album goes back to Needs a look.' });
    if (ok) tool({ tool: 'one_album', on: turnOn }, turnOn ? 'Re-checked as one album.' : 'Back to Needs a look.');
  });
  on('tmatch', () => {
    const byFlac = new Map();
    // confirmed pairs only (fingerprint or by hand); the rest keep their order after them
    album.rows.forEach((r) => { if (r.m != null && r.f != null && r.same) byFlac.set(r.f, r.m); });
    pending = a.flac.tracks.map((_, k) => k)
      .sort((x, y) => (byFlac.has(x) ? byFlac.get(x) : 1e6 + x) - (byFlac.has(y) ? byFlac.get(y) : 1e6 + y));
    renderAlbum(a.id, true);
  });
  on('tsave', async () => {
    if (await ask({ title: 'Save the new order?', ok: 'Save order',
      body: 'The FLAC files get new track numbers and filenames in this order. You can undo it from the bin.' })) {
      mode = 'view';
      tool({ tool: 'reorder', order: pending }, 'Tracks renumbered. Undo is in the bin.');
    }
  });
  view.querySelectorAll('[data-up],[data-down]').forEach((b) => {
    b.onclick = () => {
      const k = Number(b.dataset.up ?? b.dataset.down);
      const j = b.dataset.up != null ? k - 1 : k + 1;
      [pending[k], pending[j]] = [pending[j], pending[k]];
      renderAlbum(a.id, true);
    };
  });
  view.querySelectorAll('[data-bin]').forEach((b) => {
    b.onclick = async () => {
      if (pending.some((v, k) => v !== k)) { toast('Save or undo the new order first.'); return; }
      const t = a.flac.tracks[Number(b.dataset.bin)];
      if (await ask({ title: 'Put this track in the bin?', ok: 'Put in bin',
        body: `${t.title || t.name} (${clock(t.secs)}) moves to the bin. You can undo it from there.` })) {
        tool({ tool: 'bin_track', f: Number(b.dataset.bin) }, 'Track is in the bin.');
      }
    };
  });
  view.querySelectorAll('[data-unpair]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); tool({ tool: 'unpair', m: Number(b.dataset.unpair) }); };
  });
  if (mode === 'pair') {
    view.querySelectorAll('.trow .cell').forEach((c) => {
      const btn = c.querySelector('.play');
      if (!btn) return;
      const side = btn.dataset.side, idx = Number(btn.dataset.idx);
      if (side === 'mp3' && picked === idx) c.classList.add('picked');
      c.classList.add('pickable');
      c.onclick = () => {
        if (side === 'mp3') { picked = idx; renderAlbum(a.id, true); return; }
        if (picked == null) { toast('Tap the MP3 track first.'); return; }
        const m = picked;
        picked = null;
        tool({ tool: 'pair', m, f: idx }, 'Paired.');
      };
    });
  }
}

// ---- player ------------------------------------------------------------------
// Two <audio> elements: the one playing, and the same row's other version kept loaded
// beside it. A/B starts the standby inside the tap itself - iOS only lets audio start
// from a user gesture - so the switch is immediate instead of waiting for a fresh load.

const decks = [$('audio'), $('audio2')];
let active = decks[0];
const standby = () => (active === decks[0] ? decks[1] : decks[0]);
let playing = null;          // { side, idx, row, album }
let seeking = false;

const url = (a, side, idx) => `/api/audio/${a.id}/${side}/${idx}`;
const partnerOf = (p) => {
  const r = p && p.album.rows[p.row];
  if (!r) return null;
  const side = p.side === 'mp3' ? 'flac' : 'mp3';
  const idx = side === 'mp3' ? r.m : r.f;
  return idx == null ? null : { side, idx };
};

function load(deck, src) {
  if (deck.getAttribute('src') !== src) {
    deck.setAttribute('src', src);
    deck.load();
  }
}

function showPlaying() {
  const t = playing.album[playing.side].tracks[playing.idx];
  $('player').hidden = false;
  $('pside').textContent = playing.side.toUpperCase();
  $('pside').className = `side ${playing.side}`;
  $('ptitle').textContent = t.title || t.name;
  $('ab').disabled = !partnerOf(playing);
  $('seek').max = active.duration || 0;
  $('plen').textContent = clock(active.duration);
  view.querySelectorAll('.play.on').forEach((b) => b.classList.remove('on'));
  const btn = view.querySelector(`.play[data-side="${playing.side}"][data-idx="${playing.idx}"][data-row="${playing.row}"]`);
  if (btn) btn.classList.add('on');
}

// keep the other version of this row loaded and parked, ready for A/B
function prepareStandby() {
  const p = partnerOf(playing);
  const deck = standby();
  deck.pause();
  if (!p) return;
  deck.preload = 'auto';
  load(deck, url(playing.album, p.side, p.idx));
}

function play(side, idx, row) {
  if (!album) return;
  standby().pause();
  playing = { side, idx, row, album };
  active.preload = 'auto';
  load(active, url(album, side, idx));
  active.play().catch(() => {});
  showPlaying();
  prepareStandby();
}

function seekTo(deck, t) {
  const go = () => { deck.currentTime = Math.min(t, Math.max(0, (deck.duration || t) - 0.5)); };
  if (deck.readyState >= 1) go(); else deck.addEventListener('loadedmetadata', go, { once: true });
}

$('ab').onclick = () => {
  const p = partnerOf(playing);
  if (!p) return;
  const from = active, to = standby(), at = from.currentTime, wasPlaying = !from.paused;
  load(to, url(playing.album, p.side, p.idx));
  seekTo(to, at);
  if (wasPlaying) to.play().catch(() => {});      // still inside the tap
  from.pause();
  active = to;
  playing = { ...playing, side: p.side, idx: p.idx };
  showPlaying();
  // the deck we left already holds the partner's partner - the track we were on - so it
  // stays loaded and the next A/B is just as quick
};

$('pp').onclick = () => (active.paused ? active.play() : active.pause());
$('pclose').onclick = () => {
  for (const d of decks) { d.pause(); d.removeAttribute('src'); d.load(); }
  $('player').hidden = true;
  playing = null;
  view.querySelectorAll('.play.on').forEach((b) => b.classList.remove('on'));
};
for (const d of decks) {
  d.addEventListener('play', () => { if (d === active) $('pp').textContent = '❚❚'; });
  d.addEventListener('pause', () => { if (d === active) $('pp').textContent = '▶'; });
  d.addEventListener('timeupdate', () => {
    if (d !== active) return;
    $('ptime').textContent = clock(d.currentTime);
    if (!seeking) $('seek').value = d.currentTime;
  });
  d.addEventListener('loadedmetadata', () => {
    if (d !== active) return;
    $('seek').max = d.duration || 0;
    $('plen').textContent = clock(d.duration);
  });
}
$('seek').oninput = () => { seeking = true; $('ptime').textContent = clock(Number($('seek').value)); };
$('seek').onchange = () => { active.currentTime = Number($('seek').value); seeking = false; };

// ---- the bin -----------------------------------------------------------------

const DECIDED = { keep_flac: 'Kept FLAC', keep_mp3: 'Kept MP3', refetch: 'Getting a better FLAC',
  adopted: 'Added from the shell', bin_track: 'Track put in the bin', reorder: 'FLAC tracks renumbered' };

function renderBin() {
  document.title = 'Bin · Sift';
  const total = state.bin.reduce((n, e) => n + e.bytes, 0);
  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="qhead"><h2>Bin <span class="count">${gb(total)}</span></h2>
    ${state.bin.length ? '<button class="danger" id="empty">Empty bin</button>' : ''}</div>
    <p class="blurb">Nothing here is deleted until you empty the bin. Until then every decision can be undone.</p>
    ${state.bin.length ? state.bin.map((e) => `<div class="row binrow">
      <span class="rtext"><span class="rtitle">${esc(e.label)}</span>
      <span class="rreason">${esc(DECIDED[e.decision] || e.decision)} · ${ago(e.at)} · ${gb(e.bytes)}</span></span>
      <button data-undo="${esc(e.id)}">Undo</button></div>`).join('') : '<p class="empty">The bin is empty.</p>'}`;
  view.querySelectorAll('[data-undo]').forEach((b) => {
    b.onclick = async () => {
      const e = state.bin.find((x) => x.id === b.dataset.undo);
      if (await ask({ title: 'Undo?', body: `Put ${e.label} back the way it was before.`, ok: 'Undo' })) {
        run('/api/undo', { entry: e.id });
      }
    };
  });
  const empty = $('empty');
  if (empty) {
    empty.onclick = async () => {
      let error = '';
      for (;;) {
        const pw = await ask({ title: `Empty the bin (${gb(total)})?`, danger: true, password: true, ok: 'Delete for good', error,
          body: 'Everything in the bin is deleted, and none of it can be undone afterwards. Enter the password to confirm.' });
        if (pw == null) return;
        try { await api('/api/bin/empty', { password: pw }); watchJob(); return; } catch (e) {
          if (e.status !== 401) { toast(e.message); return; }
          error = 'Wrong password';
        }
      }
    };
  }
}

// ---- routing -----------------------------------------------------------------

function route() {
  if (!state) return;
  const h = location.hash || '#/';
  let m;
  if ((m = /^#\/album\/(\d+)$/.exec(h))) return renderAlbum(Number(m[1]), true);
  if (h === '#/bin') return renderBin();
  album = null;
  return renderList();
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); mode = 'view'; album = null; route(); });
$('check').onclick = () => run('/api/check', {});
$('logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
setInterval(() => { if (!polling) loadState().then(() => { if ((location.hash || '#/') === '#/') renderList(); }).catch(() => {}); }, 60000);

(async () => {
  csrf = (await api('/api/csrf')).csrf;
  await loadState();
  route();
})();
