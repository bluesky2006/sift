// Drives the real page in headless Chrome against a throwaway instance with a stub engine,
// to catch what the API tests can't: a handler that doesn't fire, a mode that doesn't
// render, a script error. Needs playwright-core in /tmp/node_modules and Chrome at
// /usr/bin/google-chrome, as Switchboard's ui test does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-ui-'));
const STATE = path.join(T, 'state');
const PORT = 18395;
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(STATE, { recursive: true });
const stub = path.join(T, 'engine.sh');
fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${T}/calls\n`, { mode: 0o755 });
const calls = () => { try { return fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } };

const t = (title, secs) => ({ name: `${title}.x`, title, secs, fmt: '16-bit / 44.1 kHz' });
fs.writeFileSync(path.join(STATE, 'queue.json'), JSON.stringify({
  checked: new Date().toISOString(),
  items: [
    { id: 1, artist: 'Band', title: 'Record', queue: 'different', reasons: ['1 MP3 track not matched'],
      allowed: ['keep_flac', 'keep_mp3', 'refetch', 'watch'], watch: false, foreign: true, one_album: false, reorder: true,
      flac: { tracks: [t('One', 100), t('Three', 300), t('Two', 200), t('Two again', 200)], seconds: 800 },
      mp3: { tracks: [t('One', 100), t('Two', 200), t('Three', 300)], seconds: 600 },
      pairs: [{ m: 0, f: 0, sim: 0.97, same: true }, { m: 1, f: 2, sim: 0.96, same: true }, { m: 2, f: 3, sim: 0.6, same: false }],
      cover: false, _files: { flac: [], mp3: [] } },
    { id: 2, artist: 'Other', title: 'Fine', queue: 'ready', reasons: ['Every track matches'],
      allowed: ['keep_flac', 'refetch', 'watch'], watch: true, reorder: true,
      flac: { tracks: [t('A', 60)], seconds: 60 }, mp3: { tracks: [t('A', 60)], seconds: 60 },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }], cover: false, _files: { flac: [], mp3: [] } },
  ],
}));
fs.writeFileSync(path.join(STATE, 'bin.json'), JSON.stringify({ entries: [
  { id: 'e1', at: new Date().toISOString(), decision: 'reorder', label: 'Band — Record', bytes: 0, ops: [] }] }));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOSTS: '127.0.0.1', SIFT_STATE: STATE,
    SIFT_AUTH_FILE: path.join(T, 'auth.json'), SIFT_PYTHON: stub },
  stdio: 'ignore',
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BASE + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

let failures = 0;
const check = (cond, what) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`); if (!cond) failures++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE + '/');
  await page.fill('#password', 'ui-test-password-long');
  await page.click('#go');
  await page.waitForURL(BASE + '/app');
  await page.waitForSelector('.queue');
  check(await page.locator('#approve').textContent() === 'Approve all 1', 'Ready queue offers Approve all');
  check((await page.locator('.qhead h2').allTextContents()).some((s) => s.startsWith('Different')), 'queues render');
  check((await page.locator('.jump a').allTextContents()).join('|') === 'Ready 1|Different or unconfirmed 1', 'section links with counts');
  await page.click('.jump a[data-jump="different"]');
  await page.waitForTimeout(500);
  check(await page.evaluate(() => Math.abs(document.getElementById('q-different').getBoundingClientRect().top) < 80
    || window.scrollY + window.innerHeight >= document.body.scrollHeight - 2), 'a section link jumps to its section');

  await page.click('a.row[href="#/album/1"]');
  await page.waitForSelector('.tracks');
  check(await page.locator('.trow').count() === 4, 'aligned rows include the unpaired FLAC track');
  check(await page.locator('#tone').isVisible(), '"folder is all one album" offered');

  console.log('pairing');
  await page.click('#tpair');
  await page.waitForSelector('.pairing');
  await page.locator('.trow').nth(2).locator('.cell').first().click();
  await page.waitForSelector('.cell.picked', { timeout: 5000 }).catch(() => {});
  check(await page.locator('.cell.picked').count() === 1, 'tapping an MP3 track selects it');
  await page.locator('.trow').nth(1).locator('.cell').last().click();
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('pair 1 2 2')), 'tapping a FLAC track pairs them');

  console.log('ordering');
  const openAlbum = async () => {
    await page.goto(BASE + '/app');
    await page.waitForSelector('.queue');
    await page.click('a.row[href="#/album/1"]');
    await page.waitForSelector('#torder');
  };
  await openAlbum();
  await page.click('#torder');
  await page.waitForSelector('.ordering');
  await page.waitForTimeout(300);
  const flacTitles = async () => page.locator('.ordering .trow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelectorAll('.cell')[1]?.querySelector('.ttitle')?.textContent) || ''));
  check((await flacTitles()).join() === 'One,Three,Two,Two again', 'order mode lists FLAC tracks as they are');
  check(await page.locator('#tsave').isDisabled(), 'save disabled until something moves');
  await page.click('#tmatch');
  await page.waitForTimeout(400);
  const got = (await flacTitles()).join();
  check(got === 'One,Two,Three,Two again', `Match MP3 order follows the pairs (${got})`);
  await page.click('[data-down="1"]');
  await page.waitForTimeout(400);
  check((await flacTitles()).join() === 'One,Three,Two,Two again', 'arrows move a track');
  await page.click('[data-up="2"]');
  await page.waitForTimeout(400);
  check((await flacTitles()).join() === 'One,Two,Three,Two again', 'and back');
  await page.click('#tsave');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('reorder 1 0,2,1,3')), 'saving sends the order');

  console.log('bin a track');
  await openAlbum();
  await page.click('#torder');
  await page.click('[data-bin="3"]');
  check((await page.locator('#dbody').textContent()).includes('Two again'), 'confirm names the track');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('bin-track 1 3')), 'the track goes to the bin');

  console.log('one album and bin view');
  await openAlbum();
  await page.click('#tone');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('one-album 1 on')), 'one album sent');
  await page.goto(BASE + '/app');
  await page.waitForSelector('.queue');
  await page.evaluate(() => { location.hash = '#/bin'; });
  await page.waitForSelector('.binrow');
  check((await page.locator('.binrow .rreason').textContent()).startsWith('FLAC tracks renumbered'), 'bin names a reorder');
  check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
