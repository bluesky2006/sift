'use strict';
// Sift — review queue for Soularr's FLACs. See README.md and ~/notes/sift-review-plan.md.
//
// The browser only ever sends an album id or a bin entry id, plus a decision name from a
// fixed list. Paths come from queue.json and bin.json, which bin/sift.py writes, and every
// file operation is bin/sift.py run with a fixed argv. Nothing here moves or deletes a file.

const http = require('http');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { pipeline } = require('stream');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const auth = require('./lib/auth');

const PORT = Number(process.env.PORT || 8305);
// Loopback plus the tailnet address, never 0.0.0.0, same as Switchboard.
const HOSTS = (process.env.HOSTS || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
const PUBLIC = path.join(__dirname, 'public');
const STATE = process.env.SIFT_STATE || path.join(process.env.HOME, '.local/state/sift');
const ENGINE = path.join(__dirname, 'bin', 'sift.py');
const PYTHON = process.env.SIFT_PYTHON || '/usr/bin/python3';

// Audio is only ever served from these, whatever queue.json says.
const AUDIO_ROOTS = (process.env.SIFT_AUDIO_ROOTS
  || '/mnt/roon-data/music-flac,/mnt/roon-music/MP3,/mnt/roon-music/FLAC-damaged,/mnt/roon-music/FLAC').split(',');
const FFMPEG = process.env.SIFT_FFMPEG || 'ffmpeg';

const DECISIONS = new Set(['keep_flac', 'keep_mp3', 'refetch', 'watch_on', 'watch_off', 'bin_album', 'dismiss']);
const MANY = new Set(['keep_flac', 'keep_mp3', 'refetch']);

// ---- helpers ---------------------------------------------------------------

function headers(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; "
      + "connect-src 'self'; manifest-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  };
}

function send(res, status, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, headers({ 'Content-Length': buf.length, ...extra }));
  res.end(buf);
}
const json = (res, status, obj, extra = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...extra });

const cookie = (value) =>
  `${auth.COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_DAYS * 86400}`;

class BadBody extends Error {}
async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BadBody('body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadBody('body is not valid JSON'); }
}

function audit(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  fsp.appendFile(path.join(STATE, 'audit.log'), line).catch(() => {});
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const STATIC = new Set(['/app.js', '/style.css', '/login.js', '/icon.svg', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/site.webmanifest']);

async function serveStatic(res, name) {
  try {
    const body = await fsp.readFile(path.join(PUBLIC, name));
    return send(res, 200, body, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch { return send(res, 404, 'not found'); }
}

// queue.json and bin.json, re-read only when they change
const cache = new Map();
async function readState(name, fallback) {
  const file = path.join(STATE, name);
  try {
    const st = await fsp.stat(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;
    const data = JSON.parse(await fsp.readFile(file, 'utf8'));
    cache.set(file, { mtime: st.mtimeMs, data });
    return data;
  } catch { return fallback; }
}

// Keys starting with _ hold paths; they never leave the server, at any depth.
const pub = (v) => Array.isArray(v) ? v.map(pub)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, pub(x)]))
  : v;

// Engine output quotes the paths it failed on. Those stay in audit.log; the browser gets
// "…" in their place, quoted or not.
const scrub = (text) => String(text || '')
  .replace(/(['"])[^'"\n]*\/[^'"\n]*\1/g, '$1…$1')
  .replace(/(^|[\s(=])\/[^\n;()]*?(?=: |:$|,? \(|;|\)|\n|$)/gm, '$1…');
const jobView = (j) => j && { kind: j.kind, label: j.label, done: j.done, ok: j.ok, output: scrub(j.output) };

// ---- staging ---------------------------------------------------------------
// Album decisions are staged, not run: staged.json holds { id, decision, release, at } per
// album until they are approved. The server is its only writer; approving takes the
// entries out before the engine starts on them.
const STAGEABLE = new Set(['keep_flac', 'keep_mp3', 'refetch', 'bin_album']);
async function readStaged(q) {
  const s = await readState('staged.json', { entries: [] });
  // an album decided elsewhere, gone from the queue or no longer allowing the decision drops out
  return s.entries.filter((e) => {
    const item = q.items.find((i) => i.id === e.id);
    return item && item.queue !== 'arriving' && item.allowed.includes(e.decision)
      && (e.release == null || e.release < (item.releases || []).length);
  });
}
async function writeStaged(entries) {
  await fsp.writeFile(path.join(STATE, 'staged.json.tmp'), JSON.stringify({ entries }));
  await fsp.rename(path.join(STATE, 'staged.json.tmp'), path.join(STATE, 'staged.json'));
  cache.delete(path.join(STATE, 'staged.json'));   // two writes in one millisecond share an mtime
}
// read-change-write on staged.json one request at a time
let stagedLock = Promise.resolve();
const withStaged = (fn) => { const run = stagedLock.then(fn); stagedLock = run.catch(() => {}); return run; };
const stage = (q, adds) => withStaged(async () => {
  const ids = new Set(adds.map((e) => e.id));
  const kept = (await readStaged(q)).filter((e) => !ids.has(e.id));
  const at = new Date().toISOString();
  await writeStaged([...kept, ...adds.map((e) => ({ id: e.id, decision: e.decision, release: e.release ?? null, at }))]);
});

// ---- jobs ------------------------------------------------------------------
// One engine run at a time from the app. The scheduled check takes the engine's own
// lock, so a decision pressed during a check simply waits for it.

let job = null;
function startJob(kind, args, label) {
  if (job && !job.done) return null;
  stopSpectra();
  const j = { id: Date.now().toString(36), kind, label, started: Date.now(), output: '', done: false, ok: null };
  const child = spawn(PYTHON, [ENGINE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (b) => { j.output = (j.output + b.toString()).slice(-8000); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('close', (code) => {
    j.done = true; j.ok = code === 0; j.finished = Date.now();
    audit({ event: 'job-done', kind, label, ok: j.ok, output: j.ok ? undefined : j.output.slice(-500) });
  });
  job = j;
  return j;
}

// ---- audio -----------------------------------------------------------------

async function streamFile(req, res, file) {
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || !AUDIO_ROOTS.some((r) => real.startsWith(r + '/'))) return send(res, 404, 'not found');
  const st = await fsp.stat(real);
  const type = real.toLowerCase().endsWith('.flac') ? 'audio/flac' : 'audio/mpeg';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, status = 200;
  if (range) {
    if (range[1] === '' && range[2] !== '') { start = Math.max(0, st.size - Number(range[2])); }
    else { start = Number(range[1] || 0); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
    if (start > end || start >= st.size) {
      res.writeHead(416, headers({ 'Content-Range': `bytes */${st.size}` }));
      return res.end();
    }
    status = 206;
  }
  res.writeHead(status, headers({
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=3600',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
  }));
  if (req.method === 'HEAD') return res.end();
  // pipeline, not pipe: when the browser drops the request (a seek, a skipped track, a
  // preload it no longer wants) the file is closed at once. A file left open here and then
  // moved by a decision lingers on the NTFS drive as .fuse_hidden and fails the move.
  pipeline(fs.createReadStream(real, { start, end }), res, () => {});
}

// ---- spectrograms ----------------------------------------------------------
// Drawn by ffmpeg on request and kept in STATE/spectra, named after the file's path, size
// and time, so a changed file gets a new picture. A job stops any being drawn: they're
// only pictures, and a file held open by one would fail a move on the NTFS drive.

const SPECTRA = path.join(STATE, 'spectra');
const drawing = new Map();        // cache name -> { child, promise }
const waiting = [];               // starts held back so no more than three draw at once
let running = 0;

function stopSpectra() {
  for (const d of drawing.values()) if (d.child) d.child.kill('SIGKILL');
  for (const w of waiting.splice(0)) w();
}

// resolves to the picture's path, 'refused' for a file outside the music folders, or null
// when it can't be drawn right now
async function spectrum(file) {
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || !AUDIO_ROOTS.some((r) => real.startsWith(r + '/'))) return 'refused';
  const st = await fsp.stat(real);
  const name = crypto.createHash('sha1').update(`${real}|${st.size}|${st.mtimeMs}`).digest('hex') + '.png';
  const out = path.join(SPECTRA, name);
  await fsp.mkdir(SPECTRA, { recursive: true });
  if (fs.existsSync(out)) return out;
  if (drawing.has(name)) return drawing.get(name).promise;
  if (job && !job.done) return null;
  const d = { child: null };
  d.promise = (async () => {
    if (running >= 3) await new Promise((go) => waiting.push(go));
    if (job && !job.done) { drawing.delete(name); return null; }
    running++;
    const tmp = `${out}.${process.pid}.tmp.png`;
    const ok = await new Promise((resolve) => {
      d.child = execFile(FFMPEG, ['-v', 'error', '-nostdin', '-y', '-i', real, '-lavfi',
        'showspectrumpic=s=720x320:legend=1:mode=combined:win_func=bharris', '-frames:v', '1', tmp],
      { timeout: 120000 }, (err) => resolve(!err));
    });
    running--;
    if (waiting.length) waiting.shift()();
    drawing.delete(name);
    if (!ok) { await fsp.unlink(tmp).catch(() => {}); return null; }
    return fsp.rename(tmp, out).then(() => out, () => null);
  })();
  drawing.set(name, d);
  return d.promise;
}

// ---- history ---------------------------------------------------------------
// What is in the bin, what left it (history.json, kept by the engine), and jobs that failed
// (audit.log). Totals count decisions still in the bin plus those emptied for good.

const TOTALS = { keep_flac: 'flac', keep_mp3: 'mp3', refetch: 'refetch' };

async function history() {
  const b = await readState('bin.json', { entries: [] });
  const h = await readState('history.json', {});
  const pick = (e) => ({ id: e.id, at: e.at, decision: e.decision, label: e.label, bytes: e.bytes || 0 });
  const events = [
    ...b.entries.map((e) => ({ ...pick(e), outcome: 'bin' })),
    ...(h.undone || []).map((e) => ({ ...pick(e), outcome: 'undone', when: e.undone })),
    ...(h.emptied || []).flatMap((x) => x.entries.map((e) => ({ ...pick(e), outcome: 'emptied', when: x.at }))),
    ...(h.failed || []).map((e) => ({ at: e.at, decision: e.decision, label: e.label, outcome: 'failed', error: e.error })),
  ];
  let log = '';
  try { log = await fsp.readFile(path.join(STATE, 'audit.log'), 'utf8'); } catch { /* none yet */ }
  for (const line of log.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event !== 'job-done' || ev.ok) continue;
    events.push({ at: ev.at, decision: ev.kind, label: ev.label, outcome: 'failed', error: ev.output || '' });
  }
  // errors quote the paths they failed on; those stay here
  for (const e of events) {
    if (e.error) e.error = scrub(e.error.trim().split('\n').pop()).slice(0, 300);
  }
  events.sort((x, y) => new Date(y.at) - new Date(x.at));
  const totals = { flac: 0, mp3: 0, refetch: 0, freed: 0, emptied: (h.emptied || []).length };
  for (const e of events) {
    if ((e.outcome === 'bin' || e.outcome === 'emptied') && TOTALS[e.decision]) totals[TOTALS[e.decision]]++;
  }
  for (const x of h.emptied || []) totals.freed += x.bytes || 0;
  return { events: events.slice(0, 1000), totals };
}

// ---- routes ----------------------------------------------------------------

// Only our own addresses, so a page on another name that rebinds to us gets nowhere
const HOST_OK = new Set(HOSTS.flatMap((h) => [`${h}:${PORT}`]).concat(`localhost:${PORT}`));

async function handle(req, res) {
  if (!HOST_OK.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, 'wrong host');
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const a = await auth.loadAuth();
  const sid = auth.readCookie(req, auth.COOKIE);
  const authed = auth.validSession(sid, a);

  if (STATIC.has(p)) return serveStatic(res, p.slice(1));
  if (p === '/') return authed ? send(res, 302, '', { Location: '/app' }) : serveStatic(res, 'login.html');
  if (p === '/app') return authed ? serveStatic(res, 'app.html') : send(res, 302, '', { Location: '/' });

  if (p === '/api/auth/status') return json(res, 200, { configured: !!a, authed });
  if (p === '/api/auth/setup' && req.method === 'POST') {
    if (a) return json(res, 409, { error: 'already configured' });
    const body = await readBody(req);
    if (typeof body.password !== 'string' || body.password.length < 12) {
      return json(res, 400, { error: 'password must be at least 12 characters' });
    }
    const created = await auth.setPassword(body.password);
    audit({ event: 'setup' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(auth.makeSession(created)) });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    if (!auth.startAttempt()) return json(res, 429, { error: 'too many attempts, wait 5 minutes' });
    const body = await readBody(req);
    await new Promise((r) => setTimeout(r, 500));
    if (!a || typeof body.password !== 'string' || !auth.verifyPassword(body.password, a)) {
      audit({ event: 'login-failed', ip: req.socket.remoteAddress });
      return json(res, 401, { error: 'wrong password' });
    }
    auth.clearFailures();
    audit({ event: 'login', ip: req.socket.remoteAddress });
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(auth.makeSession(a)) });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    // ends every session, this one and any other device's
    if (authed) { await auth.endSessions(a); audit({ event: 'logout', ip: req.socket.remoteAddress }); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': `${auth.COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  // ---- everything below needs a session
  if (!authed) return json(res, 401, { error: 'not signed in' });

  if (p === '/api/csrf') return json(res, 200, { csrf: auth.csrfFor(sid, a) });

  if (p === '/api/state' && req.method === 'GET') {
    const q = await readState('queue.json', { items: [] });
    const b = await readState('bin.json', { entries: [] });
    const items = q.items.map((i) => ({
      id: i.id, artist: i.artist, title: i.title, queue: i.queue, reasons: i.reasons,
      cover: i.cover, first_seen: i.first_seen, watch: i.watch, allowed: i.allowed,
      suspect: i.suspect || null, dupe: !!i.dupe, diagnosis: i.diagnosis || null,
      no_mp3: i.status === 'no_mp3',
      flac: i.flac ? { n: i.flac.tracks.length, fmt: (i.flac.tracks[0] || {}).fmt || '',
        damaged: i.flac.tracks.filter((t) => t.damaged).length } : null,
      mp3: i.mp3 ? { n: i.mp3.tracks.length, fmt: (i.mp3.tracks[0] || {}).fmt || '' } : null,
    }));
    return json(res, 200, {
      built: q.built, checked: q.checked, previous_check: q.previous_check, items,
      bin: b.entries.map((e) => ({ id: e.id, at: e.at, decision: e.decision, label: e.label, bytes: e.bytes || 0 }))
        .reverse(),
      staged: (await readStaged(q)).map((e) => {
        const r = e.release != null && (q.items.find((i) => i.id === e.id).releases || [])[e.release];
        return { id: e.id, decision: e.decision, at: e.at,
          release: r ? [r.date && r.date.slice(0, 4), r.title, r.format, r.country].filter(Boolean).join(' · ') : null };
      }),
      job: jobView(job),
      settings: await readState('settings.json', {}),
    });
  }

  let m;
  if ((m = /^\/api\/album\/(\d+)$/.exec(p)) && req.method === 'GET') {
    const q = await readState('queue.json', { items: [] });
    const item = q.items.find((i) => i.id === Number(m[1]));
    if (!item) return json(res, 404, { error: 'not in the queue' });
    // Library duplicates show where each copy lives, as the path inside its music folder
    // ("FLAC/Artist/Album/01.flac"): never the absolute path, and nothing outside the roots.
    const inRoot = (f) => {
      const root = AUDIO_ROOTS.find((r) => f.startsWith(r + '/'));
      return root ? path.relative(path.dirname(root), f) : null;
    };
    const paths = item.dupe && item._files
      ? { flac: (item._files.flac || []).map(inRoot), mp3: (item._files.mp3 || []).map(inRoot) } : undefined;
    return json(res, 200, { ...pub(item), no_mp3: item.status === 'no_mp3', ...(paths ? { paths } : {}) });
  }

  if ((m = /^\/api\/audio\/(\d+)\/(flac|mp3)\/(\d+)$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) {
    const q = await readState('queue.json', { items: [] });
    const item = q.items.find((i) => i.id === Number(m[1]));
    const file = item && item._files && (item._files[m[2]] || [])[Number(m[3])];
    return file ? streamFile(req, res, file) : send(res, 404, 'not found');
  }

  if ((m = /^\/api\/cover\/(\d+)(?:\/(flac|mp3))?$/.exec(p)) && req.method === 'GET') {
    try {
      const body = await fsp.readFile(path.join(STATE, 'covers', `${Number(m[1])}${m[2] ? `-${m[2]}` : ''}.jpg`));
      return send(res, 200, body, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    } catch { return send(res, 404, 'not found'); }
  }

  if ((m = /^\/api\/spectrum\/(\d+)\/(flac|mp3)\/(\d+)$/.exec(p)) && req.method === 'GET') {
    const q = await readState('queue.json', { items: [] });
    const item = q.items.find((i) => i.id === Number(m[1]));
    const file = item && item._files && (item._files[m[2]] || [])[Number(m[3])];
    if (!file) return send(res, 404, 'not found');
    const out = await spectrum(file);
    if (out === 'refused') return send(res, 404, 'not found');
    if (!out) return send(res, 503, 'not available now', { 'Retry-After': '10' });
    return send(res, 200, await fsp.readFile(out), { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
  }

  if (p === '/api/history' && req.method === 'GET') return json(res, 200, await history());

  if (p === '/api/job' && req.method === 'GET') {
    return json(res, 200, { job: jobView(job) });
  }

  // ---- changes: CSRF on every one
  if (req.method === 'POST') {
    if (!auth.validCsrf(req.headers['x-csrf'], sid, a)) {
      audit({ event: 'csrf-rejected', path: p });
      return json(res, 403, { error: 'bad CSRF token' });
    }
    const body = await readBody(req);
    const busy = () => json(res, 409, { error: 'another job is still running' });

    if (p === '/api/decide') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || !DECISIONS.has(body.decision)) return json(res, 400, { error: 'bad decision' });
      const q = await readState('queue.json', { items: [] });
      const item = q.items.find((i) => i.id === id);
      if (!item) return json(res, 404, { error: 'not in the queue' });
      const needs = body.decision.startsWith('watch') ? 'watch' : body.decision;
      if (!item.allowed.includes(needs)) return json(res, 400, { error: 'not available for this album' });
      const label = `${item.artist} — ${item.title}`;
      const args = ['resolve', String(id), body.decision];
      if (body.release !== undefined) {
        // which release to look for: an index into the list this album offers, nothing else
        const n = (item.releases || []).length;
        if (body.decision !== 'refetch' || !Number.isInteger(body.release) || body.release < 0 || body.release >= n) {
          return json(res, 400, { error: 'bad release' });
        }
        args.push(String(body.release));
      }
      if (STAGEABLE.has(body.decision)) {
        await stage(q, [{ id, decision: body.decision, release: body.release }]);
        audit({ event: 'stage', id, decision: body.decision, release: body.release, label });
        return json(res, 200, { staged: 1 });
      }
      audit({ event: 'decide', id, decision: body.decision, release: body.release, label });
      const j = startJob(body.decision, args, label);
      return j ? json(res, 202, { job: j.id }) : busy();
    }
    if (p === '/api/decide-many') {
      // one decision for several albums: ids are integers, each checked against the queue
      if (!MANY.has(body.decision) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 500
        || !body.ids.every(Number.isInteger)) return json(res, 400, { error: 'bad decision' });
      const q = await readState('queue.json', { items: [] });
      const ids = [...new Set(body.ids)].filter((id) => {
        const item = q.items.find((i) => i.id === id);
        return item && item.allowed.includes(body.decision);
      });
      if (!ids.length) return json(res, 400, { error: 'not available for any of these albums' });
      await stage(q, ids.map((id) => ({ id, decision: body.decision })));
      audit({ event: 'stage-many', ids, decision: body.decision });
      return json(res, 200, { staged: ids.length });
    }
    if (p === '/api/track') {
      // track tools: every argument is an integer index, checked against the album
      const id = Number(body.id);
      const q = await readState('queue.json', { items: [] });
      const item = Number.isInteger(id) && q.items.find((i) => i.id === id);
      if (!item) return json(res, 404, { error: 'not in the queue' });
      if (item.queue === 'arriving') return json(res, 400, { error: 'still arriving' });
      const nFlac = item.flac ? item.flac.tracks.length : 0;
      const nMp3 = item.mp3 ? item.mp3.tracks.length : 0;
      const idx = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
      let args;
      if (body.tool === 'pair' && idx(body.m, nMp3) && idx(body.f, nFlac)) args = ['pair', String(id), String(body.m), String(body.f)];
      else if (body.tool === 'unpair' && idx(body.m, nMp3)) args = ['unpair', String(id), String(body.m)];
      else if (body.tool === 'bin_track' && idx(body.f, nFlac)) args = ['bin-track', String(id), String(body.f)];
      else if (body.tool === 'reorder' && item.reorder && Array.isArray(body.order) && body.order.length === nFlac
        && body.order.every((v) => idx(v, nFlac)) && new Set(body.order).size === nFlac) {
        args = ['reorder', String(id), body.order.join(',')];
      } else if (body.tool === 'one_album' && (item.foreign || item.one_album) && typeof body.on === 'boolean') {
        args = ['one-album', String(id), body.on ? 'on' : 'off'];
      }
      if (!args) return json(res, 400, { error: 'bad track request' });
      const label = `${item.artist} — ${item.title}`;
      audit({ event: 'track', id, tool: body.tool, label });
      const j = startJob(body.tool, args, label);
      return j ? json(res, 202, { job: j.id }) : busy();
    }
    if (p === '/api/block') {
      // block the Soulseek user an album came from: the name comes from queue.json, never the browser
      const id = Number(body.id);
      const q = await readState('queue.json', { items: [] });
      const item = Number.isInteger(id) && q.items.find((i) => i.id === id);
      if (!item || !item.source || item.source.blocked) return json(res, 400, { error: 'no user to block for this album' });
      audit({ event: 'block-user', id, user: item.source.user });
      const j = startJob('block_user', ['block-user', String(id)], `Block ${item.source.user}`);
      return j ? json(res, 202, { job: j.id }) : busy();
    }
    if (p === '/api/approve-ready') {
      // stages Keep FLAC for every ready album; nothing moves until the staged list is approved.
      // Albums with no MP3 to replace are left out: nothing confirms them, so they are decided one by one.
      const q = await readState('queue.json', { items: [] });
      const ids = q.items.filter((i) => i.queue === 'ready' && i.status !== 'no_mp3'
        && i.allowed.includes('keep_flac')).map((i) => i.id);
      if (!ids.length) return json(res, 400, { error: 'nothing ready' });
      await stage(q, ids.map((id) => ({ id, decision: 'keep_flac' })));
      audit({ event: 'stage-ready', ids });
      return json(res, 200, { staged: ids.length });
    }
    if (p === '/api/unstage') {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000 || !body.ids.every(Number.isInteger)) {
        return json(res, 400, { error: 'bad ids' });
      }
      const q = await readState('queue.json', { items: [] });
      const drop = new Set(body.ids);
      await withStaged(async () => writeStaged((await readStaged(q)).filter((e) => !drop.has(e.id))));
      audit({ event: 'unstage', ids: body.ids });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/apply-staged') {
      // the ids to approve; what each one does comes from staged.json, never the request
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000 || !body.ids.every(Number.isInteger)) {
        return json(res, 400, { error: 'bad ids' });
      }
      const q = await readState('queue.json', { items: [] });
      const want = new Set(body.ids);
      const r = await withStaged(async () => {
        if (job && !job.done) return 'busy';
        const staged = await readStaged(q);
        const go = staged.filter((e) => want.has(e.id));
        if (!go.length) return 'none';
        const spec = go.map((e) => [e.id, e.decision, ...(e.release != null ? [e.release] : [])].join(':')).join(',');
        audit({ event: 'apply-staged', entries: go });
        const j = startJob('apply-staged', ['apply-staged', spec], `Approving ${go.length} decision${go.length === 1 ? '' : 's'}`);
        await writeStaged(staged.filter((e) => !want.has(e.id)));
        return { j, go };
      });
      if (r === 'busy') return busy();
      if (r === 'none') return json(res, 400, { error: 'none of those are staged' });
      const { j, go } = r;
      return json(res, 202, { job: j.id, n: go.length });
    }
    if (p === '/api/check') {
      const j = startJob('check', ['check'], 'Checking for new arrivals');
      return j ? json(res, 202, { job: j.id }) : busy();
    }
    if (p === '/api/undo') {
      const b = await readState('bin.json', { entries: [] });
      const entry = b.entries.find((e) => e.id === body.entry);
      if (!entry) return json(res, 404, { error: 'no such bin entry' });
      audit({ event: 'undo', entry: entry.id, label: entry.label });
      const j = startJob('undo', ['undo', entry.id], `Undo: ${entry.label}`);
      return j ? json(res, 202, { job: j.id }) : busy();
    }
    if (p === '/api/settings') {
      const days = body.retention_days;
      if (!Number.isInteger(days) || days < 0 || days > 3650) return json(res, 400, { error: 'bad setting' });
      const next = { ...(await readState('settings.json', {})), retention_days: days || null };
      await fsp.writeFile(path.join(STATE, 'settings.json.tmp'), JSON.stringify(next));
      await fsp.rename(path.join(STATE, 'settings.json.tmp'), path.join(STATE, 'settings.json'));
      audit({ event: 'settings', retention_days: days });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/bin/empty') {
      // the one delete in the app: CSRF plus the password again at press time, which
      // shares the sign-in lockout so a stolen session can't guess the password
      if (!auth.startAttempt()) return json(res, 429, { error: 'too many attempts, wait 5 minutes' });
      await new Promise((r) => setTimeout(r, 500));
      if (typeof body.password !== 'string' || !auth.verifyPassword(body.password, a)) {
        audit({ event: 'empty-denied', ip: req.socket.remoteAddress });
        return json(res, 401, { error: 'wrong password' });
      }
      auth.clearFailures();
      const days = (await readState('settings.json', {})).retention_days;
      if (body.older && !days) return json(res, 400, { error: 'no retention set' });
      audit({ event: 'empty-bin', older: body.older ? days : undefined });
      const j = body.older
        ? startJob('empty-bin', ['empty-bin', String(days)], `Emptying bin entries older than ${days} days`)
        : startJob('empty-bin', ['empty-bin'], 'Emptying the bin');
      return j ? json(res, 202, { job: j.id }) : busy();
    }
  }

  return json(res, 404, { error: 'not found' });
}

// ---- start -----------------------------------------------------------------

fs.mkdirSync(STATE, { recursive: true });
for (const host of HOSTS) {
  http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof BadBody) return json(res, 400, { error: e.message });
      console.error('[sift]', e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
      else res.end();
    });
  }).listen(PORT, host, () => console.log(`[sift] listening on ${host}:${PORT}`));
}
