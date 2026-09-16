// Server tests: auth, CSRF, what reaches the browser, audio confinement, and that the
// engine is only ever run with an id and a known decision. The engine is a stub here.
import { spawn } from 'node:child_process';
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

// the engine stub records its argv, and runs for a moment so a second job can collide
const stub = path.join(T, 'engine.sh');
fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${T}/calls\nsleep 1\n`, { mode: 0o755 });

fs.writeFileSync(path.join(STATE, 'queue.json'), JSON.stringify({
  checked: new Date().toISOString(),
  items: [{
    id: 1, artist: 'Art', title: 'Alb', queue: 'ready', reasons: ['r'], allowed: ['keep_flac', 'refetch', 'watch'], reorder: true,
    flac: { tracks: [{ name: '01.flac', secs: 3, fmt: '16-bit / 44.1 kHz' }, { name: 'x' }, { name: 'link' }] },
    mp3: null, pairs: [], cover: false,
    _do: { flac_dir: '/secret/dir' },
    _files: { flac: [path.join(MUSIC, 'Art/Alb/01.flac'), '/etc/passwd', path.join(MUSIC, 'Art/Alb/link.flac')], mp3: [] },
  }],
}));

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

  console.log('audio');
  let r = await req('/api/audio/1/flac/0', { headers: { Range: 'bytes=100-199' } });
  check(r.status === 206 && r.headers.get('content-range') === 'bytes 100-199/10000'
    && (await r.arrayBuffer()).byteLength === 100, 'range request served');
  check((await req('/api/audio/1/flac/1')).status === 404, 'a queued path outside the music folders is refused');
  check((await req('/api/audio/1/flac/2')).status === 404, 'a symlink out of the music folders is refused');
  check((await req('/api/audio/1/flac/9')).status === 404, 'an index past the end is refused');
  check((await req('/api/audio/2/flac/0')).status === 404, 'an album not in the queue is refused');

  console.log('decisions');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_flac' } })).status === 403, 'no CSRF token, refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'rm -rf' }, csrf })).status === 400, 'unknown decision refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_mp3' }, csrf })).status === 400, 'decision the album does not allow refused');
  check((await req('/api/decide', { method: 'POST', body: { id: '1; ls', decision: 'keep_flac' }, csrf })).status === 400, 'non-numeric id refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 7, decision: 'keep_flac' }, csrf })).status === 404, 'album not in queue refused');
  check((await req('/api/decide', { method: 'POST', body: { id: 1, decision: 'keep_flac' }, csrf })).status === 202, 'allowed decision starts a job');
  check((await req('/api/check', { method: 'POST', body: {}, csrf })).status === 409, 'a second job waits its turn');
  await new Promise((res) => setTimeout(res, 1500));
  const calls = fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n');
  check(calls.length === 1 && calls[0].endsWith('resolve 1 keep_flac'), 'engine ran with id and decision only');

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
  check(!fs.readFileSync(path.join(T, 'calls'), 'utf8').includes('empty-bin'), 'no engine run from refused requests');
} finally {
  server.kill();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
