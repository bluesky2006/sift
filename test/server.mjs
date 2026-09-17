// Server tests: auth, CSRF, what reaches the browser, audio confinement, and that the
// engine is only ever run with an id and a known decision. The engine is a stub here.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-srv-'));
const STATE = path.join(T, 'state');
const MUSIC = path.join(T, 'music');
const PORT = 18305;
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(MUSIC, 'Art/Alb'), { recursive: true });
fs.writeFileSync(path.join(MUSIC, 'Art/Alb/01.flac'), Buffer.alloc(10000, 7));
fs.writeFileSync(path.join(T, 'secret.flac'), 'secret');
fs.symlinkSync(path.join(T, 'secret.flac'), path.join(MUSIC, 'Art/Alb/link.flac'));
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(MUSIC, 'Art/Alb/tone.flac')]);

// the engine stub records its argv, and runs for a moment so a second job can collide
const stub = path.join(T, 'engine.sh');
fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${T}/calls\necho "can't: '/secret/job/a b.flac' missing: /secret/job/x" >&2\nsleep 1\n`, { mode: 0o755 });

fs.writeFileSync(path.join(STATE, 'queue.json'), JSON.stringify({
  checked: new Date().toISOString(),
  items: [{
    id: 1, artist: 'Art', title: 'Alb', queue: 'ready', reasons: ['r'], allowed: ['keep_flac', 'refetch', 'watch'], reorder: true,
    flac: { tracks: [{ name: '01.flac', secs: 3, fmt: '16-bit / 44.1 kHz', _path: '/secret/nested' }, { name: 'x' }, { name: 'link' }] },
    mp3: null, pairs: [], cover: false,
    _do: { flac_dir: '/secret/dir' },
    _files: { flac: [path.join(MUSIC, 'Art/Alb/01.flac'), '/etc/passwd', path.join(MUSIC, 'Art/Alb/link.flac')], mp3: [] },
  }, {
    id: 2, artist: 'Two', title: 'Tone', queue: 'suspect', releases: [{ release: 'x' }, { release: 'y' }], source: { user: 'baduser', albums: 1, bad: 1, blocked: false }, reasons: ['r'], allowed: ['keep_mp3', 'refetch', 'watch'],
    suspect: { low: 1, of: 1, hz: 16000, mp3_hz: null },
    flac: { tracks: [{ name: 'tone.flac', cutoff: 16000, lufs: -20 }] }, mp3: null, pairs: [], cover: false,
    _do: { flac_dir: '/secret/two' }, _files: { flac: [path.join(MUSIC, 'Art/Alb/tone.flac')], mp3: [] },
  }],
}));
fs.writeFileSync(path.join(STATE, 'bin.json'), JSON.stringify({ entries: [
  { id: 'b1', at: '2026-09-10T10:00:00', decision: 'keep_flac', album_id: 5, label: 'In — Bin', bytes: 100, ops: [{ op: 'move', from: '/secret/from', to: '/secret/to' }] }] }));
fs.writeFileSync(path.join(STATE, 'history.json'), JSON.stringify({
  emptied: [{ at: '2026-09-12T10:00:00', bytes: 5e9, entries: [{ id: 'e1', at: '2026-09-09T10:00:00', decision: 'keep_mp3', label: 'Gone — Album', bytes: 5e9 }] }],
  undone: [{ id: 'u1', at: '2026-09-08T10:00:00', decision: 'keep_flac', label: 'Undone — Album', undone: '2026-09-08T11:00:00' }],
}));
fs.writeFileSync(path.join(STATE, 'audit.log'), JSON.stringify({ at: '2026-09-11T10:00:00Z', event: 'job-done', kind: 'keep_flac', label: 'Broke — Album', ok: false, output: "rsync '/secret/music/Broke/Album': (2 left)\n" }) + '\n');

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOSTS: '127.0.0.1', SIFT_STATE: STATE,
    SIFT_AUTH_FILE: path.join(T, 'auth.json'), SIFT_PYTHON: stub, SIFT_AUDIO_ROOTS: MUSIC },
  stdio: 'ignore',
});

let failures = 0;
const check = (cond, what) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`); if (!cond) failures++; };
const base = `http://127.0.0.1:${PORT}`;
let jar = '';
async function req(p, { method = 'GET', body, csrf, headers = {} } = {}) {
  const r = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { ...(jar ? { Cookie: jar } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF': csrf } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) jar = set.split(';')[0];
  return r;
}

for (let i = 0; i < 50; i++) {
  try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

try {
  console.log('signed out');
  check((await req('/api/state')).status === 401, 'state needs a session');
  check((await req('/api/audio/1/flac/0')).status === 401, 'audio needs a session');
  check((await req('/app')).status === 302, 'app redirects to sign-in');

  console.log('password');
  check((await req('/api/auth/setup', { method: 'POST', body: { password: 'short' } })).status === 400, 'short password refused');
  check((await req('/api/auth/setup', { method: 'POST', body: { password: 'a-long-test-password' } })).status === 200, 'first setup works');
  jar = '';
  check((await req('/api/auth/setup', { method: 'POST', body: { password: 'another-long-password' } })).status === 409, 'setup cannot run twice');
  check((await req('/api/auth/login', { method: 'POST', body: { password: 'wrong-password-here' } })).status === 401, 'wrong password refused');
  check((await req('/api/auth/login', { method: 'POST', body: { password: 'a-long-test-password' } })).status === 200, 'right password signs in');
  const { csrf } = await (await req('/api/csrf')).json();

  console.log('nothing private reaches the browser');
  const st = await (await req('/api/state')).text();
  const al = await (await req('/api/album/1')).text();
  check(!st.includes('_do') && !st.includes('_files') && !st.includes(MUSIC), 'state carries no paths');
  check(!al.includes('_do') && !al.includes('_files') && !al.includes('/secret/dir'), 'album carries no paths');
  check(!al.includes('_path') && !al.includes('/secret/nested'), 'nor any nested _ key');
  const wrongHost = await new Promise((ok) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/auth/status', headers: { Host: 'evil.example' } },
    (r) => { r.resume(); ok(r.statusCode); }));
  check(wrongHost === 421, 'a request for another host name is refused');
  const stj = JSON.parse(st);
  check(stj.items[1].suspect.hz === 16000 && stj.items[1].allowed.includes('keep_mp3'), 'state carries the suspect flag and allowed decisions');

  console.log('history');
  const hist = await (await req('/api/history')).json();
  const outcomes = hist.events.map((e) => `${e.label}:${e.outcome}`);
  check(['In — Bin:bin', 'Gone — Album:emptied', 'Undone — Album:undone', 'Broke — Album:failed'].every((x) => outcomes.includes(x)),
    `history joins the bin, what left it and failed jobs (${outcomes.join(', ')})`);
  check(hist.totals.flac === 1 && hist.totals.mp3 === 1 && hist.totals.freed === 5e9, 'totals count the bin and emptied, not undone');
  check(!JSON.stringify(hist).includes('/secret'), 'history carries no paths');
  check(hist.events.find((e) => e.outcome === 'failed').error === "rsync '…': (2 left)", 'a failed job says why, without the path');

  console.log('spectrograms');
  let sp = await req('/api/spectrum/2/flac/0');
  check(sp.status === 200 && sp.headers.get('content-type') === 'image/png' && (await sp.arrayBuffer()).byteLength > 1000, 'a spectrogram is drawn');
  check(fs.readdirSync(path.join(STATE, 'spectra')).filter((f) => f.endsWith('.png') && !f.includes('tmp')).length === 1, 'and kept');
  check((await req('/api/spectrum/1/flac/1')).status === 404, 'not for a path outside the music folders');
  check((await req('/api/spectrum/1/flac/2')).status === 404, 'nor through a symlink');
  check((await req('/api/spectrum/2/mp3/0')).status === 404, 'nor for a track that is not there');
  check((await req('/api/cover/1/flac')).status === 404 && (await req('/api/cover/1/wav')).status === 404, 'side covers only by side name');

  console.log('audio');
  let r = await req('/api/audio/1/flac/0', { headers: { Range: 'bytes=100-199' } });
  check(r.status === 206 && r.headers.get('content-range') === 'bytes 100-199/10000'
    && (await r.arrayBuffer()).byteLength === 100, 'range request served');
  check((await req('/api/audio/1/flac/1')).status === 404, 'a queued path outside the music folders is refused');
  check((await req('/api/audio/1/flac/2')).status === 404, 'a symlink out of the music folders is refused');
  check((await req('/api/audio/1/flac/9')).status === 404, 'an index past the end is refused');
  check((await req('/api/audio/3/flac/0')).status === 404, 'an album not in the queue is refused');

  console.log('decisions');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_flac' } })).status === 403, 'no CSRF token, refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'rm -rf' }, csrf })).status === 400, 'unknown decision refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_mp3' }, csrf })).status === 400, 'decision the album does not allow refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'bin_album' }, csrf })).status === 400, 'Put in the bin only for Library health');
  check((await req('/api/decide', { method: 'POST', body: { id: '1; ls', decision: 'keep_flac' }, csrf })).status === 400, 'non-numeric id refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 7, decision: 'keep_flac' }, csrf })).status === 404, 'album not in queue refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_flac' }, csrf })).status === 202, 'allowed decision starts a job');
  check((await req('/api/check', { method: 'POST', body: {}, csrf })).status === 409, 'a second job waits its turn');
  await new Promise((res) => setTimeout(res, 1500));
  const calls = fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n');
  check(calls.length === 1 && calls[0].endsWith('resolve 1 keep_flac'), 'engine ran with id and decision only');

  console.log('releases');
  await new Promise((res) => setTimeout(res, 1200));
  check((await req('/api/decide', { method: 'POST', body: { id: 2, decision: 'refetch', release: 2 }, csrf })).status === 400, 'a release past the list refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 2, decision: 'refetch', release: 'rel-a' }, csrf })).status === 400, 'a release given by name refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 2, decision: 'keep_mp3', release: 1 }, csrf })).status === 400, 'a release only goes with a re-fetch');
  check((await req('/api/decide', { method: 'POST', body: { id: 2, decision: 'refetch', release: 1 }, csrf })).status === 202, 'a release by index starts a job');
  await new Promise((res) => setTimeout(res, 1500));
  check(fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n').pop().endsWith('resolve 2 refetch 1'), 'engine gets it as an integer');

  console.log('block a user');
  check((await req('/api/block', { method: 'POST', body: { id: 1 }, csrf })).status === 400, 'no user to block, refused');
  check((await req('/api/block', { method: 'POST', body: { id: 2, user: 'x' } })).status === 403, 'needs CSRF');
  check((await req('/api/block', { method: 'POST', body: { id: 2, user: 'someone-else' }, csrf })).status === 202, 'blocks by album id');
  await new Promise((res) => setTimeout(res, 1500));
  check(fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n').pop().endsWith('block-user 2'), 'the name never reaches the engine from the browser');

  console.log('several albums');
  await new Promise((res) => setTimeout(res, 200));
  check((await req('/api/decide-many', { method: 'POST', body: { decision: 'keep_flac', ids: [1] } })).status === 403, 'no CSRF token, refused');
  check((await req('/api/decide-many', { method: 'POST', body: { decision: 'watch_on', ids: [1] }, csrf })).status === 400, 'only the three decisions');
  check((await req('/api/decide-many', { method: 'POST', body: { decision: 'keep_mp3', ids: ['1; ls'] }, csrf })).status === 400, 'ids must be integers');
  check((await req('/api/decide-many', { method: 'POST', body: { decision: 'keep_mp3', ids: [1, 99] }, csrf })).status === 400, 'refused when no album allows it');
  r = await req('/api/decide-many', { method: 'POST', body: { decision: 'refetch', ids: [2, 1, 99, 2] }, csrf });
  check(r.status === 202 && (await r.json()).n === 2, 'albums that allow it start one job');
  await new Promise((res) => setTimeout(res, 1500));
  const many = fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n').pop();
  check(many.endsWith('resolve-many refetch 2,1'), `engine gets the decision and integer ids (${many})`);

  console.log('track tools');
  await new Promise((res) => setTimeout(res, 200));
  check((await req('/api/track', { method: 'POST', body: { id: 1, tool: 'bin_track', f: 5 }, csrf })).status === 400, 'track index past the end refused');
  check((await req('/api/track', { method: 'POST', body: { id: 1, tool: 'bin_track', f: '0; rm' }, csrf })).status === 400, 'non-integer index refused');
  check((await req('/api/track', { method: 'POST', body: { id: 1, tool: 'reorder', order: [0, 0, 1] }, csrf })).status === 400, 'order repeating a track refused');
  check((await req('/api/track', { method: 'POST', body: { id: 1, tool: 'one_album', on: true }, csrf })).status === 400, 'one album refused when the folder holds no other album');
  check((await req('/api/track', { method: 'POST', body: { id: 1, tool: 'reorder', order: [2, 0, 1] }, csrf })).status === 202, 'a valid reorder starts a job');
  await new Promise((res) => setTimeout(res, 1500));
  const last = fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n').pop();
  check(last.endsWith('reorder 1 2,0,1'), 'engine gets the order as integers only');

  console.log('bin');
  check((await req('/api/undo', { method: 'POST', body: { entry: '../../etc' }, csrf })).status === 404, 'unknown bin entry refused');
  check((await req('/api/bin/empty', { method: 'POST', body: { password: 'nope' }, csrf })).status === 401, 'emptying needs the password');
  check((await req('/api/bin/empty', { method: 'POST', body: { password: 'a-long-test-password' } })).status === 403, 'and a CSRF token');
  check((await req('/api/bin/empty', { method: 'POST', body: { password: 'a-long-test-password', older: true }, csrf })).status === 400, 'emptying the old part needs a retention setting');
  check((await req('/api/settings', { method: 'POST', body: { retention_days: '30; rm' }, csrf })).status === 400, 'retention must be a whole number of days');
  check((await req('/api/settings', { method: 'POST', body: { retention_days: 30 }, csrf })).status === 200
    && (await (await req('/api/state')).json()).settings.retention_days === 30, 'retention is saved');
  check((await req('/api/bin/empty', { method: 'POST', body: { password: 'a-long-test-password', older: true }, csrf })).status === 202, 'then the old part can be emptied');
  await new Promise((res) => setTimeout(res, 1500));
  check(fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n').pop().endsWith('empty-bin 30'), 'with the days from the setting, not the browser');

  console.log('engine output');
  const jobText = JSON.stringify(await (await req('/api/job')).json()) + JSON.stringify(await (await req('/api/history')).json());
  check(jobText.includes("can't") && !jobText.includes('/secret'), 'paths in job output and history are hidden, quoted or not');

  console.log('sign out');
  const old = jar;
  await req('/api/auth/logout', { method: 'POST', csrf });
  jar = old;
  check((await req('/api/state')).status === 401, 'signing out ends the session, even if its cookie is kept');
  check((await req('/api/auth/login', { method: 'POST', body: { password: 'a-long-test-password' } })).status === 200
    && (await req('/api/state')).status === 200, 'and signing in again works');
  const csrf2 = (await (await req('/api/csrf')).json()).csrf;

  console.log('lockout');
  const burst = await Promise.all(Array.from({ length: 30 }, () =>
    req('/api/auth/login', { method: 'POST', body: { password: 'wrong-password-here' } })));
  check(burst.filter((r) => r.status === 401).length <= 10 && burst.some((r) => r.status === 429),
    'guesses sent all at once still stop at the limit');
  check((await req('/api/bin/empty', { method: 'POST', body: { password: 'wrong-password-here' }, csrf: csrf2 })).status === 429,
    'and the password re-ask for emptying shares the lockout');

} finally {
  server.kill();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
