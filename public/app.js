'use strict';
// Sift's page. Four views on the hash: #/ the queues, #/album/<id>, #/bin, #/history.
// Every change is a POST of an id and a decision name; the server does the rest.

const $ = (id) => document.getElementById(id);
const view = $('view');

const QUEUES = [
  ['ready', 'Ready', 'Exact matches: every track matches the MP3 by fingerprint and every FLAC file decodes cleanly.'],
  ['suspect', 'Suspect FLAC', 'Most FLAC tracks stop short of the top of the spectrum, as a FLAC made from an MP3 does. Compare the spectrograms before deciding: some old or lo-fi recordings stop early too.'],
  ['different', 'Different or unconfirmed version', "The fingerprints don't prove the FLAC is the same recording as the MP3."],
  ['lineup', "Doesn't line up", 'Fewer tracks, a noticeably different length, or an MP3 folder shared with another album.'],
  ['damaged', 'Damaged FLAC', 'Files fail flac -t, usually truncated downloads.'],
  ['look', 'Needs a look', "Something about the folders means Sift won't move it for you."],
  ['health', 'Library health', 'Albums already in the Roon FLAC library with files that fail flac -t or stop short like a converted MP3, found by the nightly check. Nothing replaces them if you bin them.'],
  ['dupes', 'Library duplicates', 'Albums in both the Roon FLAC library and the MP3 library, matched by folder name. Keep FLAC puts the MP3 in the bin; Keep MP3 puts the FLAC in the bin.'],
  ['arriving', 'Arriving', 'Imported in the last few hours; checked once Soularr has finished with them.'],
];
const SHORT = { different: 'Different or unconfirmed', dupes: 'Duplicates', health: 'Health' };
const DECISION_TEXT = {
  keep_flac: ['Keep FLAC', 'The FLAC moves into the Roon FLAC library and the MP3 goes in the bin.'],
  keep_mp3: ['Keep MP3', "The FLAC goes in the bin and Soularr won't fetch this album again."],
  refetch: ['Get a better FLAC', 'The FLAC goes in the bin and Soularr looks for another copy.'],
  bin_album: ['Put in the bin', 'The album goes in the bin, and nothing replaces it. Undo is in the bin.'],
  dismiss: ['Looks fine', "Sift won't raise this album again unless its files change."],
};
// library duplicates: both copies are already in Roon, and no Lidarr fetches either
const DUPE_TEXT = {
  keep_flac: ['Keep FLAC', 'The MP3 goes in the bin; the FLAC stays where it is.'],
  keep_mp3: ['Keep MP3', 'The FLAC goes in the bin; the MP3 stays where it is.'],
};

let state = null;
let csrf = null;
let album = null;            // the album on screen, with its rows
let search = '';
let sortBy = localStorage.getItem('sift-sort') || 'artist';
let selecting = false;
const selected = new Set();
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
const khz = (hz) => (hz ? `${(hz / 1000).toFixed(1)} kHz` : '–');
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
// With `choices`, resolves to { choice } holding the index picked.
function ask({ title, body, ok = 'OK', password = false, danger = false, error = '', choices = null, chosen = 0 }) {
  const d = $('dialog');
  $('dtitle').textContent = title;
  $('dbody').textContent = body;
  $('dok').textContent = ok;
  $('dok').classList.toggle('danger', danger);
  $('dpassword').hidden = !password;
  $('dchoose').hidden = !choices;
  if (choices) {
    $('dselect').innerHTML = choices.map((c, k) => `<option value="${k}">${esc(c)}</option>`).join('');
    $('dselect').value = String(chosen);
  }
  $('dpassword').value = '';
  $('derror').hidden = !error;
  $('derror').textContent = error;
  d.returnValue = '';
  d.showModal();
  if (password) $('dpassword').focus();
  return new Promise((resolve) => {
    $('dcancel').onclick = () => d.close('cancel');
    d.onclose = () => resolve(d.returnValue !== 'ok' ? null
      : password ? $('dpassword').value : choices ? { choice: Number($('dselect').value) } : true);
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
        if (job.ok && afterJob) { const go = afterJob; afterJob = null; location.hash = go; }
        if (!job.ok) afterJob = null;
        if (job.ok) {
          setTimeout(() => { bar.hidden = true; }, 2500);
          const note = { keep_flac: 'Moved into the FLAC library. Undo is in the bin.',
            keep_mp3: 'Done. Undo is in the bin.', refetch: 'FLAC is in the bin and Soularr will look again.',
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
  } catch (e) { afterJob = null; toast(e.message); }
}

// ---- the queues --------------------------------------------------------------

const cmp = (x, y) => String(x || '').localeCompare(String(y || ''), undefined, { sensitivity: 'base' });
const SORTS = {
  artist: ['Artist', (x, y) => cmp(x.artist, y.artist) || cmp(x.title, y.title)],
  arrived: ['Newest first', (x, y) => cmp(y.first_seen, x.first_seen) || cmp(x.artist, y.artist)],
  reason: ['Reason', (x, y) => cmp((x.reasons || [])[0], (y.reasons || [])[0]) || cmp(x.artist, y.artist)],
};
const fold = (t) => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const matches = (i) => !search || fold(`${i.artist} ${i.title}`).includes(fold(search));

function row(i) {
  const badges = [];
  if (isNew(i)) badges.push('<span class="badge new">new</span>');
  if (i.flac) badges.push(`<span class="badge">FLAC ${esc(i.flac.fmt)} · ${i.flac.n}</span>`);
  if (i.mp3) badges.push(`<span class="badge">MP3 ${esc(i.mp3.fmt)} · ${i.mp3.n}</span>`);
  if (i.flac && i.flac.damaged) badges.push(`<span class="badge bad">${i.flac.damaged} damaged</span>`);
  if (i.suspect) badges.push(`<span class="badge bad">FLAC stops at ${khz(i.suspect.hz)}</span>`);
  const inner = `${i.cover ? `<img class="thumb" src="/api/cover/${i.id}" alt="" loading="lazy">` : '<span class="thumb none"></span>'}
    <span class="rtext"><span class="rtitle">${esc(i.artist)} — ${esc(i.title)}</span>
    <span class="rreason">${esc((i.diagnosis && i.diagnosis.text) || (i.reasons || [])[0] || '')}</span>
    <span class="badges">${badges.join('')}</span></span>`;
  if (selecting) {
    return `<label class="row picking"><input type="checkbox" class="pick" data-pick="${i.id}" ${selected.has(i.id) ? 'checked' : ''}
      aria-label="Select ${esc(i.artist)} — ${esc(i.title)}">${inner}</label>`;
  }
  return `<a class="row" href="#/album/${i.id}">${inner}</a>`;
}

function renderList() {
  document.title = 'Sift';
  if (!$('queues')) {
    view.innerHTML = `<div class="listtools">
        <input type="search" id="search" placeholder="Search artist or title" autocomplete="off" aria-label="Search">
        <select id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, [name]]) => `<option value="${k}">${name}</option>`).join('')}</select>
        <button id="selecting" class="ghost">Select</button>
      </div>
      <nav class="jump" id="jump"></nav><div id="queues"></div>`;
    $('search').value = search;
    $('search').oninput = () => { search = $('search').value; renderList(); };
    $('sort').value = sortBy;
    $('sort').onchange = () => { sortBy = $('sort').value; localStorage.setItem('sift-sort', sortBy); renderList(); };
    $('selecting').onclick = () => { selecting = !selecting; selected.clear(); renderList(); };
  }
  $('selecting').textContent = selecting ? 'Cancel' : 'Select';
  const byQueue = (key) => state.items.filter((i) => i.queue === key && matches(i)).sort(SORTS[sortBy][1]);
  const parts = [];
  const shown = [];
  for (const [key, name, blurb] of QUEUES) {
    const items = byQueue(key);
    if (!items.length && (key !== 'ready' || search)) continue;
    const head = `<div class="qhead"><h2>${name} <span class="count">${items.length}</span></h2>`
      + (selecting && items.length ? `<button class="ghost small" data-all="${key}">Select all</button>` : '')
      + (!selecting && !search && key === 'ready' && items.length ? `<button class="primary" id="approve">Approve all ${items.length}</button>` : '')
      + '</div>';
    parts.push(`<section class="queue" id="q-${key}">${head}<p class="blurb">${blurb}</p>`
      + (items.length ? items.map(row).join('') : '<p class="empty">Nothing waiting.</p>') + '</section>');
    shown.push([key, name, items.length]);
  }
  if (search && !parts.length) parts.push('<p class="empty">No album matches.</p>');
  $('jump').innerHTML = shown.map(([key, name, n]) =>
    `<a href="#/" data-jump="${key}">${esc(SHORT[key] || name)} <span class="count">${n}</span></a>`).join('');
  $('queues').innerHTML = parts.join('');
  view.querySelectorAll('[data-jump]').forEach((l) => {
    l.onclick = (ev) => {
      ev.preventDefault();
      $(`q-${l.dataset.jump}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  view.querySelectorAll('[data-pick]').forEach((c) => {
    c.onchange = () => { const id = Number(c.dataset.pick); if (c.checked) selected.add(id); else selected.delete(id); renderSelection(); };
  });
  view.querySelectorAll('[data-all]').forEach((b) => {
    b.onclick = () => { byQueue(b.dataset.all).forEach((i) => selected.add(i.id)); renderList(); };
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
  renderSelection();
}

// the bar of decisions for the albums ticked in Select mode
function renderSelection() {
  const bar = $('selbar');
  const onList = (location.hash || '#/') === '#/';
  for (const id of selected) if (!state.items.some((i) => i.id === id)) selected.delete(id);
  bar.hidden = !(selecting && onList);
  if (bar.hidden) return;
  const picked = state.items.filter((i) => selected.has(i.id));
  $('selcount').textContent = `${picked.length} selected`;
  bar.querySelectorAll('[data-many]').forEach((b) => {
    const d = b.dataset.many;
    const n = picked.filter((i) => (i.allowed || []).includes(d)).length;
    b.textContent = `${DECISION_TEXT[d][0]}${n && n !== picked.length ? ` (${n})` : ''}`;
    b.disabled = !n;
    b.onclick = async () => {
      const ids = picked.filter((i) => i.allowed.includes(d)).map((i) => i.id);
      const skip = picked.length - ids.length;
      const ok = await ask({ title: `${DECISION_TEXT[d][0]} for ${ids.length} album${ids.length === 1 ? '' : 's'}?`, ok: DECISION_TEXT[d][0],
        body: `${DECISION_TEXT[d][1]} Each album gets its own bin entry, so each can be undone on its own.`
          + (skip ? ` ${skip} of those selected can't take this decision and will be left alone.` : '') });
      if (!ok) return;
      selecting = false;
      selected.clear();
      renderList();
      run('/api/decide-many', { decision: d, ids });
    };
  });
}
$('selcancel').onclick = () => { selecting = false; selected.clear(); renderList(); };

// ---- an album ----------------------------------------------------------------

// the albums around this one in its queue, in the list's order and search
function neighbours(a) {
  const list = state.items.filter((i) => i.queue === a.queue && matches(i)).sort(SORTS[sortBy][1]);
  const k = list.findIndex((i) => i.id === a.id);
  return { prev: k > 0 ? list[k - 1] : null, next: k >= 0 && k < list.length - 1 ? list[k + 1] : null };
}
let afterJob = null;          // where to go once the decision in progress succeeds

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
    <span class="tmeta">${clock(t.secs)} · ${esc(t.fmt)}${t.cutoff
      ? ` · <span class="${side === 'flac' && t.cutoff < SUSPECT_HZ ? 'low' : ''}" title="Highest frequency with sound">to ${khz(t.cutoff)}</span>` : ''}${t.lufs != null
      ? ` · <span title="Integrated loudness">${t.lufs.toFixed(1)} LUFS</span>` : ''}</span>${damaged}</span></div>`;
}

const SUSPECT_HZ = 20500;     // bin/sift.py's line: a FLAC track stopping below it is flagged
let mode = 'view';            // view | pair | order | spectra
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
  if (mode === 'spectra') {
    return `<div class="tools"><span class="hint">Each track's spectrum, MP3 on the left, FLAC on the right. A FLAC made from an MP3 goes dark at the same height as the MP3. Tap a picture to see it full size.</span>
      <button id="tcancel" class="primary">Done</button></div>`;
  }
  if (mode === 'order') {
    const dirty = pending.some((v, k) => v !== k);
    return `<div class="tools"><span class="hint">Move FLAC tracks with the arrows. Saving renumbers and renames the files.</span>
      ${a.mp3 ? '<button id="tmatch">Match MP3 order</button>' : ''}
      <button id="tsave" class="primary" ${dirty ? '' : 'disabled'}>Save order</button><button id="tcancel" class="ghost">Done</button></div>`;
  }
  const b = [];
  if (a.flac && a.flac.tracks.length) b.push('<button id="tspectra">Spectrograms</button>');
  if (hasBoth) b.push(`<button id="tpair" class="${a.diagnosis && a.diagnosis.suggest === 'pair' ? 'primary' : ''}">Pair tracks by hand</button>`);
  if (a.flac && a.flac.tracks.length && a.reorder) b.push(`<button id="torder">Edit FLAC tracks</button>`);
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
      ${cell(a, 'flac', r.f, k)}</div>${mode === 'spectra' ? `<div class="spec">
      ${spectrumPic(a, 'mp3', r.m)}<div></div>${spectrumPic(a, 'flac', r.f)}</div>` : ''}`).join('')}
  </div>`;
}

function spectrumPic(a, side, idx) {
  if (idx == null || !a[side]) return '<div class="specpic none"></div>';
  const src = `/api/spectrum/${a.id}/${side}/${idx}`;
  return `<a class="specpic" href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${side.toUpperCase()} spectrogram" loading="lazy"></a>`;
}

// ---- release details, side by side

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FACTS = [
  ['Release', (d, t) => d.title || t.album],
  ['Year', (d, t) => (d.date || t.date || '').slice(0, 4)],
  ['First released', (d, t) => (d.original || t.originaldate || '').slice(0, 4)],
  ['Label', (d, t) => d.label || t.label],
  ['Catalogue no.', (d, t) => t.catalognumber],
  ['Country', (d, t) => d.country || t.releasecountry],
  ['Format', (d, t) => d.format || t.media],
  ['MusicBrainz release', (d, t) => d.release || t.musicbrainz_albumid, 'release'],
  ['Release group', (d, t) => d.release_group || t.musicbrainz_releasegroupid, 'release-group'],
];
// tags the rows above only ever show from the tags; the rest are listed again when they
// differ, since the rows above prefer what Lidarr says
const SHOWN_TAGS = new Set(['catalognumber']);

function factValue(v, link) {
  if (!v) return '<span class="muted">—</span>';
  if (link && MBID.test(v)) return `<a href="https://musicbrainz.org/${link}/${v}" target="_blank" rel="noopener noreferrer">${v.slice(0, 8)}</a>`;
  return esc(v);
}

// "FLAC is the 2012 reissue; MP3 is the 1971 original", or whatever can honestly be said
function factSummary(F, M) {
  const [fr, mr] = [F.release || F.tags.musicbrainz_albumid, M.release || M.tags.musicbrainz_albumid];
  if (fr && fr === mr) return 'Both are the same MusicBrainz release.';
  const year = (d) => Number((d.date || d.tags.date || '').slice(0, 4)) || null;
  const first = Math.min(...[F, M].map((d) => Number((d.original || d.tags.originaldate || '').slice(0, 4)) || 9999));
  const [fy, my] = [year(F), year(M)];
  if (fy && my && fy !== my) {
    const kind = (y) => (first < 9999 && y > first ? 'reissue' : 'original');
    return `FLAC is the ${fy} ${kind(fy)}; MP3 is the ${my} ${kind(my)}.`;
  }
  const [fg, mg] = [F.release_group || F.tags.musicbrainz_releasegroupid, M.release_group || M.tags.musicbrainz_releasegroupid];
  if (fr && mr && fg && fg === mg) return 'Same album, different releases.';
  return '';
}

function releaseFacts(a) {
  const F = a.flac && a.flac.details, M = a.mp3 && a.mp3.details;
  if (!F && !M) return '';
  const none = { tags: {} };
  const f = F || none, m = M || none;
  const rows = FACTS.map(([label, get, link]) => {
    const fv = get(f, f.tags || {}), mv = get(m, m.tags || {});
    const differ = F && M && fv && mv && String(fv).toLowerCase() !== String(mv).toLowerCase();
    return `<tr class="${differ ? 'differ' : ''}"><th>${label}</th><td>${factValue(mv, link)}</td><td>${factValue(fv, link)}</td></tr>`;
  });
  const keys = [...new Set([...Object.keys(f.tags || {}), ...Object.keys(m.tags || {})])].filter((k) => !SHOWN_TAGS.has(k)).sort();
  for (const k of keys) {
    const fv = (f.tags || {})[k], mv = (m.tags || {})[k];
    if (F && M && fv !== mv) rows.push(`<tr class="differ tag"><th>${esc(k)}</th><td>${factValue(mv)}</td><td>${factValue(fv)}</td></tr>`);
  }
  const pic = (side) => ((a.covers || []).includes(side) ? `<img class="sidecover" src="/api/cover/${a.id}/${side}" alt="${side.toUpperCase()} cover" loading="lazy">` : '<span class="muted">—</span>');
  const said = F && M ? factSummary({ tags: {}, ...F }, { tags: {}, ...M }) : '';
  return `<details class="facts" id="facts" ${localStorage.getItem('sift-facts') === 'open' ? 'open' : ''}>
    <summary>Release details${said ? `: <span class="said">${esc(said)}</span>` : ''}</summary>
    <table><thead><tr><th></th><th>MP3</th><th>FLAC</th></tr></thead><tbody>
    <tr><th>Cover</th><td>${a.mp3 ? pic('mp3') : ''}</td><td>${pic('flac')}</td></tr>
    ${rows.join('')}</tbody></table></details>`;
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
  const texts = a.dupe ? DUPE_TEXT : DECISION_TEXT;
  const diag = a.diagnosis;
  const primary = diag && diag.suggest && a.allowed.includes(diag.suggest) ? diag.suggest : 'keep_flac';
  const buttons = ['keep_flac', 'keep_mp3', 'refetch', 'bin_album', 'dismiss'].filter((d) => a.allowed.includes(d))
    .map((d) => `<button class="${d === primary || (a.health && d === 'dismiss') ? 'primary' : ''}" data-decide="${d}">${texts[d][0]}${diag && diag.suggest === d ? ' <span class="sugg">suggested</span>' : ''}</button>`);
  const near = neighbours(a);
  if (a.allowed.length) buttons.push(`<a class="button ghost" id="later" href="${near.next ? `#/album/${near.next.id}` : '#/'}">${near.next ? 'Next album' : 'Later'}</a>`);
  const watch = a.allowed.includes('watch')
    ? `<label class="switch"><input type="checkbox" id="watch" ${a.watch ? 'checked' : ''}><span>Watch for a better copy</span></label>` : '';
  const totals = [a.mp3 ? `MP3 ${clock(a.mp3.seconds)} · ${a.mp3.tracks.length} tracks` : (a.health ? 'In the FLAC library' : 'No MP3'),
    `FLAC ${clock(a.flac.seconds)} · ${a.flac.tracks.length} tracks`].join('  vs  ');

  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="ahead">
      ${a.cover ? `<img class="cover" src="/api/cover/${a.id}" alt="">` : '<span class="cover none"></span>'}
      <div><p class="qname">${esc(qname)}</p><h2>${esc(a.title)}</h2><p class="artist">${esc(a.artist)}</p>
      <p class="totals">${esc(totals)}</p></div>
    </div>
    ${diag ? `<p class="diag">${esc(diag.text)}</p>` : ''}
    <ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${a.source ? `<p class="source">From Soulseek user <b>${esc(a.source.user)}</b>${a.source.albums > 1 ? ` · ${a.source.albums} albums from them waiting here` : ''}${a.source.bad
      ? ` · <span class="bad">${a.source.bad} suspect or damaged</span>` : ''}${a.source.blocked ? ' · blocked'
      : ' <button id="block" class="ghost small">Block this user</button>'}</p>` : ''}
    ${mode === 'view' ? releaseFacts(a) : ''}
    <div class="decisions">${mode === 'view' ? buttons.join('') : ''}</div>
    ${mode === 'view' ? watch : ''}
    ${toolbar(a)}
    ${mode === 'order' ? orderTable(a) : alignedTable(a)}`;

  const facts = $('facts');
  if (facts) facts.ontoggle = () => localStorage.setItem('sift-facts', facts.open ? 'open' : 'closed');
  view.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = async () => {
      const [title, body] = texts[b.dataset.decide];
      const rels = b.dataset.decide === 'refetch' && (a.releases || []).length > 1 ? a.releases : null;
      let chosen = 0;
      if (rels) {
        // the MP3's own release first, if Lidarr-FLAC knows it; else the one already selected
        const mp3Release = a.mp3 && a.mp3.details && (a.mp3.details.release || (a.mp3.details.tags || {}).musicbrainz_albumid);
        const k = rels.findIndex((r) => r.release === mp3Release);
        chosen = k >= 0 ? k : Math.max(0, rels.findIndex((r) => r.selected));
      }
      const label = (r) => [r.date.slice(0, 4), r.title, r.format, r.country, r.label, `${r.tracks} tracks`].filter(Boolean).join(' · ')
        + (r.release === (a.mp3 && a.mp3.details && a.mp3.details.release) ? ' (the MP3’s release)' : '');
      const answer = await ask({ title: `${title}?`, body, ok: title, choices: rels && rels.map(label), chosen });
      if (answer) {
        const n = neighbours(a).next || neighbours(a).prev;
        afterJob = n ? `#/album/${n.id}` : '#/';
        run('/api/decide', { id: a.id, decision: b.dataset.decide, ...(rels ? { release: answer.choice } : {}) });
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
  const tool0 = async (url, body, note) => {
    try { await api(url, body); await watchJob(); toast(note); } catch (e) { toast(e.message); }
  };
  const on = (idOrSel, fn) => { const el = typeof idOrSel === 'string' ? $(idOrSel) : idOrSel; if (el) el.onclick = fn; };
  on('block', async () => {
    if (await ask({ title: `Block ${a.source.user}?`, ok: 'Block',
      body: "Soularr won't download from them again. This album stays as it is; decide on it separately. You can undo it from the bin." })) {
      tool0('/api/block', { id: a.id }, `${a.source.user} is blocked.`);
    }
  });
  on('tspectra', () => { mode = 'spectra'; renderAlbum(a.id, true); });
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

// ---- volume matching
// Louder sounds better in a quick comparison, so each version can be turned down to the
// quieter one's integrated loudness. The Web Audio graph is only built once matching is
// first used, inside a tap (iOS won't start an AudioContext otherwise); until then the
// <audio> elements play straight out, exactly as before.

let matchOn = localStorage.getItem('sift-match') === 'on';
let audioCtx = null;
const gains = new Map();

function ensureGraph() {
  if (!matchOn) return;
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    for (const d of decks) {
      const g = audioCtx.createGain();
      audioCtx.createMediaElementSource(d).connect(g).connect(audioCtx.destination);
      gains.set(d, g);
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

const lufsOf = (album, side, idx) => (idx == null || !album[side] ? null : album[side].tracks[idx].lufs);

function levels() {
  const r = playing && playing.album.rows[playing.row];
  if (!r) return null;
  const mp3 = lufsOf(playing.album, 'mp3', r.m), flac = lufsOf(playing.album, 'flac', r.f);
  return mp3 == null || flac == null ? null : { mp3, flac };
}

function applyGains() {
  const l = levels();
  const text = !l ? '' : Math.abs(l.flac - l.mp3) < 0.1 ? 'Same loudness'
    : `${l.flac > l.mp3 ? 'FLAC' : 'MP3'} is ${Math.abs(l.flac - l.mp3).toFixed(1)} dB louder`;
  $('pdiff').textContent = text + (text && matchOn ? ' · matched' : '');
  $('match').checked = matchOn;
  $('match').disabled = !l;
  if (!audioCtx) return;
  for (const d of decks) {
    const m = /\/api\/audio\/\d+\/(flac|mp3)\//.exec(d.getAttribute('src') || '');
    const target = l && m ? Math.min(l.mp3, l.flac) - l[m[1]] : 0;
    gains.get(d).gain.value = matchOn ? 10 ** (target / 20) : 1;
  }
}

$('match').onchange = () => {
  matchOn = $('match').checked;
  localStorage.setItem('sift-match', matchOn ? 'on' : 'off');
  ensureGraph();
  applyGains();
};

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
  applyGains();
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
  ensureGraph();
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
  ensureGraph();
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

$('pp').onclick = () => { ensureGraph(); return active.paused ? active.play() : active.pause(); };
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

const DECIDED = { keep_flac: 'Kept FLAC', keep_mp3: 'Kept MP3', refetch: 'Getting a better FLAC', bin_album: 'Album put in the bin',
  adopted: 'Added from the shell', bin_track: 'Track put in the bin', reorder: 'FLAC tracks renumbered', block_user: 'Soulseek user blocked' };

function renderBin() {
  document.title = 'Bin · Sift';
  const total = state.bin.reduce((n, e) => n + e.bytes, 0);
  const days = (state.settings || {}).retention_days || 0;
  const old = days ? state.bin.filter((e) => Date.now() - new Date(e.at).getTime() > days * 86400000) : [];
  const oldBytes = old.reduce((n, e) => n + e.bytes, 0);
  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="qhead"><h2>Bin <span class="count">${gb(total)}</span></h2>
    ${state.bin.length ? '<button class="danger" id="empty">Empty bin</button>' : ''}</div>
    <p class="blurb">Nothing here is deleted until you empty the bin. Until then every decision can be undone.</p>
    <div class="retain"><label>Keep entries for <select id="retention">${[0, 7, 14, 30, 60, 90].map((d) =>
      `<option value="${d}" ${d === days ? 'selected' : ''}>${d ? `${d} days` : 'as long as I like'}</option>`).join('')}</select></label>
      ${old.length ? `<button class="danger small" id="emptyold">Empty ${old.length} older than ${days} days (${gb(oldBytes)})</button>`
    : days ? `<span class="muted">Nothing older than ${days} days.</span>` : ''}</div>
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
  $('retention').onchange = async () => {
    try {
      await api('/api/settings', { retention_days: Number($('retention').value) });
      await loadState();
      renderBin();
    } catch (e) { toast(e.message); }
  };
  const emptyWith = (older) => async () => {
    let error = '';
    for (;;) {
      const pw = await ask({ title: older ? `Empty ${old.length} entries older than ${days} days (${gb(oldBytes)})?` : `Empty the bin (${gb(total)})?`,
        danger: true, password: true, ok: 'Delete for good', error,
        body: `${older ? 'Those entries are' : 'Everything in the bin is'} deleted, and none of it can be undone afterwards. Enter the password to confirm.` });
      if (pw == null) return;
      try { await api('/api/bin/empty', { password: pw, older }); watchJob(); return; } catch (e) {
        if (e.status !== 401) { toast(e.message); return; }
        error = 'Wrong password';
      }
    }
  };
  if ($('empty')) $('empty').onclick = emptyWith(false);
  if ($('emptyold')) $('emptyold').onclick = emptyWith(true);
}

// ---- history -----------------------------------------------------------------

const OUTCOME = { bin: ['In the bin', ''], undone: ['Undone', 'muted'], emptied: ['Deleted for good', ''], failed: ['Failed', 'bad'] };
const DECIDED_MANY = { 'approve-ready': 'Approve all ready', check: 'Check', undo: 'Undo', 'empty-bin': 'Empty bin',
  pair: 'Pair tracks', unpair: 'Forget a pair', one_album: 'One album' };

async function renderHistory() {
  document.title = 'History · Sift';
  let h;
  try { h = await api('/api/history'); } catch (e) { view.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  if (location.hash !== '#/history') return;
  const t = h.totals;
  const tile = (n, label) => `<div class="tile"><span class="big">${n}</span><span>${label}</span></div>`;
  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="qhead"><h2>History</h2></div>
    <div class="tiles">${tile(t.flac, 'upgraded to FLAC')}${tile(t.mp3, 'kept as MP3')}${tile(t.refetch, 're-fetched')}${tile(gb(t.freed), `freed by emptying the bin${t.emptied ? ` (${t.emptied}×)` : ''}`)}</div>
    <p class="blurb">Decisions still in the bin count, and so do those deleted for good. Undone ones don't.</p>
    ${h.events.length ? h.events.map((e) => {
    const [word, cls] = OUTCOME[e.outcome];
    return `<div class="row histrow"><span class="rtext"><span class="rtitle">${esc(e.label || '')}</span>
      <span class="rreason">${esc((e.outcome === 'failed' && (DECISION_TEXT[e.decision] || [])[0]) || DECIDED[e.decision] || DECIDED_MANY[e.decision] || e.decision)} · ${new Date(e.at).toLocaleString()}${e.bytes ? ` · ${gb(e.bytes)}` : ''}</span>
      ${e.error ? `<span class="rreason bad">${esc(e.error)}</span>` : ''}</span>
      <span class="badge ${cls}">${word}</span></div>`;
  }).join('') : '<p class="empty">Nothing decided yet.</p>'}`;
}

// ---- keyboard (desktop) ----------------------------------------------------------

function keyRows(dir) {
  if (!album) return;
  const rows = album.rows;
  const side = playing ? playing.side : 'mp3';
  let k = playing && playing.album.id === album.id ? playing.row + dir : (dir > 0 ? 0 : rows.length - 1);
  for (; k >= 0 && k < rows.length; k += dir) {
    const r = rows[k];
    const idx = side === 'mp3' ? r.m : r.f;
    const other = side === 'mp3' ? r.f : r.m;
    if (idx != null) return play(side, idx, k);
    if (other != null) return play(side === 'mp3' ? 'flac' : 'mp3', other, k);
  }
}

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // a focused checkbox or seek bar (just clicked) shouldn't swallow the shortcuts; text fields should
  if (ev.target.closest('textarea, select, input:not([type=checkbox]):not([type=range])') || $('dialog').open) return;
  if (ev.key === '?') { ev.preventDefault(); $('keys').showModal(); return; }
  if ($('keys').open) return;
  const onAlbum = !!album;
  if (ev.key === ' ' && playing) { ev.preventDefault(); $('pp').onclick(); }
  else if ((ev.key === 'a' || ev.key === 'A') && playing) { if (!$('ab').disabled) $('ab').onclick(); }
  else if (ev.key === 'ArrowLeft' && playing) { ev.preventDefault(); active.currentTime = Math.max(0, active.currentTime - 10); }
  else if (ev.key === 'ArrowRight' && playing) { ev.preventDefault(); active.currentTime = Math.min(active.duration || 0, active.currentTime + 10); }
  else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && onAlbum && mode !== 'order') {
    ev.preventDefault();
    keyRows(ev.key === 'ArrowDown' ? 1 : -1);
  } else if (ev.key === 'Escape' && onAlbum && mode !== 'view') { mode = 'view'; picked = null; renderAlbum(album.id, true); }
  else if ((ev.key === 'j' || ev.key === 'k') && onAlbum) {
    const n = neighbours(album)[ev.key === 'j' ? 'next' : 'prev'];
    if (n) location.hash = `#/album/${n.id}`;
  } else if (['1', '2', '3'].includes(ev.key) && onAlbum && mode === 'view') {
    const b = view.querySelector(`[data-decide="${['keep_flac', 'keep_mp3', 'refetch'][Number(ev.key) - 1]}"]`);
    if (b) b.click();
  }
});

// ---- routing -----------------------------------------------------------------

function route() {
  if (!state) return;
  const h = location.hash || '#/';
  let m;
  renderSelection();
  if ((m = /^#\/album\/(\d+)$/.exec(h))) return renderAlbum(Number(m[1]), true);
  album = null;
  if (h === '#/bin') return renderBin();
  if (h === '#/history') return renderHistory();
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
