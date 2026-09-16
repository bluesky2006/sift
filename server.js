'use strict';
// Sift — review queue for Soularr's FLACs. See README.md and ~/notes/sift-review-plan.md.
//
// The browser only ever sends an album id or a bin entry id, plus a decision name from a
// fixed list. Paths come from queue.json and bin.json, which bin/sift.py writes, and every
// file operation is bin/sift.py run with a fixed argv. Nothing here moves or deletes a file.

const http = require('http');
const { spawn } = require('child_process');
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
  || '/mnt/roon-data/music-flac,/mnt/roon-music/MP3,/mnt/roon-music/FLAC-damaged').split(',');

const DECISIONS = new Set(['keep_flac', 'keep_mp3', 'refetch', 'watch_on', 'watch_off']);

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

// Keys starting with _ hold paths; they never leave the server.
const pub = (item) => Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith('_')));

// ---- jobs ------------------------------------------------------------------
// One engine run at a time from the app. The scheduled check takes the engine's own
// lock, so a decision pressed during a check simply waits for it.

let job = null;
function startJob(kind, args, label) {
  if (job && !job.done) return null;
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
  fs.createReadStream(real, { start, end }).pipe(res);
}

// ---- routes ----------------------------------------------------------------

async function handle(req, res) {
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
    if (auth.lockedOut()) return json(res, 429, { error: 'too many attempts, wait 5 minutes' });
    const body = await readBody(req);
    await new Promise((r) => setTimeout(r, 500));
    if (!a || typeof body.password !== 'string' || !auth.verifyPassword(body.password, a)) {
      auth.recordFailure();
      audit({ event: 'login-failed', ip: req.socket.remoteAddress });
      return json(res, 401, { error: 'wrong password' });
    }
    auth.clearFailures();
    audit({ event: 'login', ip: req.socket.remoteAddress });
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(auth.makeSession(a)) });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
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
      cover: i.cover, first_seen: i.first_seen, watch: i.watch,
      flac: i.flac ? { n: i.flac.tracks.length, fmt: (i.flac.tracks[0] || {}).fmt || '',
        damaged: i.flac.tracks.filter((t) => t.damaged).length } : null,
      mp3: i.mp3 ? { n: i.mp3.tracks.length, fmt: (i.mp3.tracks[0] || {}).fmt || '' } : null,
    }));
    return json(res, 200, {
      built: q.built, checked: q.checked, previous_check: q.previous_check, items,
      bin: b.entries.map((e) => ({ id: e.id, at: e.at, decision: e.decision, label: e.label, bytes: e.bytes || 0 }))
        .reverse(),
      job: job && { kind: job.kind, label: job.label, done: job.done, ok: job.ok, output: job.output },
    });
  }

  let m;
  if ((m = /^\/api\/album\/(\d+)$/.exec(p)) && req.method === 'GET') {
    const q = await readState('queue.json', { items: [] });
    const item = q.items.find((i) => i.id === Number(m[1]));
    return item ? json(res, 200, pub(item)) : json(res, 404, { error: 'not in the queue' });
  }

  if ((m = /^\/api\/audio\/(\d+)\/(flac|mp3)\/(\d+)$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) {
    const q = await readState('queue.json', { items: [] });
    const item = q.items.find((i) => i.id === Number(m[1]));
    const file = item && item._files && (item._files[m[2]] || [])[Number(m[3])];
    return file ? streamFile(req, res, file) : send(res, 404, 'not found');
  }

  if ((m = /^\/api\/cover\/(\d+)$/.exec(p)) && req.method === 'GET') {
    try {
      const body = await fsp.readFile(path.join(STATE, 'covers', `${Number(m[1])}.jpg`));
      return send(res, 200, body, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    } catch { return send(res, 404, 'not found'); }
  }

  if (p === '/api/job' && req.method === 'GET') {
    return json(res, 200, { job: job && { kind: job.kind, label: job.label, done: job.done, ok: job.ok, output: job.output } });
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
      audit({ event: 'decide', id, decision: body.decision, label });
      const j = startJob(body.decision, ['resolve', String(id), body.decision], label);
      return j ? json(res, 202, { job: j.id }) : busy();
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
    if (p === '/api/approve-ready') {
      audit({ event: 'approve-ready' });
      const j = startJob('approve-ready', ['approve-ready'], 'Approve all ready albums');
      return j ? json(res, 202, { job: j.id }) : busy();
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
    if (p === '/api/bin/empty') {
      // the one delete in the app: CSRF plus the password again at press time
      await new Promise((r) => setTimeout(r, 500));
      if (typeof body.password !== 'string' || !auth.verifyPassword(body.password, a)) {
        audit({ event: 'empty-denied', ip: req.socket.remoteAddress });
        return json(res, 401, { error: 'wrong password' });
      }
      audit({ event: 'empty-bin' });
      const j = startJob('empty-bin', ['empty-bin'], 'Emptying the bin');
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
