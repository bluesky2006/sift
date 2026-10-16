'use strict';
// Artwork found online for the FLAC library's albums that have none (artwork.json, which
// bin/sift.py writes). Adapted from Crate's lib/covers.js.
//
//   find     one album, or every album in the background, paced for the services' rate
//            limits (Apple allows about 20 searches a minute, MusicBrainz one a second). The
//            Cover Art Archive is asked by the album's MusicBrainz ids where its tags or
//            Lidarr-FLAC have them, else MusicBrainz is searched by name; Apple (iTunes Search)
//            and Deezer are searched by artist and album. Pictures are fetched here, from those
//            services' image hosts only, and kept as they came (JPEG or PNG, no bigger than
//            12 MB) in STATE/artwork/cand, so the browser only ever loads them from Sift.
//   hi-res   only pictures at least MIN_PX on their shorter side, and near square, are offered.
//            Apple is asked for its largest (it never scales a picture up past its original);
//            Deezer's are always 1000 px; the Cover Art Archive's are its 1200 px thumbnails.
//   suggest  a search over every album leaves the best picture that is surely this album (the
//            Cover Art Archive's by MusicBrainz id, or a same-named album by the same artist)
//            as a suggestion. Nothing is written until Simon picks one, or uses the suggestions.
//
// What the browser sends is an album id and an index into its candidates; the picture it
// chose is copied into STATE/uploads and written by the engine's art command, like a dropped one.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const UA = 'Sift/1.0 (a personal music library tool on roon)';
const MIN_PX = 1000;
const IMAGE_HOSTS = [/\.mzstatic\.com$/, /(^|\.)dzcdn\.net$/, /^coverartarchive\.org$/, /(^|\.)archive\.org$/];
const KEY = /^[a-f0-9]{40}$/;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// a response's body, or null past max bytes (read as it comes, so a huge one is never held)
async function readCapped(r, max) {
  if (!r.body || typeof r.body.getReader !== 'function') {
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

// a JPEG's or PNG's size from its own header: { ext, w, h }, or null for anything else
function imageInfo(buf) {
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    // the start-of-frame markers, the ones that carry the size (not DHT, JPG, DAC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { ext: 'jpg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const hiRes = (c) => Math.min(c.w, c.h) >= MIN_PX && Math.max(c.w, c.h) <= Math.min(c.w, c.h) * 1.15;

// names compared without accents, case, punctuation, or an edition in brackets or after " - "
function norm(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s*[([][^)\]]*(edition|remaster|deluxe|expanded|version|anniversary|bonus|reissue)[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+(ep|single|lp)$/, '').replace(/\s*\((ep|single|lp)\)$/, '');
  const squashed = t.replace(/[^\p{L}\p{N}]/gu, '');
  return squashed || t.trim();
}
// a compilation filed under "Various Artists" or "Compilations" matches whoever a service credits
const ANYONE = new Set(['variousartists', 'various', 'va', 'compilations', 'compilation', 'soundtrack', 'soundtracks']);
const sameArtist = (a, b) => {
  const x = norm(a), y = norm(b);
  return ANYONE.has(y) || ANYONE.has(x) || (!!x && !!y && (x === y || x.includes(y) || y.includes(x)));
};

class Artwork {
  constructor({ state, audit = () => {}, fetchImpl = fetch, pace = 3000 }) {
    Object.assign(this, { state, audit, fetch: fetchImpl, pace });
    this.dir = path.join(state, 'artwork');
    this.job = null;
    this.lock = Promise.resolve();
  }

  async read() {
    try { return JSON.parse(await fsp.readFile(path.join(this.dir, 'found.json'), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return { albums: {} };
      throw e;
    }
  }
  // read-change-write on found.json one at a time, written whole before it replaces the old
  change(fn) {
    const go = this.lock.then(async () => {
      const data = await this.read();
      const out = await fn(data);
      if (out && out.write) {
        await fsp.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, 'found.json');
        const tmp = `${file}.${process.pid}.tmp`;
        const fh = await fsp.open(tmp, 'w');
        try { await fh.writeFile(JSON.stringify(data)); await fh.sync(); } finally { await fh.close(); }
        await fsp.rename(tmp, file);
      }
      return out;
    });
    this.lock = go.catch(() => {});
    return go;
  }

  candFile(c) { return c && KEY.test(c.key) && ['jpg', 'png'].includes(c.ext) ? path.join(this.dir, 'cand', `${c.key}.${c.ext}`) : null; }

  async getJson(url) {
    const r = await this.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`${new URL(url).host} said ${r.status}`);
    return r.json();
  }

  // [{ url, source, album, artist, sure }], where sure means it is this album by MusicBrainz id
  async search(a, { bulk = false } = {}) {
    const q = encodeURIComponent;
    const out = [];
    const tries = [
      async () => {   // the Cover Art Archive: the release the files are, then its release group
        const ids = [['release', a.release], ['release-group', a.rg]].filter(([, id]) => MBID.test(id || ''));
        for (const [kind, id] of ids) out.push({ url: `https://coverartarchive.org/${kind}/${id}/front-1200`, source: 'Cover Art Archive', album: a.title, artist: a.artist, sure: true });
        if (ids.length || bulk) return;
        // no ids: MusicBrainz's release groups by name
        const query = `releasegroup:"${a.title.replace(/"/g, '')}" AND artist:"${a.artist.replace(/"/g, '')}"`;
        const d = await this.getJson(`https://musicbrainz.org/ws/2/release-group/?query=${q(query)}&fmt=json&limit=3`);
        for (const g of d['release-groups'] || []) {
          if (g.score < 80 || !MBID.test(g.id)) continue;
          out.push({ url: `https://coverartarchive.org/release-group/${g.id}/front-1200`, source: 'Cover Art Archive', album: g.title || '',
            artist: (g['artist-credit'] || []).map((x) => x.name).join(', ') });
        }
      },
      async () => {   // Apple, at the largest size it has (asking for more never scales one up)
        const d = await this.getJson(`https://itunes.apple.com/search?term=${q(`${a.artist} ${a.title}`)}&entity=album&limit=${bulk ? 4 : 6}`);
        for (const r of d.results || []) {
          if (r.artworkUrl100) out.push({ url: r.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/3000x3000bb.jpg'), source: 'Apple', album: r.collectionName || '', artist: r.artistName || '' });
        }
      },
      async () => {   // Deezer
        const d = await this.getJson(`https://api.deezer.com/search/album?q=${q(`artist:"${a.artist}" album:"${a.title}"`)}&limit=${bulk ? 4 : 6}`);
        for (const r of d.data || []) {
          if (r.cover_xl) out.push({ url: r.cover_xl, source: 'Deezer', album: r.title || '', artist: (r.artist && r.artist.name) || '' });
        }
      },
    ];
    await Promise.all(tries.map((f) => f().catch(() => {})));
    const seen = new Set();
    return out.filter((c) => !seen.has(c.url) && seen.add(c.url));
  }

  // one picture fetched and kept as it came: { key, ext, w, h, sha }, or null
  async fetchCandidate(url) {
    const okHost = (u) => { const h = new URL(u); return h.protocol === 'https:' && IMAGE_HOSTS.some((re) => re.test(h.hostname)); };
    if (!okHost(url)) return null;
    const key = crypto.createHash('sha1').update(url).digest('hex');
    for (const ext of ['jpg', 'png']) {                 // fetched before: its size from the file
      const buf = await fsp.readFile(this.candFile({ key, ext })).catch(() => null);
      const info = buf && imageInfo(buf);
      if (info) return { key, ...info, sha: crypto.createHash('sha1').update(buf).digest('hex') };
    }
    const r = await this.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r || !r.ok || !okHost(r.url || url) || !/^image\//.test(r.headers.get('content-type') || '')) return null;
    const buf = await readCapped(r, 12 << 20);
    const info = buf && imageInfo(buf);
    if (!info) return null;
    const file = this.candFile({ key, ext: info.ext });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(`${file}.${process.pid}.tmp`, buf);
    await fsp.rename(`${file}.${process.pid}.tmp`, file);
    return { key, ...info, sha: crypto.createHash('sha1').update(buf).digest('hex') };
  }

  // candidates for an album, best first: { cands: [{ key, ext, source, album, artist, w, h, sure, same }], small }
  async find(a, opts = {}) {
    const found = (await this.search(a, opts)).slice(0, 14);
    const got = await Promise.all(found.map(async (c) => {
      // a name search turns up other artists' albums too: those aren't fetched at all
      if (!c.sure && !sameArtist(c.artist, a.artist)) return null;
      const pic = await this.fetchCandidate(c.url).catch(() => null);
      if (!pic) return null;
      const same = !!c.sure || norm(c.album) === norm(a.title);
      return { key: pic.key, ext: pic.ext, w: pic.w, h: pic.h, sha: pic.sha, source: c.source, album: c.album, artist: c.artist, sure: !!c.sure, same };
    }));
    // one of each picture (a release and its release group often share one), hi-res only
    const seen = new Set();
    const all = got.filter(Boolean).filter((c) => !seen.has(c.sha) && seen.add(c.sha)).map(({ sha, ...c }) => c);
    const cands = all.filter(hiRes).sort((x, y) => (y.sure - x.sure) || (y.same - x.same) || (Math.min(y.w, y.h) - Math.min(x.w, x.h)));
    return { cands, small: all.length - cands.length };
  }

  // The candidates kept for an album, or a fresh search. The best sure one is left as the
  // suggestion, unless the album was skipped
  async findAndKeep(a, { again = false, bulk = false } = {}) {
    const had = (await this.read()).albums[a.id];
    if (!again && had && had.found) return had;
    const { cands, small } = await this.find(a, { bulk });
    return this.change((d) => {
      const c = d.albums[a.id] || {};
      const pick = cands.findIndex((x) => x.same);
      d.albums[a.id] = { cands, small, found: new Date().toISOString(),
        state: c.state === 'skipped' ? 'skipped' : pick >= 0 ? 'suggested' : 'none', pick: pick >= 0 ? pick : null };
      return { write: true, ...d.albums[a.id] };
    });
  }

  // every album given that hasn't been searched (or, again, every one), slowly. j.first holds
  // albums findSome() adds while it runs: they are searched next
  startFind(albums, { again = false } = {}) {
    if (this.job && !this.job.done) return false;
    const j = { done: false, ok: null, note: '', output: '', n: 0, of: 0, found: 0, first: [], todo: null };
    this.job = j;
    (async () => {
      const d = await this.read();
      const added = new Set(j.first.map((t) => t.a.id));
      j.todo = albums.filter((a) => !added.has(a.id) && (again || !(d.albums[a.id] && d.albums[a.id].found))).map((a) => ({ a, again }));
      j.of = j.todo.length + j.first.length;
      if (!j.of) throw new Error('every album has been searched already');
      for (;;) {
        const t = !j.stop && (j.first.shift() || j.todo.shift());
        if (!t) break;
        j.n++;
        j.output = `Searching ${j.n} of ${j.of} · ${j.found} found`;
        try { if ((await this.findAndKeep(t.a, { bulk: true, again: t.again })).state === 'suggested') j.found++; } catch { /* the next one may do better */ }
        if ((j.first.length || j.todo.length) && !j.stop) await new Promise((r) => setTimeout(r, this.pace));
      }
      this.audit({ event: 'artwork-find-all', searched: j.n, found: j.found });
      return `${j.found} suggestion${j.found === 1 ? '' : 's'} from ${j.n} searched${j.stop ? ' (stopped)' : ''}`;
    })().then((note) => { j.ok = true; j.note = note; })
      .catch((e) => { j.ok = false; j.note = e.message; })
      .finally(() => { j.done = true; });
    return true;
  }

  // After each check (artwork.json written anew), the albums not yet searched are searched in
  // the background, so suggestions are waiting. Once per check: a search stopped by hand
  // waits for the next one. Returns whether a search started.
  async autoFind(list) {
    if (!list || !list.checked || list.checked === this.autoSeen) return false;
    if (this.job && !this.job.done) return false;           // looked at again next time
    this.autoSeen = list.checked;
    await this.prune(new Set(list.items.map((i) => i.id)));
    const d = await this.read();
    if (!list.items.some((a) => !(d.albums[a.id] && d.albums[a.id].found))) return false;
    const started = this.startFind(list.items);
    if (started) this.job.auto = true;
    return started;
  }

  // Albums ticked in the list, searched (again) now: next in the search that is running, else
  // as a search of their own. False while a stopped search is still finishing its album
  findSome(albums) {
    const j = this.job;
    if (!j || j.done) return this.startFind(albums, { again: true });
    if (j.stop) return false;
    const ids = new Set(albums.map((a) => a.id));
    const queued = new Set(j.first.map((t) => t.a.id));
    j.first.push(...albums.filter((a) => !queued.has(a.id)).map((a) => ({ a, again: true })));
    if (j.todo) j.todo = j.todo.filter((t) => !ids.has(t.a.id));
    j.of = j.n + j.first.length + (j.todo ? j.todo.length : 0);
    return true;
  }

  stop() { if (this.job && !this.job.done) this.job.stop = true; }
  jobView() { const j = this.job; return j && { done: j.done, ok: j.ok, note: j.note, output: j.output, n: j.n, of: j.of, found: j.found, auto: !!j.auto }; }

  // skip: never suggest one for this album; unskip: suggest again
  setSkipped(id, on) {
    return this.change((d) => {
      const c = d.albums[id] || {};
      if (on) d.albums[id] = { ...c, state: 'skipped' };
      else if (c.state === 'skipped') d.albums[id] = { ...c, state: c.pick != null ? 'suggested' : c.found ? 'none' : undefined };
      return { write: true };
    });
  }

  // the picture the n-th candidate is, copied where the engine takes pictures from: its path
  async stage(id, n, uploads) {
    const c = ((await this.read()).albums[id] || {}).cands;
    const cand = c && Number.isInteger(n) ? c[n] : null;
    const src = this.candFile(cand);
    if (!src) return null;
    await fsp.mkdir(uploads, { recursive: true });
    const out = path.join(uploads, `${id}-${Date.now().toString(36)}-${n}.${cand.ext}`);
    try { await fsp.copyFile(src, out); } catch { return null; }
    return out;
  }

  // forget the searches of albums no longer listed (their artwork written, or the album gone),
  // and the pictures no listed album has among its candidates
  prune(ids) {
    return this.change(async (d) => {
      let write = false;
      for (const k of Object.keys(d.albums)) if (!ids.has(Number(k))) { delete d.albums[k]; write = true; }
      const keep = new Set(Object.values(d.albums).flatMap((a) => (a.cands || []).map((c) => `${c.key}.${c.ext}`)));
      const names = await fsp.readdir(path.join(this.dir, 'cand')).catch(() => []);
      for (const name of names) {
        const file = path.join(this.dir, 'cand', name);
        // an hour's grace: a search in progress has fetched pictures it hasn't recorded yet
        const st = await fsp.stat(file).catch(() => null);
        if (st && !keep.has(name) && Date.now() - st.mtimeMs > 3600e3) await fsp.rm(file, { force: true });
      }
      return { write };
    });
  }
}

module.exports = { Artwork, imageInfo, norm, MIN_PX };
