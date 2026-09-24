// Drives the real page in headless Chrome against a throwaway instance with a stub engine,
// to catch what the API tests can't: a handler that doesn't fire, a mode that doesn't
// render, a script error. Needs playwright-core in /tmp/node_modules and Chrome at
// /usr/bin/google-chrome, as Switchboard's ui test does.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
// apply-staged ($1 is the engine's path) answers as the engine does, a line per album as it starts and ends, slowly
// enough to watch rows leave the Staged list one at a time
fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${T}/calls\n`
  + `if [ "$2" = apply-staged ]; then for e in $(echo "$3" | tr , ' '); do id=\${e%%:*}; echo "working [$id] x"; sleep 0.8; `
  + `if [ "$id" = 3 ]; then echo "skipped [$id] x: no longer in the queue"; else echo "done [$id] keep: x"; fi; done; sleep 1; fi\n`, { mode: 0o755 });
const calls = () => { try { return fs.readFileSync(path.join(T, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } };

// real audio for the A/B test: a 20 s tone per version
const MEDIA = path.join(T, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
for (const [name, codec, freq] of [['a.mp3', 'libmp3lame', 440], ['a.flac', 'flac', 660]]) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=20`, '-c:a', codec, path.join(MEDIA, name)]);
}
const t = (title, secs, track, disc) => ({ name: `${title}.x`, title, secs, fmt: '16-bit / 44.1 kHz', track, disc });
fs.writeFileSync(path.join(STATE, 'queue.json'), JSON.stringify({
  checked: new Date().toISOString(),
  items: [
    { id: 1, artist: 'Band', title: 'Record', queue: 'different', reasons: ['1 MP3 track not matched'],
      diagnosis: { kind: 'pair', suggest: 'pair', text: "Three has no fingerprint match, but the FLAC's Two again is the same length." },
      allowed: ['keep_flac', 'keep_mp3', 'refetch', 'watch'], watch: false, foreign: true, one_album: false, reorder: true,
      flac: { tracks: [t('One', 100, 1, 1), t('Three', 300, 3, 1), t('Two', 200, 2, 1), t('Two again', 200, 1, 2)], seconds: 800 },
      mp3: { tracks: [t('One', 100, 1), t('Two', 200, 2), t('Three', 300)], seconds: 600 },
      pairs: [{ m: 0, f: 0, sim: 0.97, same: true }, { m: 1, f: 2, sim: 0.96, same: true }, { m: 2, f: 3, sim: 0.6, same: false }],
      cover: false, _files: { flac: [], mp3: [] } },
    { id: 2, artist: 'Other', title: 'Fine', queue: 'ready', reasons: ['Every track matches'],
      allowed: ['keep_flac', 'refetch', 'watch'], watch: true, reorder: true,
      flac: { tracks: [{ ...t('A', 60), lufs: -11, cutoff: 22050 }], seconds: 60,
        details: { release: 'aaaaaaaa-1111-2222-3333-444444444444', date: '2012-03-01', original: '1971-05-10', label: 'Rhino', imported: '2026-09-17T08:11:32', tags: { catalognumber: 'R2 1234' } } },
      mp3: { tracks: [{ ...t('A', 60), lufs: -14, cutoff: 16000 }], seconds: 60,
        details: { release: 'bbbbbbbb-1111-2222-3333-444444444444', date: '1971-05-10', original: '1971-05-10', label: 'Cotillion', imported: '2019-01-12T10:00:00', tags: {} } },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }], cover: false,
      _files: { flac: [path.join(MEDIA, 'a.flac')], mp3: [path.join(MEDIA, 'a.mp3')] } },
    { id: 3, artist: 'Faker', title: 'Transcode', queue: 'suspect', reasons: ['Possibly a converted MP3: 1 of 1 FLAC tracks stop around 16.0 kHz'],
      allowed: ['keep_flac', 'keep_mp3', 'refetch', 'watch'], watch: false, suspect: { low: 1, of: 1, hz: 16000, mp3_hz: 16000 },
      source: { user: 'faker99', albums: 2, bad: 2, blocked: false },
      flac: { tracks: [{ ...t('A', 60), cutoff: 16000 }], seconds: 60 }, mp3: { tracks: [t('A', 60)], seconds: 60 },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }], cover: false, _files: { flac: [], mp3: [] } },
    { id: 4, artist: 'Cband', title: 'Next One', queue: 'different', reasons: ['r'], allowed: ['keep_mp3', 'refetch', 'watch'],
      refetched: { on: '2026-09-21T12:52:00', checked: true },
      releases: [{ release: 'r-1', title: 'Next One', date: '1999-01-01', format: 'CD', country: 'UK', label: 'L', tracks: 1, selected: true },
        { release: 'r-2', title: 'Next One (deluxe)', date: '2010-01-01', format: 'CD', country: 'UK', label: 'L', tracks: 2, selected: false }],
      diagnosis: { kind: 'missing', suggest: 'refetch', text: 'The FLAC is missing 1 track the MP3 has: A.' },
      flac: { tracks: [t('A', 60)], seconds: 60 }, mp3: { tracks: [t('A', 60), t('B', 60)], seconds: 120, details: { release: 'r-2', tags: {} } },
      pairs: [{ m: 0, f: 0, sim: 0.99, same: true }, { m: 1, f: null, sim: null, same: false }], cover: false, _files: { flac: [], mp3: [] } },
    { id: 9, artist: 'Lone', title: 'White Label', queue: 'ready', status: 'no_mp3',
      reasons: ['No MP3 of this album to replace; every FLAC file decodes cleanly'],
      allowed: ['keep_flac', 'bin_album', 'refetch', 'watch'], watch: false,
      flac: { tracks: [t('A', 60)], seconds: 60 }, mp3: null, pairs: [], cover: false, _files: { flac: [], mp3: [] } },
    { id: 800000001, artist: 'Old', title: 'Library Rip', queue: 'health', reasons: ['2 FLAC file(s) with damaged audio'], allowed: ['bin_album', 'dismiss'],
      health: true, flac: { tracks: [{ ...t('A', 60), damaged: true, decoded_s: 60, bad_at: [45, 52] }, { ...t('B', 60), damaged: true, decoded_s: 20, bad_at: [20] }], seconds: 120 },
      mp3: null, pairs: [], cover: false, _files: { flac: [], mp3: [] } },
  ],
}));
fs.writeFileSync(path.join(STATE, 'bin.json'), JSON.stringify({ entries: [
  { id: 'e0', at: '2026-01-01T00:00:00Z', decision: 'keep_flac', label: 'Old — One', bytes: 2e9, ops: [] },
  { id: 'e1', at: new Date().toISOString(), decision: 'reorder', label: 'Band — Record', bytes: 0, ops: [] }] }));

// a server already on the port (another run) would answer in our place, and every check
// would be made against it
const taken = await new Promise((ok) => {
  const sock = net.connect(PORT, '127.0.0.1', () => { sock.destroy(); ok(true); });
  sock.on('error', () => ok(false));
});
if (taken) {
  console.error(`port ${PORT} is already in use, perhaps by another test run`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(1);
}
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
  check(await page.locator('#approve').textContent() === 'Stage all 1', 'Ready queue offers Stage all');
  check(await page.locator('#q-ready a.row').count() === 2
    && (await page.locator('#q-ready .badge.warn').textContent()) === 'No MP3 to replace',
    'a ready album with no MP3 to replace says so, and Stage all counts only the other one');
  check((await page.locator('.jump [role=tab]').allTextContents()).join('|') === 'Ready 2|Suspect FLAC 1|Different or unconfirmed 2|Health 1', 'queue tabs with counts');
  check(await page.locator('section.queue').count() === 1 && await page.locator('#q-ready').count() === 1, 'only the Ready tab shows at first');
  await page.click('[data-tab="suspect"]');
  check((await page.locator('#q-suspect .badge.bad').textContent()) === 'FLAC stops at 16.0 kHz', 'a tab shows its queue; a suspect album shows where its FLAC stops');
  check(await page.locator('#q-ready').count() === 0 && await page.evaluate(() => localStorage.getItem('sift-tab')) === 'suspect', 'and the tab is remembered');
  await page.click('[data-tab="different"]');
  check((await page.locator('#q-different a.row', { hasText: 'Next One' }).locator('.badge', { hasText: 'Refetched' }).textContent()).startsWith('Refetched 21 Sep')
    && await page.locator('#q-different .badge', { hasText: 'No MP3' }).count() === 0, 'a refetched album says when it went back, not that it has no MP3');
  await page.click('[data-tab="ready"]');

  console.log('search, sort, select');
  await page.fill('#search', 'fine');
  await page.waitForTimeout(200);
  check(await page.locator('a.row').count() === 1 && (await page.locator('.jump [role=tab]').allTextContents()).join('|') === 'Ready 1', 'search filters every queue');
  await page.fill('#search', 'zzz');
  check((await page.locator('#queues').textContent()).includes('No album matches'), 'and says when nothing matches');
  await page.fill('#search', '');
  await page.selectOption('#sort', 'arrived');
  check(await page.evaluate(() => localStorage.getItem('sift-sort')) === 'arrived', 'sort is remembered');
  await page.click('#selecting');
  check(await page.locator('input.pick').count() === 2 && await page.locator('#selbar').isVisible(), 'Select shows checkboxes and the decision bar');
  await page.click('[data-all="ready"]');
  check((await page.locator('#selcount').textContent()) === '2 selected', 'Select all takes the whole queue, no-MP3 album included');
  await page.locator('input[data-pick="9"]').uncheck();   // left out by hand, as Stage all would have done for us
  await page.click('[data-tab="suspect"]');
  await page.locator('input[data-pick="3"]').check();
  check((await page.locator('#selcount').textContent()) === '2 selected', 'Select all and a tick both count');
  check((await page.locator('[data-many="keep_mp3"]').textContent()) === 'Keep MP3 (1)', 'a decision says how many albums it applies to');
  await page.click('[data-many="refetch"]');
  await page.waitForSelector('[data-tab="staged"]');
  check(!calls().some((c) => /resolve|apply-staged/.test(c)), 'a decision on the selection is staged, and nothing runs');
  check(await page.locator('#selbar').isHidden() && await page.locator('input.pick').count() === 0, 'and Select mode ends');
  check((await page.locator('.jump [role=tab]').allTextContents()).join('|') === 'Staged 2|Ready 1|Different or unconfirmed 2|Health 1',
    'the staged albums leave their queues for a Staged tab');

  console.log('staged');
  await page.click('[data-tab="staged"]');
  check(await page.locator('.stagedrow').count() === 2 && (await page.locator('.badge.decision').first().textContent()) === 'Get a better FLAC',
    'each staged album says what it will do');
  check((await page.locator('#applystaged').textContent()) === 'Approve 2', 'everything starts ticked');
  await page.locator('input[data-approve="3"]').uncheck();
  check((await page.locator('#applystaged').textContent()) === 'Approve 1', 'unticking leaves it out');
  await page.click('#applystaged');
  check((await page.locator('#dbody').textContent()).startsWith('Get a better FLAC: 1'), 'approving confirms what will happen');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('apply-staged 2:refetch')), 'only the ticked decision runs');
  await page.click('[data-tab="staged"]').catch(() => {});
  await page.waitForSelector('[data-unstage="3"]');
  await page.click('[data-unstage="3"]');
  await page.waitForTimeout(300);
  check(await page.locator('[data-tab="staged"]').count() === 0 && await page.locator('[data-tab="suspect"]').count() === 1,
    'Remove sends an album back to its queue, and the tab goes when empty');
  await page.evaluate(async () => {
    const { csrf } = await (await fetch('/api/csrf')).json();
    await fetch('/api/decide-many', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf },
      body: JSON.stringify({ decision: 'refetch', ids: [2, 3] }) });
  });
  await page.goto(BASE + '/app#/'); await page.reload(); await page.waitForSelector('[data-tab="staged"]');
  await page.click('[data-tab="staged"]');
  await page.waitForTimeout(1500);   // the first approval's bar clears
  await page.click('#applystaged');
  await page.click('#dok');
  await page.waitForSelector('.stagedrow.working', { timeout: 4000 }).catch(() => {});
  check(await page.locator('.stagedrow.working').count() === 1 && await page.locator('.stagedrow.queued').count() === 2,
    'approving marks the rows, and the one being done spins');
  await page.waitForFunction(() => document.querySelectorAll('.stagedrow').length === 1, null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.stagedrow').count() === 1 && await page.locator('.jobbar #jobspin').isVisible(),
    'a done album leaves the list while the job is still running');
  await page.waitForSelector('.stagedrow.failed', { timeout: 5000 }).catch(() => {});
  check((await page.locator('.stagedrow.failed .rreason').textContent().catch(() => '')) === 'Skipped: no longer in the queue',
    'a skipped album stays, saying why');
  await page.waitForSelector('#jobclose:visible', { timeout: 5000 }).catch(() => {});
  await page.click('#jobclose').catch(() => {});
  await page.click('[data-tab="ready"]');

  await page.click('[data-tab="different"]');
  await page.click('a.row[href="#/album/1"]');
  await page.waitForSelector('.tracks');
  check(await page.locator('.trow').count() === 4, 'aligned rows include the unpaired FLAC track');
  check((await page.locator('.trow').first().locator('.tnum').allTextContents()).join('|') === '1|1-01'
    && (await page.locator('.cell:has-text("Two again") .tnum').textContent()) === '2-01',
    'track numbers, with the disc where a side spans more than one');
  check(await page.locator('.trow').nth(2).locator('.cell').first().locator('.tnum').count() === 0
    && (await page.locator('.trow').nth(2).locator('.cell').first().textContent()).includes('Three'), 'and none for a track without a tag');
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
  // the engine marks a hand pair manual, with no similarity; show it as one, with a way to forget it
  const queueFile = path.join(STATE, 'queue.json');
  const unpaired = fs.readFileSync(queueFile, 'utf8');
  const handPaired = JSON.parse(unpaired);
  handPaired.items[0].pairs[2] = { m: 2, f: 3, sim: null, same: true, manual: true };
  fs.writeFileSync(queueFile, JSON.stringify(handPaired));
  await page.goto(BASE + '/app');
  await page.waitForSelector('.queue');
  await page.click('[data-tab="different"]');
  await page.click('a.row[href="#/album/1"]');
  await page.waitForSelector('.tracks');
  check(await page.locator('.match.manual [data-unpair="2"]').isVisible(), 'a hand pair shows as one, with Forget this pair');
  await page.click('[data-unpair="2"]');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('unpair 1 2')), 'which forgets it');
  fs.writeFileSync(queueFile, unpaired);

  console.log('status pills');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.tracks');
  await page.locator('#status [data-goto]').first().click();
  await page.waitForSelector('.queue');
  check(await page.evaluate(() => location.hash) === '#/' && await page.evaluate(() => album) === null,
    'a status pill leaves the open album properly, so its keys stop acting on it');

  console.log('a job the server forgets');
  await page.route('**/api/job', (r) => r.fulfill({ contentType: 'application/json', body: '{"job":null}' }));
  const lostJob = await page.evaluate(() => watchJob());
  check(lostJob === null && await page.locator('#jobspin').isHidden()
    && (await page.locator('#joblabel').textContent()).includes('restarted') && await page.locator('#jobclose').isVisible(),
    'a restart mid-job ends the spinner and says so, rather than spinning forever');
  await page.unroute('**/api/job');
  await page.click('#jobclose');

  console.log('ordering');
  const openAlbum = async () => {
    await page.goto(BASE + '/app');
    await page.waitForSelector('.queue');
    await page.click('[data-tab="different"]');
    await page.click('a.row[href="#/album/1"]');
    await page.waitForSelector('#torder');
  };
  await openAlbum();
  await page.click('#torder');
  await page.waitForSelector('.ordering');
  await page.waitForTimeout(300);
  const flacTitles = async () => page.locator('.ordering .trow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelectorAll('.cell')[1]?.querySelector('.ttitle')?.lastChild?.textContent) || ''));   // the title, not its track number
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
  await page.click('[data-tab="ready"]');
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
  check((await page.locator('.totals').textContent()).includes('MP3 1:00 · 1 tracks · got 12 Jan 2019') && (await page.locator('.totals').textContent()).includes('FLAC 1:00 · 1 tracks · got 17 Sep 2026'),
    'the header says when each side arrived');
  check((await page.locator('#facts').textContent()).includes('17 Sep 2026, 08:11'), 'release details give the full date and time');
  check((await page.locator('#facts').textContent()).includes('R2 1234'), 'catalogue number from the tags');
  check(await page.locator('.tmeta .low').count() === 0 && (await page.locator('.tmeta').first().textContent()).includes('to 16.0 kHz'), 'tracks show where they stop');
  check(await page.locator('.tpath').count() === 0, 'file paths are hidden until asked for');
  await page.click('#more');
  await page.click('#paths');
  await page.waitForSelector('.tpath');
  check((await page.locator('.tpath').allTextContents()).join('|') === 'media/a.mp3|media/a.flac'
    && await page.evaluate(() => localStorage.getItem('sift-paths')) === 'on', 'Show file paths shows each file inside its music folder, and is remembered');
  await page.click('#more');
  check((await page.locator('#paths').textContent()).includes('Hide file paths'), 'the menu offers to hide them again');
  await page.click('#paths');
  await page.waitForSelector('.tpath', { state: 'detached' });
  check(await page.locator('.tpath').count() === 0, 'and does');
  await page.click('#tspectra');
  await page.waitForSelector('.spec img');
  await page.waitForFunction(() => [...document.querySelectorAll('.spec img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {});
  check(await page.evaluate(() => [...document.querySelectorAll('.spec img')].map((i) => i.naturalWidth > 0)).then((v) => v.length === 2 && v.every(Boolean)), 'both versions get a spectrogram');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.spec').count() === 0 && await page.locator('[data-decide]').count() > 0, 'Esc leaves spectrograms');

  await page.goto(BASE + '/app#/album/800000001');
  await page.waitForSelector('.badge.bad');
  check((await page.locator('.badge.bad').allTextContents()).join('|') === 'damaged · corrupt near 0:45 and 1 more place|damaged · decodes to 0:20 of 1:00',
    'a corrupt file says where, a truncated one how much');

  await page.goto(BASE + '/app#/album/3');
  await page.waitForSelector('.tmeta');
  check(await page.locator('.tmeta .low').count() === 1, 'a FLAC track stopping short is marked');
  check((await page.locator('.source').textContent()).includes('faker99') && (await page.locator('.source .bad').textContent()) === '2 suspect or damaged', 'the source user and their record show');
  await page.click('#block');
  check((await page.locator('#dtitle').textContent()) === 'Block faker99?', 'Block asks first');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('block-user 3')), 'and blocks by album id');

  console.log('diagnosis and next album');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.diag');
  check((await page.locator('.diag').textContent()).startsWith('Three has no fingerprint match'), 'the diagnosis leads the album');
  check(await page.locator('#tpair.primary').count() === 1, 'a suggested pairing is the highlighted tool');
  check((await page.locator('#later').textContent()) === 'Next album', 'Later offers the next album in the queue');
  await page.keyboard.press('k');
  await page.waitForSelector('.diag >> text=missing');
  check(await page.locator('[data-decide="refetch"].primary .sugg').count() === 1, 'K opens the next album, whose suggested decision is highlighted');
  await page.keyboard.press('j');
  await page.waitForSelector('.diag >> text=Three');
  check(true, 'J goes back');
  await page.keyboard.press('2');
  await page.waitForSelector('.diag >> text=missing', { timeout: 8000 }).catch(() => {});
  check(!calls().some((c) => c.endsWith('keep_mp3')) && page.url().endsWith('#/album/4'), '2 stages Keep MP3 and the next album opens');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.stagednote');
  check((await page.locator('.stagednote b').textContent()) === 'Keep MP3', 'a staged album says so');
  await page.click('#unstage');
  await page.waitForTimeout(500);
  check(await page.locator('.stagednote').count() === 0, 'and Remove unstages it there');

  console.log('no MP3 to replace');
  await page.goto(BASE + '/app#/album/9');
  await page.waitForSelector('[data-decide="keep_flac"]');
  check(await page.locator('[data-decide="keep_flac"].primary').count() === 0, 'Keep FLAC is not the suggested decision when nothing confirms the album');
  await page.click('[data-decide="keep_flac"]');
  check((await page.locator('#dbody').textContent()).includes('no MP3 of it to bin'), 'and the confirmation says nothing is being replaced');
  await page.click('#dcancel');
  check((await page.locator('.decisions button').allTextContents()).join('|') === 'Keep FLAC|Get a better FLAC|Put in the bin',
    'Put in the bin is offered, so an album that is not a good match can go');
  await page.click('[data-decide="bin_album"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.click('[data-tab="staged"]');
  await page.waitForSelector('[data-unstage="9"]');
  check((await page.locator('.stagedrow:has([data-unstage="9"]) .badge.decision').textContent()) === 'Put in the bin',
    'binning it waits in Staged like any other decision');
  await page.click('[data-unstage="9"]');                 // leave the queue as it was
  await page.waitForTimeout(300);

  console.log('library health');
  await page.goto(BASE + '/app#/album/800000001');
  await page.waitForSelector('[data-decide="dismiss"]');
  check((await page.locator('.decisions button').allTextContents()).join('|') === 'Put in the bin|Looks fine', 'a Library health album offers Put in the bin or Looks fine');
  await page.click('[data-decide="dismiss"]');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('resolve 800000001 dismiss')), 'Looks fine is sent');
  await page.goto(BASE + '/app#/album/4');
  await page.waitForSelector('[data-decide="refetch"]');

  console.log('choosing a release');
  await page.click('[data-decide="refetch"]');
  check(await page.locator('#dselect').isVisible() && (await page.locator('#dselect').inputValue()) === '1', "the MP3's release is preselected");
  await page.selectOption('#dselect', '0');
  await page.click('#dok');
  await page.waitForTimeout(800);
  const staged4 = await page.evaluate(async () => (await (await fetch('/api/state')).json()).staged.find((e) => e.id === 4));
  check(staged4 && staged4.release === '1999 · Next One · CD · UK', 'the chosen release is staged with it');
  await page.evaluate(async () => {
    const { csrf } = await (await fetch('/api/csrf')).json();
    await fetch('/api/unstage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf }, body: JSON.stringify({ ids: [4] }) });
  });

  console.log('buffering');
  await page.goto(BASE + '/app#/album/2');
  await page.waitForSelector('.play[data-side="flac"]');
  await page.route('**/api/audio/**', async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
  await page.click('.play[data-side="flac"]');
  await page.waitForTimeout(400);
  check(await page.locator('#pp.loading').count() === 1 && await page.locator('.play.on.loading').count() === 1
    && (await page.locator('#ptime').textContent()) === 'Loading…', 'a track still loading spins, and says so');
  await page.waitForFunction(() => !document.querySelector('#pp.loading'), null, { timeout: 8000 }).catch(() => {});
  check(await page.locator('.loading').count() === 0, 'and stops once it plays');
  await page.unroute('**/api/audio/**');
  await page.click('#pclose');

  console.log('previous and next');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.play[data-side="mp3"]');
  await page.locator('.play[data-side="mp3"]').first().click();
  await page.waitForTimeout(300);
  check(await page.locator('#pprev').isDisabled() && await page.locator('#pnext').isEnabled(), 'on the first track only Next is offered');
  await page.click('#pnext');
  await page.waitForTimeout(300);
  check((await page.locator('#ptitle').textContent()) === 'Two' && await page.locator('#pprev').isEnabled(), 'Next plays the next track');
  await page.click('#pprev');
  await page.waitForTimeout(300);
  check((await page.locator('#ptitle').textContent()) === 'One', 'and Previous goes back');
  // the player kept playing when we left the album, and both bars dock at the foot of the page
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.queue');
  await page.click('#selecting');
  check(await page.evaluate(() => {
    const b = document.getElementById('selbar').getBoundingClientRect();
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !document.getElementById('player').hidden && b.height > 0 && document.getElementById('selbar').contains(at);
  }), 'the selection bar sits clear of the player, not under it');
  await page.click('#selcancel');
  await page.goto(BASE + '/app#/album/1');
  await page.waitForSelector('.play[data-side="mp3"]');
  await page.click('#pclose');
  errors.length = 0; // the album has no audio files, so the decks' load errors are expected here

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
  check((await page.locator('.binrow .rreason').first().textContent()).startsWith('FLAC tracks renumbered'), 'bin names a reorder');
  await page.selectOption('#retention', '30');
  await page.waitForSelector('#emptyold');
  check((await page.locator('#emptyold').textContent()) === 'Empty 1 older than 30 days (2.0 GB)', 'a retention setting offers to empty the old part');
  await page.click('#emptyold');
  await page.fill('#dpassword', 'ui-test-password-long');
  await page.click('#dok');
  await page.waitForTimeout(1500);
  check(calls().some((c) => c.endsWith('empty-bin 30')), 'with the password, only the old part is emptied');
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
