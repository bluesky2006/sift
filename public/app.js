'use strict';
// Sift's page. Views on the hash: #/ the queues, #/album/<id>, #/download/<id>, #/art/<id>, #/bin, #/history.
// Every change is a POST of an id and a decision name; the server does the rest. Album
// decisions are staged, and only move files once approved from the Staged tab.

const $ = (id) => document.getElementById(id);
const view = $('view');

// the player and the Select bar dock at the foot of the page; keep room for them both,
// however tall they wrap, so the last rows can always be scrolled clear
const dock = document.querySelector('.dock');
new ResizeObserver(() => {
  document.body.style.paddingBottom = `calc(${Math.max(128, dock.offsetHeight + 24)}px + env(safe-area-inset-bottom))`;
}).observe(dock);

const QUEUES = [
  ['staged', 'Staged', "Decisions waiting for your approval. Nothing has moved yet. Untick any you're unsure of, then approve the rest."],
  ['ready', 'Ready', 'Exact matches: every track matches the MP3 by fingerprint and every FLAC file decodes cleanly. '
    + 'An album badged "No MP3 to replace" has nothing to match against, so Stage all leaves it for you to decide on its own. '
    + 'A refetched album is matched against the copy it replaced while that copy is still in the bin.'],
  ['suspect', 'Suspect FLAC', 'Most FLAC tracks stop short of the top of the spectrum, as a FLAC made from an MP3 does. Compare the spectrograms before deciding: some old or lo-fi recordings stop early too.'],
  ['different', 'Different or unconfirmed version', "The fingerprints don't prove the FLAC is the same recording as the MP3."],
  ['lineup', "Doesn't line up", 'Fewer tracks, a noticeably different length, or an MP3 folder shared with another album.'],
  ['damaged', 'Damaged FLAC', 'Files fail flac -t, usually truncated downloads.'],
  ['look', 'Needs a look', "Something about the folders means Sift won't move it for you."],
  ['health', 'Library health', 'Albums already in the Roon FLAC library with files that fail flac -t or stop short like a converted MP3, found by the nightly check. Nothing replaces them if you bin them.'],
  ['dupes', 'Library duplicates', 'Albums in both the Roon FLAC library and the MP3 library, matched by folder name. Keep FLAC puts the MP3 in the bin; Keep MP3 puts the FLAC in the bin.'],
  ['artwork', 'Missing artwork', 'Albums in the Roon FLAC library with no picture at all: none beside the files and none in them. '
    + 'Sift searches the Cover Art Archive, Apple and Deezer for pictures at least 1000 px after each check, and suggests the one that is surely this album; suggestions come first. '
    + 'Look the suggestions over, then use them, or open an album to choose another. Each one can be undone from the bin.'],
  ['arriving', 'Arriving', 'Imported in the last few hours; checked once Soularr has finished with them.'],
  ['downloads', 'Downloads', "Folders downloaded by hand in slskd. Soularr only imports what it fetched itself, so these wait here until you import them. "
    + 'Import asks Lidarr to move and rename the whole folder into the library in one go; the album then arrives in the queue like any other.'],
];
const SHORT = { staged: 'Staged', different: 'Different or unconfirmed', dupes: 'Duplicates', health: 'Health', artwork: 'Artwork' };
// a hand-made download, shown in the list beside the albums: what its row says
const downloadItem = (d) => ({ ...d, queue: 'downloads', download: true, artist: d.artist || d.name,
  reasons: [d.busy ? 'Still downloading' : d.blocked || (d.lidarr ? `Files as ${d.lidarr.artist} — ${d.lidarr.title}` : '')] });
// a library album with no artwork: what its row says
const artworkItem = (a) => ({ ...a, queue: 'artwork', artwork: true,
  reasons: [!a.found ? 'Not searched yet' : a.found.state === 'skipped' ? 'Skipped'
    : a.found.state === 'suggested' ? `Suggested from ${a.found.count} hi-res picture${a.found.count === 1 ? '' : 's'} found`
      : a.found.count ? `${a.found.count} hi-res picture${a.found.count === 1 ? '' : 's'} found, none surely this album` : 'Nothing hi-res found'] });
const allItems = () => [...state.items, ...(state.downloads || []).map(downloadItem), ...(state.artwork || []).map(artworkItem)];
const suggested = (i) => i.found && i.found.state === 'suggested' && i.found.pick != null;
// Missing artwork lists suggestions first, then albums with pictures to choose from, then the
// rest; the sort menu orders each group
// in Select mode, quick ways to tick a group: [key, button, which albums]
const ARTWORK_PICKS = [
  ['suggested', 'Suggested', (i) => suggested(i)],
  ['choose', 'To choose', (i) => i.found && i.found.state !== 'skipped' && !suggested(i) && i.found.count > 0],
  ['none', 'Nothing found', (i) => i.found && i.found.state !== 'skipped' && !i.found.count],
  ['unsearched', 'Not searched', (i) => !i.found],
];
const artRank = (i) => (suggested(i) ? 0 : !i.found ? 2 : i.found.state === 'skipped' ? 4 : i.found.count ? 1 : 3);
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
let tab = localStorage.getItem('sift-tab') || 'ready';
// "Show file paths" in the ⋯ menu: each track's path inside its music folder, on every album
let showPaths = localStorage.getItem('sift-paths') === 'on';
let selecting = false;
const approving = new Set(); // ids in the approval job now running, followed row by row
const unticked = new Set();   // staged decisions left out of the next approval
const selected = new Set();
// Icons: 24px strokes in currentColor, so they take each button's colour. Media ones are filled.
const ICONS = {
  check: 'M20 6 9 17l-5-5',
  image: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v7H2v-7z',
  plus: 'M12 5v14M5 12h14',
  checks: 'M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  thumb: 'M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z',
  next: 'M5 12h14M13 5l7 7-7 7',
  chev: 'M6 9l6 6 6-6',
  previous: 'M19 12H5M11 5l-7 7 7 7',
  x: 'M18 6 6 18M6 6l12 12',
  select: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  wave: 'M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h0',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  list: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  sort: 'M7 3v18M3 7l4-4 4 4M17 21V3M21 17l-4 4-4-4',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  ban: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.93 4.93l14.14 14.14',
  undo: 'M3 7v6h6M21 17a9 9 0 0 0-15-6.7L3 13',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  ab: 'M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4',
  play: { fill: 'M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z' },
  pause: { fill: 'M6 4h4v16H6zM14 4h4v16h-4z' },
  prev: { fill: 'M6 5h2v14H6zM20 5.5v13a1 1 0 0 1-1.54.84L9 12.84a1 1 0 0 1 0-1.68l9.46-6.5A1 1 0 0 1 20 5.5z' },
  skip: { fill: 'M16 5h2v14h-2zM4 5.5v13a1 1 0 0 0 1.54.84L15 12.84a1 1 0 0 0 0-1.68L5.54 4.66A1 1 0 0 0 4 5.5z' },
};
const ic = (name) => {
  const d = ICONS[name];
  return d.fill ? `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${d.fill}" fill="currentColor"/></svg>`
    : `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
};
// the icons in the page's own HTML, named by data-icon
document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', ic(el.dataset.icon)));
const DECISION_ICON = { keep_flac: 'check', keep_mp3: 'music', refetch: 'refresh', bin_album: 'trash', dismiss: 'thumb' };

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
// "17 Sep 2026": when a side's files arrived (their newest mtime). Own month names, since
// the locale's short September is "Sept" on some browsers and "Sep" on others.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso, time = false) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}${time ? `, ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
};
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const isNew = (i) => state.previous_check && i.first_seen > state.previous_check;
const stagedOf = (id) => (state.staged || []).find((e) => e.id === id);
// a staged album leaves its queue for the Staged tab until it is approved or unstaged
const queueOf = (i) => (stagedOf(i.id) ? 'staged' : i.queue);
const stagedName = (e) => (DECISION_TEXT[e.decision] || [e.decision])[0];
const stagedText = (e) => stagedName(e) + (e.release ? ` · ${e.release}` : '');

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
  const staged = items.filter((i) => stagedOf(i.id)).length;
  const ready = items.filter((i) => queueOf(i) === 'ready').length;
  const binBytes = state.bin.reduce((n, e) => n + e.bytes, 0);
  const stat = (n, label, to) => (to
    ? `<button class="stat" data-goto="${to}"><b>${n}</b>${label}</button>`
    : `<span class="stat"><b>${n}</b>${label}</span>`);
  $('status').innerHTML = `<span class="when">${ic('clock')}Checked ${esc(ago(state.checked))}</span>`
    + (fresh ? `<span class="stat fresh"><b>${fresh}</b>new</span>` : '')
    + stat(ready, 'ready', 'ready')
    + stat(items.length - ready - staged, 'to review')
    + (staged ? stat(staged, 'staged', 'staged') : '')
    + ((state.downloads || []).length ? stat(state.downloads.length, 'downloads', 'downloads') : '');
  $('status').querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.goto;
      localStorage.setItem('sift-tab', tab);
      // through the hash, so an open album is left properly and its keys stop acting on it
      if ((location.hash || '#/') !== '#/') location.hash = '#/';
      else { renderList(); window.scrollTo(0, 0); }
    };
  });
  $('binlink').textContent = state.bin.length ? `Bin (${gb(binBytes)})` : 'Bin';
}

// Follows the running job to its end and returns it, or null if it can't be followed. A
// second call while one is watching waits on the same one.
let polling = null;
function watchJob() {
  if (!polling) polling = followJob().finally(() => { polling = null; checking(false); });
  return polling;
}
async function followJob() {
  const bar = $('jobbar');
  $('jobspin').hidden = false;
  $('jobclose').hidden = true;
  $('joboutput').hidden = true;
  // the server restarted (it forgets its job) or can't be reached: stop following, and show
  // whatever the engine got done
  const lost = async (why) => {
    $('jobspin').hidden = true;
    afterJob = null;
    approving.clear();
    $('joblabel').textContent = why;
    bar.hidden = false;
    $('jobclose').hidden = false;
    await loadState().catch(() => {});
    route();
    return null;
  };
  let misses = 0;
  for (;;) {
    let job;
    try {
      ({ job } = await api('/api/job'));
      misses = 0;
    } catch (e) {
      if (e.message === 'signed out') throw e;
      if (++misses >= 10) return lost('Lost touch with Sift. Reload the page; History says how the job went.');
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!job) return lost('Sift restarted while that ran. History says how far it got.');
    // a check says so in its own button; a failure is a toast, and the error is kept in History
    const inline = job.kind === 'check';
    checking(inline && !job.done);
    bar.hidden = inline;
    $('joblabel').textContent = job.label + (job.done ? (job.ok ? ' — done' : ' — failed') : '…');
    if (job.kind === 'apply-staged') followApproval(job);
    if (job.done) {
      $('jobspin').hidden = true;
      await loadState();
      if (job.ok && afterJob) { const go = afterJob; afterJob = null; location.hash = go; }
      if (!job.ok) afterJob = null;
      if (job.ok && /^skipped /m.test(job.output)) {
        // some went ahead and some didn't: keep the bar open with what was skipped
        bar.hidden = false;
        $('joboutput').textContent = job.output;
        $('joboutput').hidden = false;
        $('jobclose').hidden = false;
      } else if (job.ok) {
        setTimeout(() => { bar.hidden = true; }, 2500);
        if (job.kind === 'art' || job.kind === 'art-many') artStamp = `?v=${Date.now().toString(36)}`;
        const note = { 'art-many': 'Artwork written. Each album can be undone from the bin.', 'empty-bin': 'Bin emptied.', 'apply-staged': 'Approved. Each one can be undone from the bin.', art: 'Artwork written. Undo is in the bin.',
          undo: 'Undone. The album may take a few minutes to reappear, while Lidarr rescans.',
          download_import: 'Imported. The album is in Arriving until Sift checks it.', download_import_anyway: 'Imported. The album is in Arriving until Sift checks it.',
          download_add: 'Added to Lidarr, unmonitored, and the folder checked against it again.', download_release: 'Release changed, and the folder checked again.',
          download_keep: 'Kept, in the Roon library. Undo is in the bin.', download_bin: 'The download is in the bin.' }[job.kind];
        if (note) toast(note);
      } else if (inline) {
        toast('The check failed. History has the error.');
      } else {
        $('joboutput').textContent = job.output;
        $('joboutput').hidden = false;
        $('jobclose').hidden = false;
      }
      route();
      return job;
    }
    await new Promise((r) => setTimeout(r, approving.size ? 600 : 1500));
  }
}
$('jobclose').onclick = () => { $('jobbar').hidden = true; };

// Update becomes the progress: a spinner and 'Updating…' while the check runs
let checkHtml = null;
function checking(on) {
  const b = $('check');
  if (checkHtml === null) checkHtml = b.innerHTML;
  if (on === b.classList.contains('busy')) return;
  b.classList.toggle('busy', on);
  b.disabled = on;
  b.innerHTML = on ? `<span class="spinner"></span>Updating…` : checkHtml;
}

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
  if (i.download) {
    // a download: no cover-side badges, no picking; the row opens the download's own page
    if (i.kind === 'flac' || i.kind === 'mp3') badges.push(`<span class="badge ${i.kind}">${i.kind.toUpperCase()} ${esc(i.fmt)} · ${i.n}</span>`);
    else badges.push(`<span class="badge warn">${i.kind === 'mixed' ? 'FLAC and MP3 mixed' : 'no audio'}</span>`);
    if (i.busy) badges.push('<span class="badge warn">downloading</span>');
    if (i.damaged) badges.push(`<span class="badge bad">${i.damaged} damaged</span>`);
    if (i.allowed.includes('import')) badges.push('<span class="badge decision">ready to import</span>');
    if (i.failed && i.failed.length) badges.push(`<span class="badge warn">${i.failed.length} missing</span>`);
    if (i.source) badges.push(`<span class="badge">from ${esc(i.source.user)}</span>`);
    return `<a class="row" href="#/download/${i.id}">${i.cover ? `<img class="thumb" src="/api/cover/${i.id}" alt="" loading="lazy">` : '<span class="thumb none"></span>'}
      <span class="rtext"><span class="rtitle">${esc(i.artist)} — ${esc(i.title)}</span>
      <span class="rreason">${esc((i.reasons || [])[0] || '')}</span>
      <span class="badges">${badges.join('')}</span></span></a>`;
  }
  if (i.artwork) {
    // the suggestion is the row's picture, so the list can be looked over before using them
    const pic = suggested(i) ? `<img class="thumb" src="/api/artwork/${i.id}/pic/${i.found.pick}" alt="" loading="lazy">` : '<span class="thumb none"></span>';
    badges.push(`<span class="badge flac">${i.n} file${i.n === 1 ? '' : 's'}</span>`);
    if (i.year) badges.push(`<span class="badge">${esc(i.year)}</span>`);
    if (suggested(i)) badges.push('<span class="badge decision">suggestion</span>');
    else if (i.found && i.found.state === 'skipped') badges.push('<span class="badge muted">skipped</span>');
    else if (i.found) badges.push('<span class="badge warn">choose one</span>');
    const text = `${pic}<span class="rtext"><span class="rtitle">${esc(i.artist)} — ${esc(i.title)}</span>
      <span class="rreason">${esc(i.reasons[0])}</span>
      <span class="badges">${badges.join('')}</span></span>`;
    if (selecting) {
      return `<label class="row picking"><input type="checkbox" class="pick" data-pick="${i.id}" ${selected.has(i.id) ? 'checked' : ''}
        aria-label="Select ${esc(i.artist)} — ${esc(i.title)}">${text}</label>`;
    }
    return `<a class="row" href="#/art/${i.id}">${text}</a>`;
  }
  if (isNew(i)) badges.push('<span class="badge new">new</span>');
  if (i.flac) badges.push(`<span class="badge flac">FLAC ${esc(i.flac.fmt)} · ${i.flac.n}</span>`);
  if (sortBy === 'arrived' && i.flac && i.flac.imported) badges.push(`<span class="badge" title="When the FLAC arrived">got ${day(i.flac.imported)}</span>`);
  if (i.mp3) badges.push(`<span class="badge mp3">MP3 ${esc(i.mp3.fmt)} · ${i.mp3.n}</span>`);
  if (i.refetched) badges.push(`<span class="badge${i.refetched.checked ? '' : ' warn'}" title="Sent back to Soularr from Library health">Refetched ${day(i.refetched.on)}</span>`);
  else if (i.no_mp3) badges.push('<span class="badge warn">No MP3 to replace</span>');
  if (i.flac && i.flac.damaged) badges.push(`<span class="badge bad">${i.flac.damaged} damaged</span>`);
  if (i.suspect) badges.push(`<span class="badge bad">FLAC stops at ${khz(i.suspect.hz)}</span>`);
  const inner = `${i.cover ? `<img class="thumb" src="/api/cover/${i.id}" alt="" loading="lazy">` : '<span class="thumb none"></span>'}
    <span class="rtext"><span class="rtitle">${esc(i.artist)} — ${esc(i.title)}</span>
    <span class="rreason">${esc((i.diagnosis && i.diagnosis.text) || (i.reasons || [])[0] || '')}</span>
    <span class="badges">${badges.join('')}</span></span>`;
  const st = stagedOf(i.id);
  if (st) {
    return `<div class="row stagedrow"><input type="checkbox" class="approvepick" data-approve="${i.id}" ${unticked.has(i.id) ? '' : 'checked'}
      aria-label="Approve ${esc(i.artist)} — ${esc(i.title)}"><a class="rlink" href="#/album/${i.id}">${inner.replace('<span class="badges">',
        `<span class="badges"><span class="badge decision">${esc(stagedName(st))}</span>`)}</a>
      <button class="ghost small" data-unstage="${i.id}" aria-label="Remove from Staged" title="Remove from Staged">${ic('x')}<span class="lbl">Remove</span></button>
      ${st.release ? `<p class="rdetail">Release: ${esc(st.release)}</p>` : ''}</div>`;
  }
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
        <input type="search" id="search" placeholder="Search" autocomplete="off" aria-label="Search">
        <select id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, [name]]) => `<option value="${k}">${name}</option>`).join('')}</select>
        <button id="selecting" class="ghost"></button>
      </div>
      <nav class="jump" id="jump" role="tablist" aria-label="Queues"></nav><div id="queues"></div>`;
    $('search').value = search;
    $('search').oninput = () => { search = $('search').value; renderList(); };
    $('sort').value = sortBy;
    $('sort').onchange = () => { sortBy = $('sort').value; localStorage.setItem('sift-sort', sortBy); renderList(); };
    $('selecting').onclick = () => { selecting = !selecting; selected.clear(); renderList(); };
  }
  $('selecting').innerHTML = selecting ? `${ic('x')}Cancel` : `${ic('select')}Select`;
  const byQueue = (key) => allItems().filter((i) => queueOf(i) === key && matches(i))
    .sort((x, y) => (key === 'artwork' ? artRank(x) - artRank(y) : 0) || SORTS[sortBy][1](x, y));
  const shown = [];
  for (const [key, name, blurb] of QUEUES) {
    const items = byQueue(key);
    if (!items.length && (key !== 'ready' || search)) continue;
    shown.push({ key, name, blurb, items });
  }
  // one queue at a time, behind tabs; stay on the remembered one while it has albums
  const cur = shown.find((q) => q.key === tab) || shown[0];
  $('jump').innerHTML = shown.map(({ key, name, items }) =>
    `<button type="button" role="tab" data-tab="${key}" aria-selected="${key === cur.key}">${esc(SHORT[key] || name)} <span class="count">${items.length}</span></button>`).join('');
  if (!cur) {
    $('queues').innerHTML = search ? '<p class="empty">No album matches.</p>' : '';
  } else {
    const { key, name, blurb, items } = cur;
    // Stage all is for the albums an MP3 confirms; one with no MP3 to replace is decided on its own
    const confirmed = items.filter((i) => !i.no_mp3);
    const head = `<div class="qhead"><h2>${name} <span class="count">${items.length}</span></h2>`
      + (selecting && items.length && !['staged', 'downloads'].includes(key) ? `<span class="qpicks">${key === 'artwork' ? ARTWORK_PICKS.filter(([, , f]) => items.some(f))
        .map(([k, name]) => `<button class="ghost small" data-artpick="${k}">${name}</button>`).join('') : ''}<button class="ghost small" data-all="${key}">${ic('checks')}Select all</button></span>` : '')
      + (!selecting && !search && key === 'ready' && confirmed.length ? `<button class="primary" id="approve">${ic('layers')}Stage all ${confirmed.length}</button>` : '')
      + (key === 'staged' && items.length ? `<button class="primary" id="applystaged"></button>` : '')
      + '</div>';
    $('queues').innerHTML = `<section class="queue" id="q-${key}" role="tabpanel">${head}<p class="blurb">${blurb}</p>`
      + (key === 'artwork' ? artworkTools(items) : '')
      + (items.length ? items.map(row).join('') : '<p class="empty">Nothing waiting.</p>') + '</section>';
  }
  const tabs = [...view.querySelectorAll('[data-tab]')];
  tabs.forEach((b, n) => {
    b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1;
    b.onclick = () => { tab = b.dataset.tab; localStorage.setItem('sift-tab', tab); renderList(); window.scrollTo(0, 0); };
    b.onkeydown = (ev) => {                       // arrows move between tabs, as a tablist should
      const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
      if (!step) return;
      ev.preventDefault(); ev.stopPropagation();
      tabs[(n + step + tabs.length) % tabs.length].click();
      $('jump').querySelector('[aria-selected=true]').focus();
    };
  });
  const on = $('jump').querySelector('[aria-selected=true]');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  view.querySelectorAll('[data-pick]').forEach((c) => {
    c.onchange = () => { const id = Number(c.dataset.pick); if (c.checked) selected.add(id); else selected.delete(id); renderSelection(); };
  });
  view.querySelectorAll('[data-artpick]').forEach((b) => {
    const [, , f] = ARTWORK_PICKS.find(([k]) => k === b.dataset.artpick);
    b.onclick = () => { byQueue('artwork').filter(f).forEach((i) => selected.add(i.id)); renderList(); };
  });
  view.querySelectorAll('[data-all]').forEach((b) => {
    b.onclick = () => { byQueue(b.dataset.all).forEach((i) => { if (!i.download) selected.add(i.id); }); renderList(); };
  });
  const approve = $('approve');
  if (approve) {
    approve.onclick = async () => {
      await stageDecision('/api/approve-ready', {});
    };
  }
  view.querySelectorAll('[data-approve]').forEach((c) => {
    c.onchange = () => { const id = Number(c.dataset.approve); if (c.checked) unticked.delete(id); else unticked.add(id); renderApproveButton(); };
  });
  view.querySelectorAll('[data-unstage]').forEach((b) => {
    b.onclick = async () => {
      try { await api('/api/unstage', { ids: [Number(b.dataset.unstage)] }); } catch (e) { toast(e.message); return; }
      await loadState();
      renderList();
    };
  });
  renderApproveButton();
  renderSelection();
  bindArtworkTools();
}

// ---- missing artwork ---------------------------------------------------------
// The search over every album runs in the server, slowly, for the services' sake; the list
// follows it while it runs. Using the suggestions writes them all as one job.

function artworkTools(items) {
  const j = state.artwork_job;
  const running = j && !j.done;
  const unsearched = (state.artwork || []).filter((a) => !a.found).length;
  const ready = items.filter(suggested);
  const bits = [];
  if (running) bits.push(`<span class="hint"><span class="spinner"></span> ${esc(j.output || 'Starting the search…')}${j.auto ? ' (after the check)' : ''}</span>`, `<button class="ghost small" id="artstop">${ic('x')}Stop</button>`);
  else if (unsearched) bits.push(`<button id="artfind">${ic('image')}Find artwork for ${unsearched === (state.artwork || []).length ? 'all' : `the ${unsearched} not searched`}</button>`);
  if (ready.length) bits.push(`<button class="primary" id="artuse">${ic('checks')}Use ${ready.length} suggestion${ready.length === 1 ? '' : 's'}</button>`);
  if (j && j.done && j.note && !running) bits.push(`<span class="hint">${esc(j.note)}</span>`);
  return bits.length ? `<div class="tools arttools">${bits.join('')}</div>` : '';
}

function bindArtworkTools() {
  if ($('artfind')) {
    $('artfind').onclick = async () => {
      const n = (state.artwork || []).filter((a) => !a.found).length;
      if (!await ask({ title: `Search for ${n} album${n === 1 ? '' : 's'}?`, ok: 'Search',
        body: `About three seconds an album, so roughly ${Math.max(1, Math.round(n * 3 / 60))} min, in the background: you can carry on meanwhile. Nothing is written until you use the suggestions.` })) return;
      try { await api('/api/artwork/find-all', {}); } catch (e) { toast(e.message); return; }
      await loadState();
      renderList();
      followArtworkSearch();
    };
  }
  if ($('artstop')) $('artstop').onclick = async () => { await api('/api/artwork/stop', {}).catch(() => {}); };
  if ($('artuse')) {
    $('artuse').onclick = async () => {
      const ids = allItems().filter((i) => i.artwork && matches(i) && suggested(i)).map((i) => i.id);
      if (!await ask({ title: `Write ${ids.length} picture${ids.length === 1 ? '' : 's'}?`, ok: 'Write artwork',
        body: 'Each suggested picture becomes the embedded picture in its album\'s files, with a cover.jpg beside them. '
          + 'Open any that looks wrong first and choose another, or Skip it. Each album gets its own bin entry, so each can be undone.' })) return;
      afterJob = null;
      run('/api/artwork/use-suggested', { ids });
    };
  }
  if (state.artwork_job && !state.artwork_job.done) followArtworkSearch();
}

// while the search over every album runs, the list and its progress line keep up
let artFollowing = false;
async function followArtworkSearch() {
  if (artFollowing) return;
  artFollowing = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      if (polling) continue;
      try { await loadState(); } catch { break; }
      if ((location.hash || '#/') === '#/' && tab === 'artwork' && !$('dialog').open) {
        const y = window.scrollY;
        renderList();
        window.scrollTo(0, y);
      }
      if (!state.artwork_job || state.artwork_job.done) break;
    }
  } finally { artFollowing = false; }
}

const SOURCE_NOTE = { 'Cover Art Archive': 'MusicBrainz', Apple: 'Apple Music', Deezer: 'Deezer' };
// id is a Missing artwork album's, or q<id> for an album in the queue, d<id> for a download:
// those come from their Set artwork, and go back there once a picture is written
async function renderArtwork(id, search = false) {
  let a;
  const page = { q: '#/album/', d: '#/download/' }[String(id)[0]];
  try { a = await api(`/api/artwork/${id}`); } catch {
    if (location.hash !== `#/art/${id}`) return;
    view.innerHTML = page ? `<p class="empty">This album is no longer listed. <a href="#/">Back to the list</a></p>`
      : '<p class="empty">This album is no longer missing artwork. <a href="#/">Back to the list</a></p>';
    return;
  }
  if (location.hash !== `#/art/${id}`) return;
  const missing = a.kind === 'artwork';
  const back = missing ? '#/' : `${page}${a.id}`;
  document.title = `${a.title} · Sift`;
  const pick = a.pick != null && a.state === 'suggested' ? a.pick : null;
  const card = (c) => `<figure class="artcand${c.n === pick ? ' picked' : ''}">
      <img src="/api/artwork/${a.key}/pic/${c.n}" alt=""${esc(`${c.album} by ${c.artist}`)}" loading="lazy">
      <figcaption><b>${c.w} × ${c.h}</b> · ${esc(SOURCE_NOTE[c.source] || c.source)}
        ${c.sure ? '<span class="badge decision">this release</span>' : c.same ? '<span class="badge">same title</span>' : '<span class="badge warn">another title?</span>'}
        ${c.n === pick ? '<span class="badge new">suggested</span>' : ''}
        <span class="artname">${esc(c.album)}${c.artist ? ` — ${esc(c.artist)}` : ''}</span></figcaption>
      <button class="${c.n === pick ? 'primary' : ''}" data-use="${c.n}">${ic('check')}Use this</button></figure>`;
  const found = !a.searched ? '<p class="empty">Not searched yet.</p>'
    : a.cands.length ? `<div class="artgrid">${a.cands.map(card).join('')}</div>`
      : '<p class="empty">Nothing hi-res found online.</p>';
  // the picture there now, if any, else the suggestion
  const cover = a.cover && !missing ? `<img class="cover" src="/api/cover/${a.id}${artStamp}" alt="">`
    : pick != null ? `<img class="cover" src="/api/artwork/${a.key}/pic/${pick}" alt="">`
    : a.cover ? `<img class="cover" src="/api/cover/${a.id}${artStamp}" alt="">` : '<span class="cover none"></span>';
  // Missing artwork steps through its list, in the list's order
  const item = missing && allItems().find((i) => i.id === a.id && queueOf(i) === 'artwork');
  const near = item ? neighbours(item) : { at: -1 };
  const step = (to, sid, label) => (to ? `<a class="button ghost small" id="${sid}" href="#/art/${to.id}">${label}</a>`
    : `<button class="ghost small" id="${sid}" disabled>${label}</button>`);
  const pager = near.at >= 0 && near.of > 1 ? `<span class="pager">${step(near.prev, 'earlier', `${ic('previous')}Previous`)}
    <span class="muted">${near.at + 1} of ${near.of}</span>${step(near.next, 'later', `Next album${ic('next')}`)}</span>` : '';
  view.innerHTML = `<div class="albumnav"><a href="${back}" class="back">${missing ? '← All albums' : '← Back to the album'}</a>${pager}</div>
    <div class="ahead">
      ${cover}
      <div><p class="qname">${missing ? 'Missing artwork' : 'Artwork online'}</p><h2>${esc(a.title)}</h2><p class="artist">${esc(a.artist)}</p>
      <p class="totals">${a.n} file${a.n === 1 ? '' : 's'}${a.year ? ` · ${esc(a.year)}` : ''} · ${missing ? 'Roon FLAC library' : a.kind === 'album' ? 'review queue' : 'download'}</p></div>
    </div>
    <p class="diag">${missing ? 'No picture beside the files or in them.' : a.cover ? 'Whatever picture is there now goes in the bin when one is written.' : 'No picture yet.'} Choose one found online, or drop a JPEG or PNG on this page.
      Only pictures at least 1000 px are offered; ${a.small ? `${a.small} smaller one${a.small === 1 ? ' was' : 's were'} left out` : 'the picture is written at 1500 px at most'}.</p>
    <div class="tools">
      <button id="artsearch"${search ? ' disabled' : ''}>${search ? '<span class="spinner"></span>Searching…' : `${ic('refresh')}${a.searched ? 'Search again' : 'Find artwork online'}`}</button>
      <button id="tart">${ic('image')}Set artwork from a file</button>
      ${a.searched && missing ? `<button class="ghost" id="artskip">${a.state === 'skipped' ? `${ic('undo')}Suggest again` : `${ic('x')}Skip`}</button>` : ''}
      ${a.searched ? `<span class="hint">Searched ${esc(ago(a.searched))}.${missing && a.state === 'skipped' ? ' Skipped: Use suggestions leaves it out.' : ''}</span>` : ''}
    </div>
    ${found}`;
  artTarget = { id: a.id, files: a.n, label: `${a.artist} — ${a.title}` };
  $('tart').onclick = () => $('artfile').click();
  $('artsearch').onclick = async () => {
    renderArtwork(id, true);
    try { await api('/api/artwork/find', { id: a.key, again: !!a.searched }); } catch (e) { toast(e.message); }
    if (location.hash === `#/art/${id}`) { await loadState().catch(() => {}); renderArtwork(id); }
  };
  if ($('artskip')) {
    $('artskip').onclick = async () => {
      try { await api('/api/artwork/skip', { id: a.id, on: a.state !== 'skipped' }); } catch (e) { toast(e.message); return; }
      await loadState().catch(() => {});
      renderArtwork(id);
    };
  }
  view.querySelectorAll('[data-use]').forEach((b) => {
    b.onclick = async () => {
      const c = a.cands[Number(b.dataset.use)];
      if (!await ask({ title: 'Write this picture into the files?', ok: 'Write artwork',
        body: `The ${c.w} × ${c.h} picture from ${SOURCE_NOTE[c.source] || c.source} becomes the embedded picture in ${a.n} file${a.n === 1 ? '' : 's'} of ${a.artist} — ${a.title}, and a cover.jpg beside them. This can be undone from the bin.` })) return;
      if (location.hash !== `#/art/${id}`) return;
      if (missing) { tab = 'artwork'; localStorage.setItem('sift-tab', tab); }
      afterJob = back;
      releaseAudio();
      run('/api/artwork/use', { id: a.key, n: c.n });
    };
  });
  if (!a.searched && !search) $('artsearch').click();     // opening an unsearched album searches it
}

// Approving is the step that moves files: it confirms, naming what each decision will do.
function renderApproveButton() {
  const b = $('applystaged');
  if (!b) return;
  const go = state.staged.filter((e) => !unticked.has(e.id));
  b.innerHTML = `${ic('checks')}Approve ${go.length}`;
  b.disabled = !go.length;
  b.onclick = async () => {
    const counts = {};
    for (const e of go) counts[e.decision] = (counts[e.decision] || 0) + 1;
    const body = Object.entries(counts).map(([d, n]) => `${DECISION_TEXT[d][0]}: ${n}`).join(' · ')
      + '. Each album gets its own bin entry, so each can be undone on its own.';
    const ok = await ask({ title: `Approve ${go.length} decision${go.length === 1 ? '' : 's'}?`, body, ok: 'Approve' });
    if (!ok) return;
    go.forEach((e) => { unticked.delete(e.id); approving.add(e.id); });
    view.querySelectorAll('.stagedrow').forEach((r) => {
      if (approving.has(Number(r.querySelector('[data-approve]').dataset.approve))) r.classList.add('queued');
    });
    $('applystaged').disabled = true;
    run('/api/apply-staged', { ids: go.map((e) => e.id) });
  };
}

// While an approval runs, each staged row follows the engine's per-album lines: waiting,
// working, then gone once done; a skipped one stays, saying why, until the job ends.
function followApproval(job) {
  const lines = String(job.output || '').split('\n');
  const seen = new Map();
  for (const l of lines) {
    const m = /^(working|done|skipped) \[(\d+)\]/.exec(l);
    if (m) seen.set(Number(m[2]), { what: m[1], why: m[1] === 'skipped' ? l.slice(l.lastIndexOf(': ') + 2) : '' });
  }
  for (const r of view.querySelectorAll('.stagedrow')) {
    const id = Number(r.querySelector('[data-approve]').dataset.approve);
    if (!approving.has(id)) continue;
    const s = seen.get(id);
    r.classList.toggle('working', !!s && s.what === 'working');
    if (s && s.what === 'done' && !r.classList.contains('gone')) {
      r.style.height = `${r.offsetHeight}px`;
      void r.offsetHeight;                                  // start the collapse from its real height
      r.classList.add('gone');
      setTimeout(() => r.remove(), 450);
      for (const n of [view.querySelector('#q-staged .qhead .count'), view.querySelector('[data-tab="staged"] .count')]) {
        if (n) n.textContent = String(Math.max(0, Number(n.textContent) - 1));
      }
    }
    if (s && s.what === 'skipped' && !r.classList.contains('failed')) {
      r.classList.add('failed');
      r.querySelector('.rreason').textContent = `Skipped: ${s.why}`;
    }
  }
  if (job.done) approving.clear();
}

// Staging only records a decision, so it doesn't ask first; approving does.
async function stageDecision(path, body, next) {
  let r;
  try { r = await api(path, body); } catch (e) { toast(e.message); return false; }
  await loadState();
  toast(`Staged ${r.staged === 1 ? 'a decision' : `${r.staged} decisions`}. Approve in the Staged tab.`);
  if (next !== undefined) location.hash = next; else route();
  return true;
}

// the bar of decisions for the albums ticked in Select mode
function renderSelection() {
  const bar = $('selbar');
  const onList = (location.hash || '#/') === '#/';
  const known = new Set([...state.items, ...(state.artwork || [])].map((i) => i.id));
  for (const id of selected) if (!known.has(id)) selected.delete(id);
  bar.hidden = !(selecting && onList);
  if (bar.hidden) return;
  // the Missing artwork tab has its own actions; the album decisions are for the other tabs
  const onArt = !!$('q-artwork');
  bar.querySelectorAll('[data-many]').forEach((b) => { b.hidden = onArt; });
  bar.querySelectorAll('[data-art]').forEach((b) => { b.hidden = !onArt; });
  if (onArt) { renderArtSelection(); return; }
  const picked = state.items.filter((i) => selected.has(i.id));
  $('selcount').textContent = `${picked.length} selected`;
  bar.querySelectorAll('[data-many]').forEach((b) => {
    const d = b.dataset.many;
    const n = picked.filter((i) => (i.allowed || []).includes(d)).length;
    b.innerHTML = `${ic(DECISION_ICON[d])}${DECISION_TEXT[d][0]}${n && n !== picked.length ? ` (${n})` : ''}`;
    b.disabled = !n;
    b.onclick = async () => {
      const ids = picked.filter((i) => i.allowed.includes(d)).map((i) => i.id);
      selecting = false;
      selected.clear();
      await stageDecision('/api/decide-many', { decision: d, ids });
    };
  });
}
$('selcancel').onclick = () => { selecting = false; selected.clear(); renderList(); };

// the ticked Missing artwork albums: search them, use their suggestions, skip them or not
function renderArtSelection() {
  const picked = allItems().filter((i) => i.artwork && selected.has(i.id));
  $('selcount').textContent = `${picked.length} selected`;
  const n = (list) => (list.length && list.length !== picked.length ? ` (${list.length})` : '');
  const done = async (ok) => { selecting = false; selected.clear(); await loadState().catch(() => {}); renderList(); if (ok) toast(ok); };
  const acts = {
    use: [picked.filter(suggested), 'checks', 'Use suggestions', async (list) => {
      if (!await ask({ title: `Write ${list.length} picture${list.length === 1 ? '' : 's'}?`, ok: 'Write artwork',
        body: "Each suggested picture becomes the embedded picture in its album's files, with a cover.jpg beside them. "
          + 'Each album gets its own bin entry, so each can be undone.' })) return;
      selecting = false; selected.clear(); afterJob = null;
      run('/api/artwork/use-suggested', { ids: list.map((i) => i.id) });
    }],
    find: [picked, 'refresh', picked.length && picked.every((i) => i.found) ? 'Search again' : 'Find artwork', async (list) => {
      try { await api('/api/artwork/find-all', { ids: list.map((i) => i.id) }); } catch (e) { toast(e.message); return; }
      await done(`Searching ${list.length} album${list.length === 1 ? '' : 's'}${state.artwork_job && !state.artwork_job.done ? ', ahead of the rest' : ''}. Suggestions appear as they are found.`);
      followArtworkSearch();
    }],
    skip: [picked.filter((i) => i.found && i.found.state !== 'skipped'), 'x', 'Skip', async (list) => {
      try { await api('/api/artwork/skip', { ids: list.map((i) => i.id), on: true }); } catch (e) { toast(e.message); return; }
      done(`Skipped ${list.length}: Use suggestions leaves ${list.length === 1 ? 'it' : 'them'} out.`);
    }],
    unskip: [picked.filter((i) => i.found && i.found.state === 'skipped'), 'undo', 'Suggest again', async (list) => {
      try { await api('/api/artwork/skip', { ids: list.map((i) => i.id), on: false }); } catch (e) { toast(e.message); return; }
      done(null);
    }],
  };
  $('selbar').querySelectorAll('[data-art]').forEach((b) => {
    const [list, icon, name, go] = acts[b.dataset.art];
    b.innerHTML = `${ic(icon)}${name}${n(list)}`;
    b.disabled = !list.length;
    if (b.dataset.art === 'unskip') b.hidden = !list.length;    // only once a ticked album is skipped
    b.onclick = () => go(list);
  });
}

// ---- an album ----------------------------------------------------------------

// the albums around this one in its queue, in the list's order and search
function neighbours(a) {
  const key = queueOf(a);
  const list = (key === 'artwork' ? allItems() : state.items).filter((i) => queueOf(i) === key && matches(i))
    .sort((x, y) => (key === 'artwork' ? artRank(x) - artRank(y) : 0) || SORTS[sortBy][1](x, y));
  const k = list.findIndex((i) => i.id === a.id);
  return { prev: k > 0 ? list[k - 1] : null, next: k >= 0 && k < list.length - 1 ? list[k + 1] : null, at: k, of: list.length };
}
let deciding = false;         // a decision being asked about or sent
let afterJob = null;          // where to go once the decision in progress succeeds
let artStamp = '';            // changes when artwork is written, so cover pictures reload

// Artwork Simon drops on an album or download page: confirm, then post the picture's bytes.
// The page-wide drop target is set up once; which id it goes to is whatever page is open.
let artTarget = null;         // { id, files, label } for the page on screen, or null
async function offerArt(file) {
  if (!artTarget || !file) return;
  if (!/^image\/(jpeg|png)$/.test(file.type)) { toast('A JPEG or PNG, please.'); return; }
  const { id, files, label } = artTarget;
  if (!await ask({ title: 'Write this picture into the files?', ok: 'Write artwork',
    body: `${file.name} (${gb(file.size)}) becomes the embedded picture in ${files} file${files === 1 ? '' : 's'} of ${label}, and a cover.jpg beside them. `
      + 'Whatever was there before goes in the bin, so this can be undone.' })) return;
  releaseAudio();
  // a Missing artwork album leaves the list once it has a picture: back to the list after
  if (/^#\/art\/\d/.test(location.hash)) afterJob = '#/';
  else if (/^#\/art\/[qd]/.test(location.hash)) afterJob = location.hash.replace('#/art/q', '#/album/').replace('#/art/d', '#/download/');
  try {
    const r = await fetch(`/api/art/${id}`, { method: 'POST', headers: { 'Content-Type': file.type, 'X-CSRF': csrf || '' }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `failed (${r.status})`);
    watchJob();
  } catch (e) { toast(e.message); }
}
$('artfile').onchange = () => { offerArt($('artfile').files[0]); $('artfile').value = ''; };
document.addEventListener('dragover', (ev) => { if (artTarget) { ev.preventDefault(); document.body.classList.add('dropping'); } });
document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (ev) => {
  document.body.classList.remove('dropping');
  if (!artTarget) return;
  ev.preventDefault();
  offerArt(ev.dataTransfer.files[0]);
});

function buildRows(a) {
  const flac = a.flac ? a.flac.tracks : [];
  const mp3 = a.mp3 ? a.mp3.tracks : [];
  const rows = [];
  if (a.pairs && a.pairs.length) {
    const used = new Set();
    for (const p of a.pairs) {
      rows.push({ m: p.m, f: p.f, sim: p.sim, same: p.same, manual: p.manual });
      if (p.f != null) used.add(p.f);
    }
    flac.forEach((_, f) => { if (!used.has(f)) rows.push({ m: null, f }); });
  } else {
    const n = Math.max(flac.length, mp3.length);
    for (let k = 0; k < n; k++) rows.push({ m: k < mp3.length ? k : null, f: k < flac.length ? k : null });
  }
  return rows;
}

// "3" or, on a side whose tracks span more than one disc, "2-03"; nothing without a tag
function trackNo(tracks, t) {
  if (t.track == null) return '';
  const discs = new Set(tracks.map((x) => x.disc || 1));
  const n = discs.size > 1 ? `${t.disc || 1}-${String(t.track).padStart(2, '0')}` : String(t.track);
  return `<span class="tnum">${n}</span>`;
}

// A truncated file decodes short; a corrupt one decodes whole with garbage where the
// decoder lost its place, so say where rather than a full length that reads as fine.
function damageWhere(t) {
  if (t.decoded_s != null && t.secs && t.decoded_s < t.secs - 1) return ` · decodes to ${clock(t.decoded_s)} of ${clock(t.secs)}`;
  const at = t.bad_at || [];
  if (!at.length) return '';
  return ` · corrupt near ${clock(at[0])}${at.length > 1 ? ` and ${at.length - 1} more place${at.length > 2 ? 's' : ''}` : ''}`;
}

function cell(a, side, idx, rowIdx) {
  if (idx == null) return '<div class="cell empty">—</div>';
  const t = a[side].tracks[idx];
  const damaged = t.damaged ? `<span class="badge bad">damaged${damageWhere(t)}</span>` : '';
  return `<div class="cell"><button class="play" data-side="${side}" data-idx="${idx}" data-row="${rowIdx}" aria-label="Play the ${side === 'flac' ? 'FLAC' : 'MP3'} of ${esc(t.title || t.name)}">${ic('play')}</button>
    <span class="ttext"><span class="ttitle">${trackNo(a[side].tracks, t)}${esc(t.title || t.name)}</span>
    <span class="tmeta">${clock(t.secs)} · ${esc(t.fmt)}${t.cutoff
      ? ` · <span class="${side === 'flac' && t.short ? 'low' : ''}" title="Highest frequency with sound">to ${khz(t.cutoff)}</span>` : ''}${t.lufs != null
      ? ` · <span title="Integrated loudness">${t.lufs.toFixed(1)} LUFS</span>` : ''}</span>${damaged}${(a.dupe || showPaths) && a.paths && a.paths[side][idx]
      ? `<span class="tpath">${esc(a.paths[side][idx])}</span>` : ''}</span></div>`;
}

let mode = 'view';            // view | pair | order | spectra
let picked = null;           // MP3 index chosen in pair mode
let pending = null;          // FLAC order being edited

function matchCell(r, k) {
  if (r.sim == null && !r.manual) return `<div class="match ${r.m != null && r.f == null ? 'diff' : ''}">${r.m != null && r.f == null ? '≠' : ''}</div>`;
  if (r.manual) {
    return `<div class="match same manual" title="Paired by hand">✓<button class="unpair" data-unpair="${r.m}" title="Forget this pair" aria-label="Forget this pair">${ic('x')}</button></div>`;
  }
  return `<div class="match ${r.same ? 'same' : 'diff'}" title="similarity ${r.sim}">${r.same ? '✓' : '≠'}</div>`;
}

function toolbar(a) {
  const hasBoth = a.mp3 && a.flac && a.flac.tracks.length;
  if (mode === 'pair') {
    return `<div class="tools"><span class="hint">${picked == null ? 'Tap an MP3 track, then the FLAC track it matches.'
      : 'Now tap the FLAC track that matches it.'}</span><button id="tdone" class="primary">${ic('check')}Done</button></div>`;
  }
  if (mode === 'spectra') {
    return `<div class="tools"><span class="hint">Each track's spectrum, MP3 on the left, FLAC on the right. A FLAC made from an MP3 goes dark at the same height as the MP3. Tap a picture to see it full size.</span>
      <button id="tcancel" class="primary">${ic('check')}Done</button></div>`;
  }
  if (mode === 'order') {
    const dirty = pending.some((v, k) => v !== k);
    return `<div class="tools"><span class="hint">Move FLAC tracks with the arrows. Saving renumbers and renames the files.</span>
      ${a.mp3 ? `<button id="tmatch">${ic('sort')}Match MP3 order</button>` : ''}
      <button id="tsave" class="primary" ${dirty ? '' : 'disabled'}>${ic('save')}Save order</button><button id="tcancel" class="ghost">${ic('check')}Done</button></div>`;
  }
  const b = [];
  if (a.flac && a.flac.tracks.length) b.push(`<button id="tspectra">${ic('wave')}Spectrograms</button>`);
  if (hasBoth) b.push(`<button id="tpair" class="${a.diagnosis && a.diagnosis.suggest === 'pair' ? 'primary' : ''}">${ic('link')}Pair tracks by hand</button>`);
  if (a.flac && a.flac.tracks.length && a.reorder) b.push(`<button id="torder">${ic('list')}Edit FLAC tracks</button>`);
  if (a.flac && a.flac.tracks.length && !a.flac.tracks.some((t) => t.damaged)) b.push(`<a class="button" id="tartweb" href="#/art/q${a.id}">${ic('image')}Edit artwork</a>`);
  if (a.foreign || a.one_album) {
    b.push(`<button id="tone">${ic('folder')}${a.one_album ? 'Undo "folder is all one album"' : 'This folder is all one album'}</button>`);
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
  ['Downloaded', (d) => day(d.imported, true)],
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
    const differ = label !== 'Downloaded' && F && M && fv && mv && String(fv).toLowerCase() !== String(mv).toLowerCase();
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
        <span class="arrows"><button data-up="${k}" ${k === 0 ? 'disabled' : ''} aria-label="Move up">${ic('up')}</button>
        <button data-down="${k}" ${k === pending.length - 1 ? 'disabled' : ''} aria-label="Move down">${ic('down')}</button>
        <button data-bin="${f}" class="binbtn" aria-label="Put this track in the bin" title="Put this track in the bin">${ic('trash')}</button></span></div>`;
    rows.push(`<div class="trow"><span class="pos">${k + 1}</span>
      ${a.mp3 && k < a.mp3.tracks.length ? cell(a, 'mp3', k, -1) : '<div class="cell empty">—</div>'}
      ${right}</div>`);
  }
  return `<div class="tracks ordering"><div class="thead"><div></div><div>MP3, in file order</div><div>FLAC, new order</div></div>${rows.join('')}</div>`;
}

async function renderAlbum(id, keepMode = false) {
  let a;
  try { a = await api(`/api/album/${id}`); } catch {
    if (location.hash !== `#/album/${id}`) return;
    view.innerHTML = '<p class="empty">This album is no longer in the queue. <a href="#/">Back to the list</a></p>';
    return;
  }
  if (location.hash !== `#/album/${id}`) return;       // left while it loaded: don't draw over where we are
  if (!keepMode || !album || album.id !== a.id) { mode = 'view'; picked = null; }
  album = { ...a, rows: buildRows(a) };
  if (mode === 'order' && (!pending || pending.length !== a.flac.tracks.length)) pending = a.flac.tracks.map((_, k) => k);
  document.title = `${a.artist} — ${a.title} · Sift`;
  const qname = (QUEUES.find((q) => q[0] === a.queue) || [])[1] || a.queue;
  // duplicates and library health aren't Lidarr's to begin with, so a re-fetch says whether
  // Lidarr-FLAC has the album to search for
  const kept = a.dupe ? ' and the MP3 stays' : '';
  const refetchText = ['Get a better FLAC', a.lidarr_flac
    ? `The FLAC goes in the bin${kept}. Lidarr-FLAC has this album${a.lidarr_flac.monitored ? ', already monitored,' : ''} and Soularr will look for another copy, which comes back through the review queue.`
    : `The FLAC goes in the bin${kept}. Lidarr-FLAC doesn't have this album (usually because MusicBrainz doesn't), so nothing will look for another copy: this is the same as ${a.dupe ? 'Keep MP3' : 'Put in the bin'} for now.`];
  // nothing was found to replace, so Keep FLAC bins nothing: say so rather than promise a retirement
  const keepFlacText = ['Keep FLAC', 'The FLAC moves into the Roon FLAC library. There is no MP3 of it to bin, '
    + 'so check this is an album you meant to have before keeping it.'];
  // a refetched album replaces a library copy that is already in the bin
  const againText = ['Keep FLAC', 'The FLAC moves into the Roon FLAC library, in place of the copy it replaced, which is already in the bin.'];
  const binText = ['Put in the bin', "The FLAC goes in the bin, nothing replaces it, and Soularr won't fetch it again. "
    + 'Undo is in the bin, and Watch puts it back on the wanted list.'];
  const texts = a.dupe ? { ...DUPE_TEXT, refetch: refetchText } : a.health ? { ...DECISION_TEXT, refetch: refetchText }
    : a.refetched ? { ...DECISION_TEXT, keep_flac: againText, bin_album: binText }
    : a.no_mp3 ? { ...DECISION_TEXT, keep_flac: keepFlacText, bin_album: binText } : DECISION_TEXT;
  const diag = a.diagnosis;
  // with a diagnosis, only its suggestion is highlighted, or nothing when it says listen first
  const primary = diag ? (a.allowed.includes(diag.suggest) ? diag.suggest : null) : a.no_mp3 ? null : 'keep_flac';
  const buttons = ['keep_flac', 'keep_mp3', 'refetch', 'bin_album', 'dismiss'].filter((d) => a.allowed.includes(d))
    .map((d) => `<button class="${d === primary || (a.health && d === 'dismiss') ? 'primary' : ''}" data-decide="${d}">${ic(DECISION_ICON[d])}${texts[d][0]}${diag && diag.suggest === d ? ' <span class="sugg">suggested</span>' : ''}</button>`);
  const near = neighbours(a);
  const step = (to, id, label) => (to ? `<a class="button ghost small" id="${id}" href="#/album/${to.id}">${label}</a>`
    : `<button class="ghost small" id="${id}" disabled>${label}</button>`);
  const pager = near.at >= 0 && near.of > 1 ? `<span class="pager">${step(near.prev, 'earlier', `${ic('previous')}Previous`)}
    <span class="muted">${near.at + 1} of ${near.of}</span>${step(near.next, 'later', `Next album${ic('next')}`)}</span>` : '';
  const watch = a.allowed.includes('watch')
    ? `<label class="switch"><input type="checkbox" role="switch" id="watch" ${a.watch ? 'checked' : ''}><span>Watch for a better copy</span></label>` : '';
  const got = (side) => { const d = day(((a[side] || {}).details || {}).imported); return d ? ` · got ${d}` : ''; };
  const totals = [a.mp3 ? `MP3 ${clock(a.mp3.seconds)} · ${a.mp3.tracks.length} tracks${got('mp3')}` : (a.health ? 'In the FLAC library' : a.refetched ? 'Refetched' : 'No MP3'),
    `FLAC ${clock(a.flac.seconds)} · ${a.flac.tracks.length} tracks${got('flac')}`].join('  vs  ');

  view.innerHTML = `<div class="albumnav"><a href="#/" class="back">← All albums</a>${pager}</div>
    <div class="ahead">
      ${a.cover ? `<img class="cover" src="/api/cover/${a.id}${artStamp}" alt="">` : '<span class="cover none"></span>'}
      <div><p class="qname">${esc(qname)}</p><h2>${esc(a.title)}</h2><p class="artist">${esc(a.artist)}</p>
      <p class="totals">${esc(totals)}</p></div>
    </div>
    ${stagedOf(a.id) ? `<p class="stagednote">Staged: <b>${esc(stagedText(stagedOf(a.id)))}</b>. Nothing has moved yet. <button class="ghost small" id="unstage">${ic('x')}Remove</button></p>` : ''}
    ${diag ? `<p class="diag">${esc(diag.text)}</p>` : ''}
    <ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${a.source ? `<p class="source">From Soulseek user <b>${esc(a.source.user)}</b>${a.source.albums > 1 ? ` · ${a.source.albums} albums from them waiting here` : ''}${a.source.bad
      ? ` · <span class="bad">${a.source.bad} suspect or damaged</span>` : ''}${a.source.blocked ? ' · blocked'
      : ` <button id="block" class="ghost small">${ic('ban')}Block this user</button>`}</p>` : ''}
    ${mode === 'view' ? releaseFacts(a) : ''}
    <div class="decisions">${mode === 'view' ? buttons.join('') : ''}</div>
    ${mode === 'view' ? watch : ''}
    ${toolbar(a)}
    ${mode === 'order' ? orderTable(a) : alignedTable(a)}`;

  const facts = $('facts');
  if (facts) facts.ontoggle = () => localStorage.setItem('sift-facts', facts.open ? 'open' : 'closed');
  view.querySelectorAll('[data-decide]').forEach((b) => {
    b.onclick = async () => {
      if (deciding) return;                   // a double tap, or the key pressed twice
      deciding = true;
      try { await decideWith(b); } finally { deciding = false; }
    };
  });
  async function decideWith(b) {
    {
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
      const stageable = ['keep_flac', 'keep_mp3', 'refetch', 'bin_album'].includes(b.dataset.decide);
      // staging asks only when there is a release to choose; Looks fine runs now, so it asks
      // a duplicate's or library album's re-fetch depends on whether Lidarr-FLAC has the album, so it says which
      // keeping a FLAC nothing confirms asks too: it is the one decision that adds an album you never had
      const answer = stageable && !rels && !((a.dupe || a.health) && b.dataset.decide === 'refetch')
        && !(a.no_mp3 && !a.refetched && b.dataset.decide === 'keep_flac') ? true
        : await ask({ title: `${title}: ${a.artist} — ${a.title}?`, body, ok: stageable ? `Stage: ${title}` : title, choices: rels && rels.map(label), chosen });
      if (!answer) return;
      const n = neighbours(a).next || neighbours(a).prev;
      const decision = { id: a.id, decision: b.dataset.decide, ...(rels ? { release: answer.choice } : {}) };
      if (!stageable) { afterJob = n ? `#/album/${n.id}` : '#/'; await run('/api/decide', decision); return; }
      await stageDecision('/api/decide', decision, n && n.id !== a.id ? `#/album/${n.id}` : '#/');
    }
  }
  if ($('unstage')) {
    $('unstage').onclick = async () => {
      try { await api('/api/unstage', { ids: [a.id] }); } catch (e) { toast(e.message); return; }
      await loadState();
      renderAlbum(a.id, true);
    };
  }
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
        const job = await watchJob();
        if (job && job.ok) toast(w.checked ? 'Soularr will look for a better copy.' : 'Soularr will stop looking.');
      } catch (e) { w.checked = !w.checked; toast(e.message); }
    };
  }

  // ---- track tools
  const tool = async (body, note) => {
    if (body.tool === 'reorder' || body.tool === 'bin_track') releaseAudio();
    try {
      await api('/api/track', { id: a.id, ...body });
      const job = await watchJob();
      if (note && job && job.ok) toast(note);
      return job;
    } catch (e) { toast(e.message); return null; }
  };
  const tool0 = async (url, body, note) => {
    try {
      await api(url, body);
      const job = await watchJob();
      if (job && job.ok) toast(note);
    } catch (e) { toast(e.message); }
  };
  const on = (idOrSel, fn) => { const el = typeof idOrSel === 'string' ? $(idOrSel) : idOrSel; if (el) el.onclick = fn; };
  on('block', async () => {
    if (await ask({ title: `Block ${a.source.user}?`, ok: 'Block',
      body: "Soularr won't download from them again. This album stays as it is; decide on it separately. You can undo it from the bin." })) {
      tool0('/api/block', { id: a.id }, `${a.source.user} is blocked.`);
    }
  });
  artTarget = a.flac && a.flac.tracks.length && !a.flac.tracks.some((t) => t.damaged)
    ? { id: a.id, files: a.flac.tracks.length, label: `${a.artist} — ${a.title}` } : null;
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
      const job = await tool({ tool: 'reorder', order: pending }, 'Tracks renumbered. Undo is in the bin.');
      // refused or failed: back to the edit, as it was
      if ((!job || !job.ok) && location.hash === `#/album/${a.id}`) { mode = 'order'; renderAlbum(a.id, true); }
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

// ---- a hand-made download ------------------------------------------------------
// One folder from slskd's downloads. The right Lidarr says how it would file each track;
// Import hands it the whole folder in one go. Playing and spectrograms work as on an album.

async function renderDownload(id) {
  let a;
  try { a = await api(`/api/download/${id}`); } catch {
    if (location.hash !== `#/download/${id}`) return;
    view.innerHTML = '<p class="empty">This download is no longer listed. <a href="#/">Back to the list</a></p>';
    return;
  }
  if (location.hash !== `#/download/${id}`) return;
  if (!album || album.id !== `d${a.id}`) mode = 'view';
  album = { id: `d${a.id}`, download: true, flac: { tracks: a.tracks }, mp3: null, paths: { flac: a.paths },
    rows: a.tracks.map((_, k) => ({ m: null, f: k })) };
  document.title = `${a.title} · Sift`;
  const who = a.inst === 'mp3' ? 'the MP3 Lidarr' : 'Lidarr-FLAC';
  const lib = a.inst === 'mp3' ? 'the MP3 library' : "Lidarr-FLAC's library";
  const v = a.lidarr && !a.lidarr.error ? a.lidarr : null;
  const filed = v && v.album_id;
  const n = a.tracks.length;
  const files = `${n} file${n === 1 ? '' : 's'}`;
  const relText = (r) => [r.date && r.date.slice(0, 4), r.title, r.format, r.country, r.label, `${r.tracks} tracks`].filter(Boolean).join(' · ');
  const totals = [`${a.kind === 'mp3' ? 'MP3' : a.kind === 'flac' ? 'FLAC' : 'Files'} ${clock(a.seconds)} · ${files} · ${gb(a.bytes)}`, a.date].filter(Boolean).join(' · ');
  const note = a.busy ? 'Still downloading. Sift looks again once slskd has finished with it.'
    : a.blocked ? a.blocked
    : `Every file has a track in the release. Import moves and renames them into ${lib}.`;
  const texts = {
    import: ['Import', `${who} moves and renames the ${files} into ${lib} as ${filed ? `${v.artist} — ${v.title}` : 'the album'}. `
      + 'The album then goes through the review queue like any Soularr download, and the emptied folder goes in the bin.'],
    import_anyway: ['Import anyway', `${a.blocked}. Importing anyway is how albums were broken before: only do it when you know the folder is what you want. Enter the password to confirm.`],
    add: ['Add to Lidarr', a.add ? `${a.add.artist} — ${a.add.title}${a.add.year ? ` (${a.add.year})` : ''} is added to ${who} unmonitored, so nothing goes looking for it, and the folder is checked against it again.` : ''],
    release: ['Change release', 'Which release of the album these files are. Pick the one whose track count matches the folder.'],
    keep: ['Keep as is', `The folder moves into the Roon ${a.kind === 'mp3' ? 'MP3' : 'FLAC'} library as ${a.keep}, with its files and tags as they are.`
      + (a.allowed.includes('keep_find') ? ' Looking for a FLAC as well marks the album wanted in Lidarr-FLAC (adding it from MusicBrainz if need be), so Soularr fetches one and it comes through the review queue like any other.'
        : ' Lidarr never hears of it.') + ' Undo is in the bin.'],
    bin: ['Delete download', 'The folder goes in the bin. Nothing is deleted until you empty the bin, and Undo is there until then.'],
  };
  const icon = { import: 'inbox', import_anyway: 'inbox', add: 'plus', release: 'list', keep: 'check', bin: 'trash' };
  // Change release corrects what Import will do rather than deciding anything, so it sits
  // with the tools; Keep as is asks whether to look for a FLAC instead of being two buttons
  const buttons = ['import', 'import_anyway', 'keep', 'add', 'bin'].filter((d) => a.allowed.includes(d))
    .map((d) => `<button class="${d === 'import' || d === 'keep' ? 'primary' : d === 'import_anyway' ? 'danger' : d === 'bin' ? 'ghost' : ''}" data-act="${d}">${ic(icon[d])}${texts[d][0]}</button>`);
  const tools = mode === 'spectra'
    ? `<div class="tools"><span class="hint">Each track's spectrum. A FLAC made from an MP3 goes dark well below the top.</span><button id="tcancel" class="primary">${ic('check')}Done</button></div>`
    : n ? `<div class="tools"><button id="tspectra">${ic('wave')}Spectrograms</button>${mode === 'view' && a.allowed.includes('release')
      ? `<button data-act="release">${ic('list')}Change release</button>` : ''}${!a.busy && !a.damaged
      ? `<a class="button" id="tartweb" href="#/art/d${a.id}">${ic('image')}Edit artwork</a>` : ''}</div>` : '';
  const filecell = (k) => {
    const f = v && v.files[k];
    if (!f) return '<div class="cell empty">—</div>';
    return `<div class="cell"><span class="ttext"><span class="ttitle">${f.mapped ? esc(f.tracks) : '<span class="badge warn">no track</span>'}</span>
      ${f.why.length ? `<span class="tmeta">${esc(f.why.join('; '))}</span>` : ''}</span></div>`;
  };
  const table = n ? `<div class="tracks"><div class="thead"><div>${a.kind === 'mp3' ? 'MP3' : 'FLAC'}</div><div></div><div>${esc(who)}</div></div>
    ${a.tracks.map((t, k) => `<div class="trow">${cell(album, 'flac', k, k)}
      <div class="match ${v && v.files[k] ? (v.files[k].mapped ? 'same' : 'diff') : ''}">${v && v.files[k] ? (v.files[k].mapped ? '✓' : '≠') : ''}</div>${filecell(k)}</div>${mode === 'spectra'
      ? `<div class="spec">${spectrumPic(album, 'flac', k)}<div></div><div class="specpic none"></div></div>` : ''}`).join('')}</div>` : '';
  view.innerHTML = `<div class="albumnav"><a href="#/" class="back">← All albums</a></div>
    <div class="ahead">
      ${a.cover ? `<img class="cover" src="/api/cover/${a.id}${artStamp}" alt="">` : '<span class="cover none"></span>'}
      <div><p class="qname">Download</p><h2>${esc(a.title)}</h2><p class="artist">${esc(a.artist || a.name)}</p>
      <p class="totals">${esc(totals)}</p></div>
    </div>
    <p class="diag">${esc(note)}</p>
    <ul class="reasons"><li>Folder: ${esc(a.name)}</li>
      ${filed ? `<li>${esc(who)} files it as ${esc(v.artist)} — ${esc(v.title)}${v.release ? `, release ${esc(relText({ ...v.release, country: '', label: '' }))}` : ''}</li>` : ''}
      ${a.add && !filed ? `<li>MusicBrainz has ${esc(a.add.artist)} — ${esc(a.add.title)}${a.add.year ? ` (${esc(a.add.year)})` : ''}${a.add.type ? `, ${esc(a.add.type.toLowerCase())}` : ''}, ${a.add.by_id ? "the release the files' tags name" : 'found by name, so check it is the right one'}</li>` : ''}
      ${a.lidarr && a.lidarr.error ? `<li>${esc(a.lidarr.error)}</li>` : ''}</ul>
    ${a.source ? `<p class="source">From Soulseek user <b>${esc(a.source.user)}</b>${a.source.when ? ` · finished ${esc(day(a.source.when, true))}` : ''}</p>` : ''}
    ${a.failed && a.failed.length ? `<p class="source warn"><b>${a.failed.length} file${a.failed.length === 1 ? '' : 's'} never arrived:</b> ${a.failed.map(esc).join(', ')}. Soulseek gave up on ${a.failed.length === 1 ? 'it' : 'them'}; search again in slskd to fetch ${a.failed.length === 1 ? 'it' : 'them'} into this folder.</p>` : ''}
    <div class="decisions">${mode === 'view' ? buttons.join('') : ''}</div>
    ${tools}${table}`;

  const go = async (body, after) => {
    releaseAudio();
    try { await api('/api/download', { id: a.id, ...body }); afterJob = after || null; watchJob(); } catch (e) { afterJob = null; toast(e.message); }
  };
  view.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const d = b.dataset.act;
      const [title, body] = texts[d];
      if (d === 'release') {
        const chosen = Math.max(0, a.releases.findIndex((r) => r.selected));
        const answer = await ask({ title: `${title}?`, body, ok: title, choices: a.releases.map(relText), chosen });
        if (answer) go({ action: 'release', release: answer.choice });
        return;
      }
      if (d === 'import_anyway') {
        let error = '';
        for (;;) {
          const pw = await ask({ title: `${title}?`, body, ok: title, danger: true, password: true, error });
          if (pw == null) return;
          try { await api('/api/download', { id: a.id, action: d, password: pw }); afterJob = '#/'; watchJob(); return; } catch (e) {
            if (e.status !== 401) { toast(e.message); return; }
            if (e.message === 'not signed in') { location.href = '/'; return; }
            error = 'Wrong password';
          }
        }
      }
      if (d === 'keep' && a.allowed.includes('keep_find')) {
        const answer = await ask({ title: 'Keep the MP3?', body, ok: 'Keep',
          choices: ['Keep it and look for a FLAC', 'Just keep the MP3'] });
        if (answer) go({ action: answer.choice === 0 ? 'keep_find' : 'keep' }, '#/');
        return;
      }
      if (await ask({ title: `${title}?`, body, ok: title, danger: d === 'bin' })) {
        if (d === 'import') { tab = 'arriving'; localStorage.setItem('sift-tab', tab); }
        go({ action: d }, d === 'import' || d === 'keep' || d === 'bin' ? '#/' : null);
      }
    };
  });
  view.querySelectorAll('.play').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); play('flac', Number(b.dataset.idx), Number(b.dataset.row)); };
  });
  artTarget = n && !a.busy && !a.damaged ? { id: a.id, files: n, label: `${a.artist || a.name} — ${a.title}` } : null;
  if ($('tspectra')) $('tspectra').onclick = () => { mode = 'spectra'; renderDownload(a.id); };
  if ($('tcancel')) $('tcancel').onclick = () => { mode = 'view'; renderDownload(a.id); };
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
  const here = album && playing.album.id === album.id;
  $('pprev').disabled = !here || !stepTarget(-1);
  $('pnext').disabled = !here || !stepTarget(1);
  $('seek').max = active.duration || 0;
  $('plen').textContent = clock(active.duration);
  view.querySelectorAll('.play.on').forEach((b) => b.classList.remove('on'));
  const btn = view.querySelector(`.play[data-side="${playing.side}"][data-idx="${playing.idx}"][data-row="${playing.row}"]`);
  if (btn) btn.classList.add('on');
  showBuffering();
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
  // one seek waiting per deck: pressing A/B again before a track loads replaces it
  if (deck.pendingSeek) deck.removeEventListener('loadedmetadata', deck.pendingSeek);
  deck.pendingSeek = null;
  if (deck.readyState >= 1) { go(); return; }
  deck.pendingSeek = () => { deck.pendingSeek = null; go(); };
  deck.addEventListener('loadedmetadata', deck.pendingSeek, { once: true });
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
// Buffering: the active deck has been asked to play but hasn't enough data to. The play
// button and the track's own button spin until it has.
function showBuffering() {
  const on = !!playing && !active.paused && active.readyState < 3 && !active.error;
  $('pp').classList.toggle('loading', on);
  view.querySelectorAll('.play.loading').forEach((b) => b.classList.remove('loading'));
  if (on) view.querySelectorAll('.play.on').forEach((b) => b.classList.add('loading'));
  $('ptime').textContent = on && active.currentTime < 0.1 ? 'Loading…' : clock(active.currentTime);
}
for (const d of decks) {
  for (const ev of ['loadstart', 'waiting', 'playing', 'canplay', 'pause', 'seeking', 'seeked', 'emptied']) {
    d.addEventListener(ev, () => { if (d === active) showBuffering(); });
  }
  d.addEventListener('error', () => {
    if (d !== active || !d.getAttribute('src')) return;
    showBuffering();
    toast("Couldn't load this track.");
  });
  d.addEventListener('play', () => { if (d === active) $('pp').innerHTML = ic('pause'); });
  d.addEventListener('pause', () => { if (d === active) $('pp').innerHTML = ic('play'); });
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
  check: 'Check for new arrivals', adopted: 'Added from the shell', bin_track: 'Track put in the bin', reorder: 'FLAC tracks renumbered', block_user: 'Soulseek user blocked',
  strip_id3: 'ID3v1 tags cut off', art: 'Artwork written into the files', bin_download: 'Download put in the bin', import_download: 'Download imported by Lidarr (the folder left behind)', sleeve_file: 'Filed for Sleeve (Send to Soulseek)', cover: 'Cover fetched from the shell' };

function renderBin() {
  document.title = 'Bin · Sift';
  const total = state.bin.reduce((n, e) => n + e.bytes, 0);
  const days = (state.settings || {}).retention_days || 0;
  const old = days ? state.bin.filter((e) => Date.now() - new Date(e.at).getTime() > days * 86400000) : [];
  const oldBytes = old.reduce((n, e) => n + e.bytes, 0);
  view.innerHTML = `<a href="#/" class="back">← All albums</a>
    <div class="qhead"><h2>Bin <span class="count">${gb(total)}</span></h2>
    ${state.bin.length ? `<button class="danger" id="empty">${ic('trash')}Empty bin</button>` : ''}</div>
    <p class="blurb">Nothing here is deleted until you empty the bin. Until then every decision can be undone.</p>
    <div class="retain"><label>Keep entries for <select id="retention">${[0, 7, 14, 30, 60, 90].map((d) =>
      `<option value="${d}" ${d === days ? 'selected' : ''}>${d ? `${d} days` : 'as long as I like'}</option>`).join('')}</select></label>
      ${old.length ? `<button class="danger small" id="emptyold">${ic('trash')}Empty ${old.length} older than ${days} days (${gb(oldBytes)})</button>`
    : days ? `<span class="muted">Nothing older than ${days} days.</span>` : ''}</div>
    ${state.bin.length ? state.bin.map((e) => `<div class="row binrow">
      <span class="rtext"><span class="rtitle">${esc(e.label)}</span>
      <span class="rreason">${esc(DECIDED[e.decision] || e.decision)} · ${ago(e.at)} · ${gb(e.bytes)}</span></span>
      <button data-undo="${esc(e.id)}">${ic('undo')}Undo</button></div>`).join('') : '<p class="empty">The bin is empty.</p>'}`;
  view.querySelectorAll('[data-undo]').forEach((b) => {
    b.onclick = async () => {
      const e = state.bin.find((x) => x.id === b.dataset.undo);
      if (!e) { toast('That entry has gone from the bin.'); renderBin(); return; }
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
      try { await api('/api/bin/empty', { password: pw, older, shown: state.bin.map((e) => e.id) }); watchJob(); return; } catch (e) {
        if (e.status === 409) { toast(e.message); await loadState(); renderBin(); return; }
        if (e.status !== 401) { toast(e.message); return; }
        if (e.message === 'not signed in') { location.href = '/'; return; }   // the session ran out
        error = 'Wrong password';
      }
    }
  };
  if ($('empty')) $('empty').onclick = emptyWith(false);
  if ($('emptyold')) $('emptyold').onclick = emptyWith(true);
}

// ---- history -----------------------------------------------------------------

const OUTCOME = { bin: ['In the bin', ''], undone: ['Undone', 'muted'], emptied: ['Deleted for good', ''], failed: ['Failed', 'bad'] };
const DECIDED_MANY = { 'apply-staged': 'Approve staged', check: 'Check', undo: 'Undo', 'empty-bin': 'Empty bin',
  pair: 'Pair tracks', unpair: 'Forget a pair', one_album: 'One album', watch_on: 'Watch for a better FLAC',
  watch_off: 'Stop watching', dismiss: 'Looks fine', downloads: 'List downloads', download_import: 'Import download',
  download_import_anyway: 'Import download anyway', download_add: 'Add to Lidarr', download_release: 'Change release', download_keep: 'Keep download as is', download_bin: 'Bin download' };

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

// The track before or after the one playing, in the album's row order: the same side if
// that row has it, otherwise the other side. Null at either end.
function stepTarget(dir) {
  if (!album) return null;
  const rows = album.rows;
  const side = playing ? playing.side : 'mp3';
  let k = playing && playing.album.id === album.id ? playing.row + dir : (dir > 0 ? 0 : rows.length - 1);
  for (; k >= 0 && k < rows.length; k += dir) {
    const r = rows[k];
    const idx = side === 'mp3' ? r.m : r.f;
    const other = side === 'mp3' ? r.f : r.m;
    if (idx != null) return [side, idx, k];
    if (other != null) return [side === 'mp3' ? 'flac' : 'mp3', other, k];
  }
  return null;
}

function keyRows(dir) {
  const t = stepTarget(dir);
  if (t) play(...t);
}
$('pprev').onclick = () => keyRows(-1);
$('pnext').onclick = () => keyRows(1);

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
  else if (ev.key === 'ArrowRight' && playing) {
    ev.preventDefault();
    // before its length is known, skip ahead anyway rather than back to the start
    active.currentTime = Number.isFinite(active.duration) ? Math.min(active.duration, active.currentTime + 10) : active.currentTime + 10;
  }
  else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && onAlbum && mode !== 'order') {
    ev.preventDefault();
    keyRows(ev.key === 'ArrowDown' ? 1 : -1);
  } else if (ev.key === 'Escape' && !$('menupop').hidden) { menu(false); $('more').focus();
  } else if (ev.key === 'Escape' && onAlbum && mode !== 'view') {
    mode = 'view'; picked = null;
    if (album.download) renderDownload(Number(String(album.id).slice(1))); else renderAlbum(album.id, true);
  } else if ((ev.key === 'j' || ev.key === 'k') && onAlbum && !album.download) {
    const n = neighbours(album)[ev.key === 'k' ? 'next' : 'prev'];
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
  if ((m = /^#\/download\/(\d+)$/.exec(h))) return renderDownload(Number(m[1]));
  if ((m = /^#\/art\/(\d+)$/.exec(h))) return renderArtwork(Number(m[1]));
  if ((m = /^#\/art\/([qd]\d+)$/.exec(h))) return renderArtwork(m[1]);
  album = null;
  if (h === '#/bin') return renderBin();
  if (h === '#/history') return renderHistory();
  return renderList();
}

window.addEventListener('hashchange', () => {
  // a question asked on the page being left is cancelled: OK must never act on an album
  // that is no longer on screen. And having gone elsewhere, a finishing job doesn't pull you back
  if ($('dialog').open) $('dialog').close('');
  if (location.hash !== afterJob) afterJob = null;
  window.scrollTo(0, 0); mode = 'view'; album = null; artTarget = null; route();
});
$('check').onclick = () => run('/api/check', {});
// History and Sign out live behind the ⋯ menu; anything outside it, or Esc, closes it
const menu = (open) => {
  $('menupop').hidden = !open;
  $('more').setAttribute('aria-expanded', String(open));
  $('more').classList.toggle('open', open);
};
$('more').onclick = (ev) => { ev.stopPropagation(); menu($('menupop').hidden); };
$('menupop').onclick = () => menu(false);
document.addEventListener('click', () => menu(false));
const pathsLabel = () => { $('paths').textContent = showPaths ? 'Hide file paths' : 'Show file paths'; };
pathsLabel();
$('paths').onclick = () => {
  showPaths = !showPaths;
  localStorage.setItem('sift-paths', showPaths ? 'on' : 'off');
  pathsLabel();
  if (location.hash.startsWith('#/album/')) route();
};
$('logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF': csrf || '' } }); location.href = '/'; };
setInterval(() => {
  if (polling) return;
  loadState().then(() => {
    const h = location.hash || '#/';
    if (h === '#/') renderList();
    else if (h === '#/bin' && !$('dialog').open) renderBin();      // never under an open question
  }).catch(() => {});
}, 60000);

(async () => {
  csrf = (await api('/api/csrf')).csrf;
  await loadState();
  route();
})();
