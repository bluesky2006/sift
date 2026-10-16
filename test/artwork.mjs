// lib/artwork.js with the services faked: which pictures are offered, which is suggested,
// that only the services' image hosts are fetched from, and that a pick is by index only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Artwork, imageInfo, norm } = require('../lib/artwork.js');

let failures = 0;
const check = (cond, what) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}`); if (!cond) failures++; };

// a JPEG header that is only an SOF0 segment: enough for its size to be read
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0xff, 0xd9]);
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

console.log('picture sizes and names');
check(JSON.stringify(imageInfo(jpeg(1400, 1200))) === '{"ext":"jpg","w":1400,"h":1200}', 'a JPEG\'s size comes from its frame header');
check(JSON.stringify(imageInfo(png(3000, 3000))) === '{"ext":"png","w":3000,"h":3000}', 'a PNG\'s from its IHDR');
check(imageInfo(Buffer.from('<html>not a picture</html>')) === null, 'anything else is not a picture');
check(norm('Megaprojects Two - EP') === norm('Megaprojects Two') && norm('Lóve (Deluxe Edition)') === norm('love'),
  'names match without accents, an edition, or " - EP"');
check(norm('新しい日の誕生') === '新しい日の誕生', 'and a name with no Latin letters is still a name');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-art-'));
const fetched = [];
const pics = {
  'https://coverartarchive.org/release/00000000-0000-4000-8000-0000000000aa/front-1200': jpeg(1200, 1200),
  'https://coverartarchive.org/release-group/00000000-0000-4000-8000-0000000000bb/front-1200': jpeg(1200, 1200),   // the same picture
  'https://is1-ssl.mzstatic.com/a/3000x3000bb.jpg': png(3000, 3000),
  'https://is1-ssl.mzstatic.com/small/3000x3000bb.jpg': jpeg(600, 600),
  'https://is1-ssl.mzstatic.com/other/3000x3000bb.jpg': jpeg(3000, 3000),
  'https://cdn-images.dzcdn.net/d/1000x1000.jpg': jpeg(1000, 1000),
  'https://evil.example.com/x.jpg': jpeg(3000, 3000),
};
const reply = (status, body, type) => ({
  ok: status === 200, status, url: '', headers: { get: () => type },
  json: async () => body, arrayBuffer: async () => body,
});
const fakeFetch = async (url) => {
  fetched.push(url);
  const u = new URL(url);
  if (u.host === 'itunes.apple.com') {
    return reply(200, { results: [
      { artworkUrl100: 'https://is1-ssl.mzstatic.com/a/100x100bb.jpg', collectionName: 'One', artistName: 'Bare' },
      { artworkUrl100: 'https://is1-ssl.mzstatic.com/small/100x100bb.jpg', collectionName: 'One', artistName: 'Bare' },
      { artworkUrl100: 'https://is1-ssl.mzstatic.com/other/100x100bb.jpg', collectionName: 'Old Town Road', artistName: 'Lil Nas X' },
    ] }, 'application/json');
  }
  if (u.host === 'api.deezer.com') {
    return reply(200, { data: [{ cover_xl: 'https://cdn-images.dzcdn.net/d/1000x1000.jpg', title: 'One (Deluxe Edition)', artist: { name: 'Bare' } },
      { cover_xl: 'https://evil.example.com/x.jpg', title: 'One', artist: { name: 'Bare' } }] }, 'application/json');
  }
  if (u.host === 'musicbrainz.org') return reply(200, { 'release-groups': [] }, 'application/json');
  const pic = pics[url];
  if (!pic) return reply(404, null, 'text/html');
  const r = reply(200, pic, url.endsWith('.png') || pic[0] === 0x89 ? 'image/png' : 'image/jpeg');
  r.url = url;
  return r;
};

console.log('finding');
const aw = new Artwork({ state: T, fetchImpl: fakeFetch, pace: 0 });
const album = { id: 600000001, artist: 'Bare', title: 'One', rg: '00000000-0000-4000-8000-0000000000bb', release: '00000000-0000-4000-8000-0000000000aa' };
const got = await aw.findAndKeep(album);
check(got.state === 'suggested' && got.pick === 0 && got.cands[0].source === 'Cover Art Archive' && got.cands[0].sure,
  'the Cover Art Archive\'s picture for the release the files are is suggested first');
check(got.cands.filter((c) => c.source === 'Cover Art Archive').length === 1, 'the same picture from the release and its release group is offered once');
check(got.cands.every((c) => Math.min(c.w, c.h) >= 1000) && got.small === 1, 'only pictures at least 1000 px are offered; the smaller one is counted');
check(!got.cands.some((c) => c.album === 'Old Town Road') && !fetched.some((u) => u.includes('/other/')),
  'another artist\'s album from the name search is neither offered nor fetched');
check(!fetched.some((u) => u.startsWith('https://evil.example.com')), 'a picture on any host but the services\' is never fetched');
check(got.cands.find((c) => c.source === 'Deezer').same, 'Deezer\'s "One (Deluxe Edition)" counts as the same title');
check(fetched.some((u) => u.includes('/3000x3000bb.jpg')), 'Apple is asked for its largest picture');

console.log('keeping and choosing');
const before = fetched.length;
await aw.findAndKeep(album);
check(fetched.length === before, 'a searched album isn\'t searched again unless asked');
await aw.setSkipped(album.id, true);
await aw.findAndKeep(album, { again: true });
check((await aw.read()).albums[album.id].state === 'skipped', 'searching again leaves a skipped album skipped');
await aw.setSkipped(album.id, false);
check((await aw.read()).albums[album.id].state === 'suggested', 'and Suggest again brings its suggestion back');
const uploads = path.join(T, 'uploads');
const staged = await aw.stage(album.id, 1, uploads);
check(staged && path.dirname(staged) === uploads && fs.readFileSync(staged).equals(fs.readFileSync(aw.candFile((await aw.read()).albums[album.id].cands[1]))),
  'a pick is copied into uploads, for the engine to write');
check(await aw.stage(album.id, 99, uploads) === null && await aw.stage(album.id, -1, uploads) === null && await aw.stage(album.id, '0', uploads) === null,
  'an index that isn\'t one of its candidates gives nothing');
check(aw.candFile({ key: '../../etc/passwd', ext: 'jpg' }) === null && aw.candFile({ key: 'a'.repeat(40), ext: 'html' }) === null,
  'a candidate file is only ever a hash with jpg or png');

console.log('nothing sure');
const lone = await aw.findAndKeep({ id: 600000002, artist: 'Bare', title: 'Something Else' });
check(lone.state === 'none' && lone.pick === null && lone.cands.length > 0, 'pictures only by the same artist are offered, but none is suggested');

console.log('searching them all');
check(aw.startFind([album, { id: 600000003, artist: 'Bare', title: 'One' }]), 'a search over every album starts');
check(!aw.startFind([album]), 'and a second can\'t start alongside it');
while (!aw.jobView().done) await new Promise((r) => setTimeout(r, 20));
check(aw.jobView().ok && aw.jobView().of === 1 && aw.jobView().found === 1, 'only albums not yet searched are searched');
await aw.prune(new Set([600000003]));
const left = await aw.read();
check(Object.keys(left.albums).join() === '600000003', 'an album no longer listed is forgotten');

console.log('ticked albums');
const aw3 = new Artwork({ state: fs.mkdtempSync(path.join(os.tmpdir(), 'sift-art3-')), fetchImpl: fakeFetch, pace: 30 });
const many = [600000020, 600000021, 600000022, 600000023].map((id) => ({ id, artist: 'Bare', title: 'One' }));
aw3.startFind(many);
await new Promise((r) => setTimeout(r, 10));
check(aw3.findSome([many[3], album]) && aw3.jobView().of === 5, 'ticked albums join a search already running, counted once');
const order = [];
const seen3 = new Set();
while (!aw3.jobView().done) {
  const d = await aw3.read();
  for (const k of Object.keys(d.albums)) if (!seen3.has(k)) { seen3.add(k); order.push(Number(k)); }
  await new Promise((r) => setTimeout(r, 5));
}
check(order.indexOf(600000023) < order.indexOf(600000021) && order.indexOf(album.id) < order.indexOf(600000021), 'and are searched next, ahead of the rest');
const was = (await aw3.read()).albums[600000020].found;
await new Promise((r) => setTimeout(r, 5));
check(aw3.findSome([many[0]]), 'with nothing running, ticked albums start a search of their own');
while (!aw3.jobView().done) await new Promise((r) => setTimeout(r, 5));
check((await aw3.read()).albums[600000020].found !== was, 'searching an album already searched again');
aw3.startFind([{ id: 600000030, artist: 'Bare', title: 'One' }, { id: 600000031, artist: 'Bare', title: 'One' }]);
aw3.stop();
check(!aw3.findSome([many[1]]), 'a search being stopped takes none on');
while (!aw3.jobView().done) await new Promise((r) => setTimeout(r, 5));
fs.rmSync(aw3.state, { recursive: true, force: true });

console.log('after each check');
const aw2 = new Artwork({ state: fs.mkdtempSync(path.join(os.tmpdir(), 'sift-art2-')), fetchImpl: fakeFetch, pace: 0 });
const list = { checked: '2026-10-16T12:00:00', items: [album] };
check(await aw2.autoFind(list) && aw2.jobView().auto, 'a new check starts a search of the albums not yet searched');
while (!aw2.jobView().done) await new Promise((r) => setTimeout(r, 20));
check(!await aw2.autoFind(list), 'the same check never starts a second one');
check(!await aw2.autoFind({ checked: '2026-10-16T14:00:00', items: [album] }), 'nor does a new check with nothing left to search');
const more = { checked: '2026-10-16T16:00:00', items: [album, { id: 600000009, artist: 'Bare', title: 'One' }] };
aw2.startFind([{ id: 600000010, artist: 'Bare', title: 'One' }]);
check(!await aw2.autoFind(more), 'while a search runs, a new check waits');
while (!aw2.jobView().done) await new Promise((r) => setTimeout(r, 20));
check(await aw2.autoFind(more), 'and starts once it is done');
while (!aw2.jobView().done) await new Promise((r) => setTimeout(r, 20));
check(aw2.jobView().of === 1 && aw2.jobView().found === 1, 'searching only the new album');
fs.rmSync(aw2.state, { recursive: true, force: true });

fs.rmSync(T, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
