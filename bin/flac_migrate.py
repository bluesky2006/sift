#!/usr/bin/env python3
"""Move finished Soularr FLAC albums into the Roon FLAC library and retire their MP3s.

    flac_migrate.py                      dry run: classify every held album, write the plan
    flac_migrate.py --apply ID [ID ...]  migrate only these Lidarr-FLAC album ids (pilot)
    flac_migrate.py --apply all          migrate everything marked retire or no_mp3

Moving (not copying) out of /mnt/roon-data/music-flac is only safe because each album is
UNMONITORED in Lidarr-FLAC first, so Soularr's wanted list never sees it as missing, and
recorded in flac-migrated.json, which soularr_dupes.py honours so it will not re-monitor a
linked entry whose FLAC has "vanished".

Per album, in this order: unmonitor in Lidarr-FLAC -> record in ledger -> rsync the album
folder to /mnt/roon-music/FLAC (checksummed, source removed only after a good copy) ->
move the MP3 album folder to /mnt/roon-music/MP3-superseded (same drive, instant,
reversible). MP3 Lidarr is left alone here; unmonitor it once Roon looks right.
"""
import collections, fcntl, hashlib, json, os, re, sqlite3, subprocess, sys, threading, time, \
    unicodedata, urllib.request
from datetime import datetime, timezone

import mutagen
from concurrent.futures import ThreadPoolExecutor

# The code lives in the Sift repo; its data, and soularr_dupes, stay in ~/claude-roon.
sys.path.insert(0, os.path.expanduser("~/claude-roon"))
import soularr_dupes

FLAC_API = "http://localhost:8687/api/v1"
# Read from Lidarr's own config rather than kept here: this file is in a pushed repo.
FLAC_CONFIG = "/DATA/AppData/lidarr-flac/config/config.xml"
MP3_DB = "file:/DATA/AppData/lidarr/config/lidarr.db?mode=ro"
FLAC_DB = "file:/DATA/AppData/lidarr-flac/config/lidarr.db?mode=ro"
FLAC_SRC = "/mnt/roon-data/music-flac"
MP3_ROOT = "/mnt/roon-music/MP3"
FLAC_DEST = "/mnt/roon-music/FLAC"
QUARANTINE = "/mnt/roon-music/MP3-superseded"
HERE = os.path.expanduser("~/claude-roon")
PLAN = os.path.join(HERE, "flac-migration-plan.json")
REPORT = os.path.join(HERE, "flac-migration-dryrun.md")
MIGRATED = os.path.join(HERE, "flac-migrated.json")
# FLACs moved back to music-flac because the MP3 is being kept - never migrate these again
RETURNED = os.path.join(HERE, "flac-returned.json")
# damaged FLACs held in /mnt/roon-music/FLAC-damaged, with the MP3 folders they belong to
DAMAGED = os.path.join(HERE, "flac-damaged.json")
LOG = os.path.join(HERE, "flac-migrate.log")
# per-file facts and per-album fingerprint results, keyed by size+mtime so nothing is
# decoded or fingerprinted twice - a full check costs about a minute per album
CACHE = os.path.join(HERE, "flac-check-cache.json")

AUDIO = {".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".wma", ".ape"}
FRESH_HOURS = 0.5          # files this new may still be mid-import: Lidarr takes a minute or two per album
DUR_TOLERANCE = 0.02       # equal track counts: totals must agree within 2% ...
DUR_MIN_SLACK = 10         # ... or 10 seconds, whichever is larger
FP_SECONDS = 300           # fingerprint this much of each track
FP_SAME = 0.8              # same recording scores ~0.95+, different tracks ~0.55-0.7


def flac_key():
    with open(FLAC_CONFIG) as f:
        return re.search(r"<ApiKey>([^<]+)</ApiKey>", f.read()).group(1)


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        FLAC_API + path, method=method,
        headers={"X-Api-Key": flac_key(), "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    raw = urllib.request.urlopen(req, timeout=120).read()
    return json.loads(raw) if raw else {}


def host(path, root):
    return os.path.join(root, os.path.relpath(path, "/music"))


def album_dir(path, root):
    """Artist/Album folder holding a track - multi-disc albums nest one level deeper."""
    rel = os.path.relpath(path, root).split(os.sep)
    return os.path.join(root, rel[0], rel[1])


# ---- cache ---------------------------------------------------------------------

_cache = None
_cache_lock = threading.Lock()


def cache():
    global _cache
    if _cache is None:
        _cache = load_json(CACHE, {})
        _cache.setdefault("files", {})
        _cache.setdefault("matches", {})
    return _cache


def save_cache():
    """Merge into whatever is on disk, so two processes checking at once lose nothing,
    and drop entries for files that no longer exist."""
    if _cache is None:
        return
    # one process at a time across the box: two saving at once (health and the check) would
    # each merge into the same old copy, and the second would drop the first one's results
    with _cache_lock, open(CACHE + ".lock", "w") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        disk = load_json(CACHE, {})
        # an entry both copies hold for the same file version is merged key by key, so a
        # process that loaded the cache long ago never takes back what another one measured since
        files = dict(disk.get("files", {}))
        for p, e in _cache["files"].items():
            d = files.get(p)
            files[p] = {**d, **e} if d and d.get("sig") == e.get("sig") else e
        files = {p: v for p, v in files.items() if os.path.exists(p)}
        matches = {**disk.get("matches", {}), **_cache["matches"]}
        save_json(CACHE, {"files": files, "matches": matches})


def sig(path):
    st = os.stat(path)
    return [st.st_size, st.st_mtime_ns]


def file_entry(path):
    """The cache record for a file, reset if the file has changed since."""
    c = cache()["files"]
    s = sig(path)
    with _cache_lock:
        e = c.get(path)
        if not e or e.get("sig") != s:
            e = c[path] = {"sig": s}
    return e


def file_info(path):
    """Length, title, track and disc number and format of one track, as shown side by side
    in Sift. Entries cached before track numbers were read are read again."""
    e = file_entry(path)
    if "secs" not in e or "track" not in e:
        info = {"secs": None, "title": "", "fmt": "", "track": None, "disc": None}
        try:
            m = mutagen.File(path, easy=True)
            info["secs"] = m.info.length
            info["title"] = (m.get("title") or [""])[0]
            for key, tag in (("track", "tracknumber"), ("disc", "discnumber")):
                n = re.match(r"\s*(\d+)", (m.get(tag) or [""])[0])      # "3", "03" or "3/12"
                info[key] = int(n.group(1)) if n else None
            bits = getattr(m.info, "bits_per_sample", 0)
            if bits:
                info["fmt"] = f"{bits}-bit / {m.info.sample_rate / 1000:g} kHz"
            elif getattr(m.info, "bitrate", 0):
                info["fmt"] = f"{round(m.info.bitrate / 1000)} kbps"
        except Exception:
            pass
        with _cache_lock:
            e.update(info)
    return e


def duration(path):
    return file_info(path)["secs"]


def aliases(fid, old):
    ids = {fid}
    try:
        ids.update(json.loads(old or "[]"))
    except ValueError:
        pass
    return ids


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"                # unique, so two writers never share one
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())                          # on disk before it replaces the old one
    os.replace(tmp, path)


# ---- plan --------------------------------------------------------------------

def mp3_albums():
    db = sqlite3.connect(MP3_DB, uri=True)
    albums, by_mbid, owner = {}, collections.defaultdict(set), {}
    for aid, fid, old, artist, title in db.execute("""
            select al.Id, al.ForeignAlbumId, al.OldForeignAlbumIds, am.Name, al.Title
            from Albums al join ArtistMetadata am on am.Id = al.ArtistMetadataId"""):
        albums[aid] = {"id": aid, "mbid": fid, "artist": artist, "title": title, "files": []}
        for i in aliases(fid, old):
            by_mbid[i].add(aid)
    for aid, path in db.execute("select AlbumId, Path from TrackFiles"):
        if not aid:     # AlbumId 0: a file Lidarr imported but never matched to a track - unmapped
            continue
        owner[host(path, MP3_ROOT)] = aid
        if aid in albums:
            albums[aid]["files"].append(host(path, MP3_ROOT))
    return albums, by_mbid, owner


def flac_albums():
    db = sqlite3.connect(FLAC_DB, uri=True)
    albums, owner = {}, {}
    for aid, fid, old, artist, title, mon in db.execute("""
            select al.Id, al.ForeignAlbumId, al.OldForeignAlbumIds, am.Name, al.Title,
                   al.Monitored
            from Albums al join ArtistMetadata am on am.Id = al.ArtistMetadataId"""):
        albums[aid] = {"id": aid, "mbid": fid, "ids": aliases(fid, old), "artist": artist,
                       "title": title, "monitored": bool(mon), "files": []}
    for aid, path in db.execute("select AlbumId, Path from TrackFiles"):
        if not aid:     # AlbumId 0: a file Lidarr imported but never matched to a track - unmapped
            continue
        owner[host(path, FLAC_SRC)] = aid
        if aid in albums:
            albums[aid]["files"].append(host(path, FLAC_SRC))
    return {k: v for k, v in albums.items() if v["files"]}, owner


def folder_audio(folders):
    return sorted(os.path.join(dp, f) for d in folders for dp, _, fs in os.walk(d)
                  for f in fs if os.path.splitext(f)[1].lower() in AUDIO
                  and not f.startswith("._"))


def foreign_audio(files, album_id, owner):
    """Files Lidarr maps to a different album. Unmapped files count as this album's -
    Lidarr often leaves a track or two of an album unmatched in its own folder."""
    return [p for p in files if owner.get(p, album_id) != album_id]


# ---- checks ------------------------------------------------------------------
# Album-level agreement (MusicBrainz id, track count, total length) was not enough: on
# 16 Sep 2026 it passed 967 albums, of which 45 held a different mix or edit and 19 had
# truncated FLACs. An MP3 is only retired once both checks below pass on every track.

def decode_check(path):
    """Decode a FLAC through any errors and say what came out: seconds decoded, whether
    the audio matches the MD5 in the file's own header, and where (in seconds) the decoder
    lost its place. The byte count when each complaint arrives is within a second of the
    spot, since flac blocks on the pipe and the reads are small."""
    try:
        m = mutagen.File(path)
        rate, ch, bits = m.info.sample_rate, m.info.channels, m.info.bits_per_sample
        want = "%032x" % m.info.md5_signature if m.info.md5_signature else None
    except Exception:
        return None
    per_sec = rate * ch * (bits // 8)
    p = subprocess.Popen(["flac", "-d", "-c", "-s", "-F", "--force-raw-format",
                          "--endian=little", "--sign=signed", path],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    n, bad, md5 = 0, [], hashlib.md5()

    def listen():
        for line in p.stderr:
            if b"error" in line.lower() and b"ERROR_STATUS" in line:
                bad.append(n)
    t = threading.Thread(target=listen, daemon=True)
    t.start()
    for chunk in iter(lambda: p.stdout.read(1 << 13), b""):
        md5.update(chunk)
        n += len(chunk)
    p.wait()
    t.join()
    total = n / per_sec if per_sec else 0
    spots = sorted({int(b / per_sec) for b in bad if per_sec})
    return {"decoded_s": round(total, 1), "md5_ok": want is not None and md5.hexdigest() == want,
            "known": want is not None, "bad_at": spots}


def flac_damaged(files):
    """FLAC files whose audio doesn't decode whole (truncated downloads are the usual cause).

    flac -t objects to more than damage: an ID3v1 tag stuck on the end of an old rip trips
    it after the last frame with every sample intact. So when it objects, the file is
    decoded through its errors and the audio compared with the MD5 in its own header; only
    a mismatch (or a header with no MD5) counts. The entry then says how much decoded
    (decoded_s) and where the decoder lost its place (bad_at, seconds)."""
    def bad(p):
        e = file_entry(p)
        if "damaged" not in e:
            broken = subprocess.run(["flac", "-t", "-s", p], capture_output=True).returncode != 0
            r = decode_check(p) if broken else None
            if r and r["md5_ok"]:
                broken = False
            with _cache_lock:
                e["damaged"] = broken
                if broken and r:
                    e["decoded_s"], e["bad_at"] = r["decoded_s"], r["bad_at"]
        return e["damaged"]
    files = [p for p in files if p.lower().endswith(".flac")]
    with ThreadPoolExecutor(6) as ex:
        return [p for p, b in zip(files, ex.map(bad, files)) if b]


def fingerprint(path):
    r = subprocess.run(["fpcalc", "-raw", "-length", str(FP_SECONDS), path],
                       capture_output=True, text=True)
    fp = re.search(r"FINGERPRINT=(.*)", r.stdout)
    secs = re.search(r"DURATION=(\d+)", r.stdout)
    return ([int(x) for x in fp.group(1).split(",")] if fp else [],
            int(secs.group(1)) if secs else 0)


def similarity(a, b):
    """Best share of matching fingerprint bits over any alignment that overlaps at least
    half of the shorter track. Packed into big ints so each alignment is one xor and a
    popcount.

    The half-overlap rule matters: with only 30 frames (~4 s) required, a stretch of fade
    or near-silence scored 1.0 between different tracks, pairing "No Hope" with "Harm
    Autumn" on 1991's High-Tech High-Life."""
    need = max(30, min(len(a), len(b)) // 2)
    if min(len(a), len(b)) < 30:
        return 0.0
    pack = lambda v: int.from_bytes(b"".join((x & 0xffffffff).to_bytes(4, "little")
                                             for x in v), "little")
    best = 0.0
    for x, y in ((a, b), (b, a)):
        X, Y = pack(x), pack(y)
        for off in range(len(x) - need + 1):
            n = min(len(x) - off, len(y))
            if n < need:
                break
            d = ((X >> (32 * off)) ^ Y) & ((1 << (32 * n)) - 1)
            best = max(best, 1 - d.bit_count() / (32 * n))
    return best


MATCH_VERSION = 2      # bump when the matching changes, so cached results are redone


def match_tracks(mp3_files, flac_files):
    """Pair MP3 tracks with FLAC tracks one to one: the highest-scoring pairs first, and
    on a near tie the same track position. `m` and `f` index into the two lists, so Sift
    can line the tracks up; an MP3 track left without a partner has f = None."""
    key = hashlib.sha1(json.dumps([MATCH_VERSION] + [[p, sig(p)] for p in mp3_files] + ["|"]
                                  + [[p, sig(p)] for p in flac_files]).encode()).hexdigest()
    hit = cache()["matches"].get(key)
    if hit is not None:
        return hit
    with ThreadPoolExecutor(8) as ex:
        mp = list(ex.map(fingerprint, mp3_files))
        fl = list(ex.map(fingerprint, flac_files))
    scores = []
    for i, (fa, secs) in enumerate(mp):
        for j, (fb, fsecs) in enumerate(fl):
            sim = similarity(fa, fb)
            same = sim >= FP_SAME and abs(secs - fsecs) <= max(DUR_MIN_SLACK, 0.05 * secs)
            scores.append((not same, -round(sim, 2), abs(i - j), abs(secs - fsecs), i, j, sim, same))
    scores.sort()
    pair, used = {}, set()
    for *_, i, j, sim, same in scores:
        if i not in pair and j not in used:
            pair[i] = (j, sim, same)
            used.add(j)
    out = []
    for i, path in enumerate(mp3_files):
        j, sim, same = pair.get(i, (None, 0.0, False))
        out.append({"m": i, "f": j, "mp3": os.path.basename(path), "mp3_s": mp[i][1],
                    "flac": os.path.basename(flac_files[j]) if j is not None else "",
                    "flac_s": fl[j][1] if j is not None else 0, "sim": round(sim, 3), "same": same})
    with _cache_lock:
        cache()["matches"][key] = out
    return out


def fold(name):
    return unicodedata.normalize("NFKC", name).casefold()


_mp3_index = None


def squash(name):
    """Letters and digits only, lower case, a trailing (year) dropped: "YOKOCHO" and
    "Y O K O C H O 横丁" both become "yokocho"."""
    name = re.sub(r"\s*[\(\[]\d{4}[\)\]]\s*$", "", name)
    return re.sub(r"[^a-z0-9]", "", soularr_dupes.norm(name).replace(" ", ""))


def mp3_folder_named(artist, title):
    """MP3 album folders that look like this album, found on disk rather than through
    Lidarr: same title, and one artist name contained in the other."""
    global _mp3_index
    if _mp3_index is None:
        _mp3_index = collections.defaultdict(list)
        for a in os.listdir(MP3_ROOT):
            ad = os.path.join(MP3_ROOT, a)
            if os.path.isdir(ad):
                for d in os.listdir(ad):
                    if os.path.isdir(os.path.join(ad, d)):
                        _mp3_index[squash(d)].append((squash(a), os.path.join(ad, d)))
    want = squash(artist)
    return [p for have, p in _mp3_index.get(squash(title), [])
            if want and have and (want in have or have in want)]


def build_plan(one_album=()):
    """`one_album`: Lidarr-FLAC album ids whose whole folder Simon has said is one album
    (in Sift), so files Lidarr filed under another entry don't hold them back."""
    mp3, mp3_by_mbid, mp3_owner = mp3_albums()
    flac, flac_owner = flac_albums()
    # a FLAC imported under a twin entry satisfies the owned entry recorded in the ledger
    holder_to_owner = collections.defaultdict(set)
    for owner, link in soularr_dupes.load_ledger().items():
        holder_to_owner[link["holder_mbid"]].add(owner)
    # albums already moved into Roon. Returned ones are NOT skipped: they sit in music-flac
    # and are classified like any other, which is what puts them in Sift's queues
    migrated = load_json(MIGRATED, {})
    # MP3 folders recorded when an album was kept as MP3 or its FLAC was damaged. The MP3
    # Lidarr can lose track of files moved back into place (it did for 3 on 16 Sep), and
    # without these the album would read as "no MP3" and head for Ready.
    known_mp3 = {**load_json(DAMAGED, {}), **load_json(RETURNED, {})}
    now = time.time()
    # ext4 is case-sensitive: merge "XEXA" into an existing "Xexa" instead of a sibling
    existing_artists = {fold(d): d for d in os.listdir(FLAC_DEST)}

    plan = []
    for a in sorted(flac.values(), key=lambda a: (a["artist"].lower(), a["title"].lower())):
        if str(a["id"]) in migrated:
            continue
        # Lidarr's rows can outlive files that were moved, until its next rescan
        a["files"] = [p for p in a["files"] if os.path.exists(p)]
        if not a["files"]:
            continue
        e = {"flac_id": a["id"], "mbid": a["mbid"], "artist": a["artist"], "title": a["title"],
             "monitored": a["monitored"], "notes": []}
        dirs = {album_dir(p, FLAC_SRC) for p in a["files"]}
        e["flac_dir"] = sorted(dirs)[0]
        flac_files = folder_audio(dirs)
        e["flac_files"] = flac_files
        # other Lidarr-FLAC entries that own files in this folder
        e["foreign_ids"] = sorted({flac_owner[p] for p in flac_files
                                   if flac_owner.get(p, a["id"]) != a["id"]})
        e["flac_tracks"] = len(flac_files)
        artist, album = os.path.relpath(e["flac_dir"], FLAC_SRC).split(os.sep)
        artist = existing_artists.get(fold(artist), artist)
        e["dest"] = os.path.join(FLAC_DEST, artist, album)

        ids = set(a["ids"])
        for i in a["ids"]:
            ids |= holder_to_owner.get(i, set())
        matches = [mp3[m] for i in ids for m in mp3_by_mbid.get(i, ()) if mp3[m]["files"]]
        matches = list({m["id"]: m for m in matches}.values())
        rec = known_mp3.get(str(a["id"]))
        if not matches and rec and rec.get("mp3_dirs") \
                and all(os.path.isdir(d) for d in rec["mp3_dirs"]):
            files = folder_audio(rec["mp3_dirs"])
            if files:
                matches = [{"id": rec.get("mp3_id"), "files": files}]
                e["notes"].append("MP3 found from Sift's records; the MP3 Lidarr has lost track of its files")

        fd = [duration(p) for p in flac_files]
        e["flac_seconds"] = round(sum(d for d in fd if d), 1)
        if None in fd:
            e["notes"].append("unreadable FLAC file(s)")

        if matches:
            m = matches[0]
            e["mp3_id"] = m["id"]
            e["mp3_dirs"] = sorted({album_dir(p, MP3_ROOT) for p in m["files"]})
            mp3_files = folder_audio(e["mp3_dirs"])
            e["mp3_files"] = mp3_files
            e["mp3_tracks"] = len(mp3_files)
            # binning this MP3 folder would take another album's files with it
            e["mp3_shared"] = len(e["mp3_dirs"]) > 1 or bool(
                foreign_audio(mp3_files, e["mp3_id"], mp3_owner))
            md = [duration(p) for p in mp3_files]
            e["mp3_seconds"] = round(sum(d for d in md if d), 1)
            if len(matches) > 1:
                e["notes"].append(f"{len(matches)} MP3 albums match")

        # classify - first failing rule wins
        if len(dirs) > 1:
            e["status"] = "manual"; e["notes"].append("FLAC files span several folders")
        elif foreign_audio(flac_files, a["id"], flac_owner) and a["id"] not in one_album:
            e["status"] = "manual"; e["notes"].append("FLAC folder holds another album's audio")
        elif now - max(os.path.getmtime(p) for p in flac_files) < FRESH_HOURS * 3600:
            e["status"] = "wait"; e["notes"].append("imported in the last few hours")
        elif os.path.exists(e["dest"]):
            e["status"] = "collision"; e["notes"].append("album folder already in FLAC library")
        elif "unreadable FLAC file(s)" in e["notes"]:
            e["status"] = "manual"
        elif not matches and mp3_folder_named(a["artist"], a["title"]):
            e["status"] = "manual"
            e["notes"].append("An MP3 folder with this name exists, but the MP3 Lidarr doesn't link it to this album")
        elif not matches:
            e["status"] = "no_mp3"
        elif len(matches) > 1:
            e["status"] = "manual"
        elif e["flac_tracks"] < e["mp3_tracks"]:
            e["status"] = "keep_mp3"; e["notes"].append("FLAC has fewer tracks")
        elif len(e["mp3_dirs"]) > 1 or foreign_audio(mp3_files, e["mp3_id"], mp3_owner):
            e["status"] = "keep_mp3"; e["notes"].append("MP3 folder holds another album's audio")
        else:
            slack = max(DUR_MIN_SLACK, e["mp3_seconds"] * DUR_TOLERANCE)
            short = e["mp3_seconds"] - e["flac_seconds"]
            if short > slack:
                e["status"] = "keep_mp3"
                e["notes"].append(f"FLAC {short/60:.1f} min shorter than MP3")
            elif e["flac_tracks"] == e["mp3_tracks"] and -short > slack:
                e["status"] = "keep_mp3"
                e["notes"].append(f"same track count but FLAC {-short/60:.1f} min longer")
            else:
                e["status"] = "retire"

        if e["status"] == "wait":
            plan.append(e)
            continue
        broken = flac_damaged(flac_files)
        if broken:
            e["damaged_files"] = [os.path.basename(p) for p in broken]
            if e["status"] in ("retire", "no_mp3", "keep_mp3"):
                e["status"] = "damaged"
            e["notes"].append(f"{len(broken)} FLAC file(s) fail flac -t")
        if matches and mp3_files and flac_files:
            e["track_checks"] = match_tracks(mp3_files, flac_files)
        if e["status"] == "retire":
            odd = [t for t in e["track_checks"] if not t["same"]]
            if odd:
                e["status"] = "unconfirmed"
                e["notes"].append(f"{len(odd)} MP3 track(s) not fingerprint-matched: "
                                  + ", ".join(t["mp3"] for t in odd[:3]))
        plan.append(e)
    return plan


def write_report(plan):
    by = collections.defaultdict(list)
    for e in plan:
        by[e["status"]].append(e)
    meaning = [
        ("retire", "Move the FLAC in, move the MP3 to MP3-superseded"),
        ("no_mp3", "Move the FLAC in; there is no MP3 to retire"),
        ("keep_mp3", "Leave both where they are; the MP3 stays in Roon"),
        ("unconfirmed", "Leave both; some MP3 tracks have no fingerprint match in the FLAC"),
        ("damaged", "Leave both; FLAC files fail flac -t"),
        ("collision", "Skip; an album folder of that name is already in the FLAC library"),
        ("wait", "Skip for now; imported in the last few hours"),
        ("manual", "Skip; needs a look"),
    ]
    out = [f"# FLAC migration dry run — {datetime.now():%d %b %Y %H:%M}", "",
           "Nothing has been moved. Lidarr-FLAC album ids are in brackets.", "",
           "| Status | Albums | What happens |", "|---|---|---|"]
    for k, text in meaning:
        out.append(f"| `{k}` | {len(by[k])} | {text} |")
    for k, _ in meaning:
        if k == "retire" or not by[k]:
            continue
        out += ["", f"## `{k}`", ""]
        for e in by[k]:
            out.append(f"- {e['artist']} — {e['title']} ({e['flac_id']})"
                       + (f": {'; '.join(e['notes'])}" if e["notes"] else ""))
    out += ["", "## `retire`", ""]
    for e in by["retire"]:
        extra = f" FLAC {e['flac_tracks']} vs MP3 {e['mp3_tracks']} tracks" \
            if e["flac_tracks"] != e["mp3_tracks"] else ""
        out.append(f"- {e['artist']} — {e['title']} ({e['flac_id']}){extra}")
    with open(REPORT, "w") as f:
        f.write("\n".join(out) + "\n")
    return by


# ---- apply -------------------------------------------------------------------

def arrival_stats(dest):
    """What soularr_status.py needs to keep counting an album after it left the drive.
    rsync -t keeps mtimes, so the newest file is when Lidarr imported the album."""
    files = folder_audio([dest])
    newest = max(os.path.getmtime(p) for p in files)
    return {"tracks": len(files), "bytes": sum(os.path.getsize(p) for p in files),
            "imported": datetime.fromtimestamp(newest, timezone.utc)
                                .strftime("%Y-%m-%d %H:%M:%S")}


def migrate(e):
    name = f"{e['artist']} - {e['title']} ({e['flac_id']})"
    # keep_mp3 stays put: Simon does not want the same album in Roon twice
    if e["status"] not in ("retire", "no_mp3"):
        log(f"skip {name}: {e['status']}")
        return False
    if os.path.exists(e["dest"]):
        log(f"skip {name}: destination exists")
        return False

    # 1. out of Soularr's reach before anything leaves the drive
    api("/album/monitor", "PUT", {"albumIds": [e["flac_id"]], "monitored": False})
    migrated = load_json(MIGRATED, {})
    migrated[str(e["flac_id"])] = {
        "mbid": e["mbid"], "artist": e["artist"], "title": e["title"], "status": e["status"],
        "dest": e["dest"], "mp3_dirs": e.get("mp3_dirs", []) if e["status"] == "retire" else [],
        "mp3_id": e.get("mp3_id"), "started": datetime.now().isoformat(timespec="seconds")}
    save_json(MIGRATED, migrated)

    # 2. FLAC across drives: checksummed copy, sources removed only once each file landed
    os.makedirs(os.path.dirname(e["dest"]), exist_ok=True)
    r = subprocess.run(["rsync", "-rt", "--checksum", "--remove-source-files",
                        e["flac_dir"] + "/", e["dest"] + "/"], capture_output=True, text=True)
    if r.returncode != 0:
        log(f"FAILED rsync {name}: {r.stderr.strip()[:300]}")
        return False
    left = [os.path.join(dp, f) for dp, _, fs in os.walk(e["flac_dir"]) for f in fs]
    if left:
        log(f"FAILED {name}: {len(left)} file(s) left in source")
        return False
    subprocess.run(["find", e["flac_dir"], "-depth", "-type", "d", "-empty", "-delete"])
    artist_dir = os.path.dirname(e["flac_dir"])
    if os.path.isdir(artist_dir) and not os.listdir(artist_dir):
        os.rmdir(artist_dir)

    # 3. MP3 to quarantine - same drive, so a rename
    if e["status"] == "retire":
        for d in e["mp3_dirs"]:
            target = os.path.join(QUARANTINE, os.path.relpath(d, MP3_ROOT))
            if os.path.exists(target):
                log(f"WARNING {name}: {target} exists, MP3 left in place")
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.rename(d, target)
            parent = os.path.dirname(d)
            if not os.listdir(parent):
                os.rmdir(parent)

    migrated = load_json(MIGRATED, {})
    migrated[str(e["flac_id"])].update(arrival_stats(e["dest"]))
    migrated[str(e["flac_id"])]["done"] = datetime.now().isoformat(timespec="seconds")
    save_json(MIGRATED, migrated)
    log(f"migrated {name} [{e['status']}]")
    return True


def main():
    if "--apply" not in sys.argv:
        plan = build_plan()
        save_cache()
        save_json(PLAN, plan)
        by = write_report(plan)
        print(", ".join(f"{k}: {len(v)}" for k, v in sorted(by.items())))
        print(f"report: {REPORT}")
        return
    want = sys.argv[sys.argv.index("--apply") + 1:]
    plan = load_json(PLAN, [])
    if not plan:
        sys.exit("no plan - run without --apply first")
    if want != ["all"]:
        ids = {int(x) for x in want}
        plan = [e for e in plan if e["flac_id"] in ids]
    done = sum(migrate(e) for e in plan)
    log(f"run finished: {done} of {len(plan)} migrated")


if __name__ == "__main__":
    main()
