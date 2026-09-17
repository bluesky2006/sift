// Drives the real page in headless Chrome against a throwaway instance with a stub engine,
// to catch what the API tests can't: a handler that doesn't fire, a mode that doesn't
// render, a script error. Needs playwright-core in /tmp/node_modules and Chrome at
// /usr/bin/google-chrome, as Switchboard's ui test does.
import { spawn, execFileSync } from 'node:child_process';
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

// real audio for the A/B test: a 20 s tone per version
const MEDIA = path.join(T, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
for (const [name, codec, freq] of [['a.mp3', 'libmp3lame', 440], ['a.flac', 'flac', 660]]) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=20`, '-c:a', codec, path.join(MEDIA, name)]);
}
const t = (title, secs) => ({ name: `${title}.x`, title, secs, fmt: '16-bit / 44.1 kHz' });
fs.writeFileSync(path.join(STATE, 'queue.json'), JSON.stringify({
  checked: new Date().toISOString(),
  items: [
    { id: 1, artist: 'Band', title: 'Record', queue: 'different', reasons: ['1 MP3 track not matched'],
      diagnosis: { kind: 'pair', suggest: 'pair', text: "Three has no fingerprint match, but the FLAC's Two again is the same length." },
      allowed: ['keep_flac', 'keep_mp3', 'refetch', 'watch'], watch: false, foreign: true, one_album: false, reorder: true,
      flac: { tracks: [t('One', 100), t('Three', 300), t('Two', 200), t('Two again', 200)], seconds: 800 },
      mp3: { tracks: [t('One', 100), t('Two', 200), t('Three', 300)], seconds: 600 },
      pairs: [{ m: 0, f: 0, sim: 0.97, same: true }, { m: 1, f: 2, sim: 0.96, same: true }, { m: 2, f: 3, sim: 0.6, same: false }],
      cover: false, _files: { flac: [], mp3: [] } },
    { id: 2, artist: 'Other', title: 'Fine', queue: 'ready', reasons: ['Every track matches'],
      allowed: ['keep_flac', 'refetch', 'watch'], watch: true, reorder: true,
      flac: { tracks: [{ ...t('A', 60), lufs: -11, cutoff: 22050 }], seconds: 60,
        details: { release: 'aaaaaaaa-1111-2222-3333-444444444444', date: '2012-03-01', original: '1971-05-10', label: 'Rhino', tags: { catalognumber: 'R2 1234' } } },
      mp3: { tracks: [{ ...t('A', 60), lufs: -14, cutoff: 16000 }], seconds: 60,
        details: { release: 'bbbbbbbb-1111-2222-3333-444444444444', date: '1971-05-10', original: '1971-05-10', label: 'Cotillion', tags: {} } },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }], cover: false,
      _files: { flac: [path.join(MEDIA, 'a.flac')], mp3: [path.join(MEDIA, 'a.mp3')] } },
    { id: 3, artist: 'Faker', title: 'Transcode', queue: 'suspect', reasons: ['Possibly a converted MP3: 1 of 1 FLAC tracks stop around 16.0 kHz'],
      allowed: ['keep_flac', 'keep_mp3', 'refetch', 'watch'], watch: false, suspect: { low: 1, of: 1, hz: 16000, mp3_hz: 16000 },
      flac: { tracks: [{ ...t('A', 60), cutoff: 16000 }], seconds: 60 }, mp3: { tracks: [t('A', 60)], seconds: 60 },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }], cover: false, _files: { flac: [], mp3: [] } },
    { id: 4, artist: 'Cband', title: 'Next One', queue: 'different', reasons: ['r'], allowed: ['keep_mp3', 'refetch', 'watch'],
      diagnosis: { kind: 'missing', suggest: 'refetch', text: 'The FLAC is missing 1 track the MP3 has: A.' },
      flac: { tracks: [t('A', 60)], seconds: 60 }, mp3: { tracks: [t('A', 60), t('B', 60)], seconds: 120 },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }, { m: 1, f: null, sim: null, same: false }], cover: false, _files: { flac: [], mp3: [] } },
  ],
}));
fs.writeFileSync(path.join(STATE, 'bin.json'), JSON.stringify({ entries: [
  { id: 'e1', at: new Date().toISOString(), decision: 'reorder', label: 'Band — Record', bytes: 0, ops: [] }] }));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOSTS: '127.0.0.1', SIFT_STATE: STATE,
    SIFT_AUTH_FILE: path.join(T, 'auth.json'), SIFT_PYTHON: stub, SIFT_AUDIO_ROOTS: MEDIA },
  stdio: 'ignore',
});
for (let i = 0; i < 50; i++) {
  try { await fetch(BASE + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

let failures = 0;
const check = (cond, what) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`); if (!cond) failures++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=user-gesture-required'] });
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
  check((await page.locator('.jump a').allTextContents()).join('|') === 'Ready 1|Suspect FLAC 1|Different or unconfirmed 2', 'section links with counts');
  check((await page.locator('#q-suspect .badge.bad').textContent()) === 'FLAC stops at 16.0 kHz', 'a suspect album shows where its FLAC stops');

  console.log('search, sort, select');
  await page.fill('#search', 'fine');
  await page.waitForTimeout(200);
  check(await page.locator('a.row').count() === 1 && (await page.locator('.jump a').allTextContents()).join('|') === 'Ready 1', 'search filters every queue');
  await page.fill('#search', 'zzz');
  check((await page.locator('#queues').textContent()).includes('No album matches'), 'and says when nothing matches');
  await page.fill('#search', '');
  await page.selectOption('#sort', 'arrived');
  check(await page.evaluate(() => localStorage.getItem('sift-sort')) === 'arrived', 'sort is remembered');
  await page.click('#selecting');
  check(await page.locator('input.pick').count() === 4 && await page.locator('#selbar').isVisible(), 'Select shows checkboxes and the decision bar');
  await page.click('[data-all="ready"]');
  await page.locator('input[data-pick="3"]').check();
  check((await page.locator('#selcount').textContent()) === '2 selected', 'Select all and a tick both count');
  check((await page.locator('[data-many="keep_mp3"]').textContent()) === 'Keep MP3 (1)', 'a decision says how many albums it applies to');
  await page.click('[data-many="refetch"]');
  check((await page.locator('#dtitle').textContent()) === 'Get a better FLAC for 2 albums?', 'confirm names the count');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => /resolve-many refetch (2,3|3,2)$/.test(c)), 'the selection goes as one job');
  check(await page.locator('#selbar').isHidden() && await page.locator('input.pick').count() === 0, 'and Select mode ends');
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

  console.log('A/B');
  await page.goto(BASE + '/app');
  await page.waitForSelector('.queue');
  await page.click('a.row[href="#/album/2"]');
  await page.waitForSelector('.play[data-side="mp3"]');
  await page.click('.play[data-side="mp3"]');
  await page.waitForTimeout(3000);
  const decks = () => page.evaluate(() => [...document.querySelectorAll('audio')].map((d) =>
    ({ src: d.getAttribute('src') || '', paused: d.paused, t: d.currentTime, ready: d.readyState })));
  let d = await decks();
  const mp3Deck = d.find((x) => x.src.endsWith('/mp3/0'));
  const flacDeck = d.find((x) => x.src.endsWith('/flac/0'));
  check(mp3Deck && !mp3Deck.paused && mp3Deck.t > 1, 'MP3 plays');
  check(flacDeck && flacDeck.paused && flacDeck.ready >= 1, 'the FLAC waits loaded beside it');
  const before = mp3Deck.t;
  await page.click('#ab');
  await page.waitForTimeout(250);
  d = await decks();
  const nowFlac = d.find((x) => x.src.endsWith('/flac/0'));
  const nowMp3 = d.find((x) => x.src.endsWith('/mp3/0'));
  check(!nowFlac.paused && nowMp3.paused, 'A/B switches to the FLAC at once');
  check(Math.abs(nowFlac.t - before) < 1.5, `at the same moment (${before.toFixed(1)} → ${nowFlac.t.toFixed(1)})`);
  check((await page.locator('#pside').textContent()) === 'FLAC', 'player says FLAC');
  await page.waitForTimeout(1000);
  await page.click('#ab');
  await page.waitForTimeout(250);
  d = await decks();
  check(!d.find((x) => x.src.endsWith('/mp3/0')).paused && d.find((x) => x.src.endsWith('/flac/0')).paused, 'and back again');

  console.log('volume matching');
  check((await page.locator('#pdiff').textContent()) === 'FLAC is 3.0 dB louder', 'the player shows the loudness difference');
  await page.check('#match');
  await page.waitForTimeout(1500);
  d = await decks();
  const live = d.find((x) => !x.paused);
  check(live && live.t > 0 && (await page.locator('#pdiff').textContent()).endsWith('matched'), 'matching keeps it playing');
  const g = Object.fromEntries(await page.evaluate(() => decks.map((dk) =>
    [dk.getAttribute('src').includes('/flac/') ? 'flac' : 'mp3', Math.round(gains.get(dk).gain.value * 1000) / 1000])));
  check(g.flac === 0.708 && g.mp3 === 1, `the louder FLAC is turned down 3 dB (${JSON.stringify(g)})`);

  console.log('keyboard');
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  check((await decks()).every((x) => x.paused), 'Space pauses');
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  const t0 = (await decks()).find((x) => !x.paused).t;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  check((await decks()).find((x) => !x.paused).t > t0 + 8, 'Right arrow skips 10 seconds');
  const sideBefore = await page.locator('#pside').textContent();
  await page.keyboard.press('a');
  await page.waitForTimeout(300);
  check((await page.locator('#pside').textContent()) !== sideBefore, 'A switches version');
  await page.keyboard.press('?');
  check(await page.locator('#keys').isVisible(), '? lists the shortcuts');
  await page.keyboard.press('Escape');
  await page.click('#pclose');

  console.log('release details and spectrograms');
  const said = await page.locator('#facts summary').textContent();
  check(said.includes('FLAC is the 2012 reissue; MP3 is the 1971 original.'), `details say which release is which (${said})`);
  await page.click('#facts summary');
  check(await page.locator('#facts tr.differ').count() === 3, 'differences are highlighted: release, year, label');
  check((await page.locator('#facts').textContent()).includes('R2 1234'), 'catalogue number from the tags');
  check(await page.locator('.tmeta .low').count() === 0 && (await page.locator('.tmeta').first().textContent()).includes('to 16.0 kHz'), 'tracks show where they stop');
  await page.click('#tspectra');
  await page.waitForSelector('.spec img');
  await page.waitForFunction(() => [...document.querySelectorAll('.spec img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {});
  check(await page.evaluate(() => [...document.querySelectorAll('.spec img')].map((i) => i.naturalWidth > 0)).then((v) => v.length === 2 && v.every(Boolean)), 'both versions get a spectrogram');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.spec').count() === 0 && await page.locator('[data-decide]').count() > 0, 'Esc leaves spectrograms');

  await page.goto(BASE + '/app#/album/3');
  await page.waitForSelector('.tmeta');
  check(await page.locator('.tmeta .low').count() === 1, 'a FLAC track stopping short is marked');

  console.log('diagnosis and next album');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.diag');
  check((await page.locator('.diag').textContent()).startsWith('Three has no fingerprint match'), 'the diagnosis leads the album');
  check(await page.locator('#tpair.primary').count() === 1, 'a suggested pairing is the highlighted tool');
  check((await page.locator('#later').textContent()) === 'Next album', 'Later offers the next album in the queue');
  await page.keyboard.press('j');
  await page.waitForSelector('.diag >> text=missing');
  check(await page.locator('[data-decide="refetch"].primary .sugg').count() === 1, 'J opens the next album, whose suggested decision is highlighted');
  await page.keyboard.press('k');
  await page.waitForSelector('.diag >> text=Three');
  check(true, 'K goes back');
  await page.keyboard.press('2');
  check((await page.locator('#dtitle').textContent()) === 'Keep MP3?', '2 asks to Keep MP3');
  await page.click('#dok');
  await page.waitForSelector('.diag >> text=missing', { timeout: 8000 }).catch(() => {});
  check(calls().some((c) => c.endsWith('resolve 1 keep_mp3')) && page.url().endsWith('#/album/4'), 'after the decision, the next album opens');

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
  await page.evaluate(() => { location.hash = '#/history'; });
  await page.waitForSelector('.tiles');
  check((await page.locator('.histrow .rtitle').first().textContent()) === 'Band — Record' && await page.locator('.tile').count() === 4, 'history lists decisions with totals');
  check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
