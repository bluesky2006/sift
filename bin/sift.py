#!/usr/bin/env python3
"""Sift's engine: builds the review queue and carries out decisions. See ~/sift/README.md.

    sift.py check                      classify every FLAC album, write queue.json
    sift.py resolve ID DECISION        keep_flac | keep_mp3 | bin_album | refetch | watch_on | watch_off
    sift.py resolve ID refetch N       re-fetch, looking for the album's Nth release in the list
    sift.py approve-ready              keep_flac for everything in the Ready queue
    sift.py undo ENTRY                 reverse a decision that is still in the bin
    sift.py empty-bin [DAYS]           delete everything in the bin, or entries older than DAYS - the only delete
    sift.py resolve-many DECISION IDS  keep_flac | keep_mp3 | refetch for ids 1,2,3, one bin entry each
    sift.py apply-staged SPEC          id:decision[:release],... approved in the app, one bin entry each
    sift.py health MINUTES             check the FLAC library for damaged or converted files, for so long
    sift.py strip-id3 [FOLDER...]      cut ID3v1 tags off the end of intact library FLACs (undo in the bin)
    sift.py adopt PATH LABEL           shell only: put an existing folder in the bin

    sift.py pair ID M F                MP3 track M is FLAC track F (indexes into the album)
    sift.py unpair ID M                forget a hand-made pair
    sift.py bin-track ID F             put one FLAC track in the bin
    sift.py reorder ID 2,0,1,...       renumber and rename FLAC tracks into this order
    sift.py one-album ID on|off        the whole FLAC folder is this album
    sift.py block-user ID              add the Soulseek user this album came from to Soularr's ignored_users

The web app only ever runs the first six, with an album id or bin entry id it has checked
against queue.json / bin.json. Every path comes from those files, never from the browser.

Classification is flac_migrate.build_plan(), the same code the migration used, so an album
lands in Ready only after every FLAC file passes `flac -t` and every MP3 track matches a
FLAC track by fingerprint, and most FLAC tracks reach above SUSPECT_HZ (a FLAC that stops
lower is usually a converted MP3, and waits in Suspect FLAC instead).
"""
import base64, collections, fcntl, hashlib, hmac, json, os, re, shutil, sqlite3, subprocess, sys, time, \
    urllib.request, uuid, zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

sys.path.insert(0, os.path.expanduser("~/claude-roon"))
import flac_migrate as fm
import mutagen

STATE = os.environ.get("SIFT_STATE", os.path.expanduser("~/.local/state/sift"))
CONF = {
    "flac_src": fm.FLAC_SRC,                       # Soularr's library, on /mnt/roon-data
    "mp3_root": fm.MP3_ROOT,                       # both of these on /mnt/roon-music
    "flac_dest": fm.FLAC_DEST,
    "bins": {"/mnt/roon-music": "/mnt/roon-music/Sift-bin",
             "/mnt/roon-data": "/mnt/roon-data/Sift-bin"},
    "migrated": fm.MIGRATED,
    "returned": fm.RETURNED,
    "damaged": os.path.join(fm.HERE, "flac-damaged.json"),
    # library albums sent back to Soularr from Library health, with the copies they replaced
    "refetched": os.path.join(STATE, "refetched.json"),
    "quarantine": fm.QUARANTINE,                   # where the migration retired MP3s to
    "flac_api": fm.FLAC_API, "flac_config": "/DATA/AppData/lidarr-flac/config/config.xml",
    "mp3_api": "http://localhost:8686/api/v1", "mp3_config": "/DATA/AppData/lidarr/config/config.xml",
    "flac_db": fm.FLAC_DB, "mp3_db": fm.MP3_DB,
    "transfers_db": "file:/DATA/AppData/slskd/data/transfers.db?mode=ro",
    "soularr_config": "/DATA/AppData/soularr/config.ini",
    "jot_url": "http://127.0.0.1:8300/api/jot", "jot_auth": os.path.expanduser("~/scribeandjot/auth.json"),
}
if os.environ.get("SIFT_CONF"):                    # the test suite's sandbox
    CONF.update(json.load(open(os.environ["SIFT_CONF"])))

QUEUE = os.path.join(STATE, "queue.json")
BIN = os.path.join(STATE, "bin.json")
COVERS = os.path.join(STATE, "covers")
# Simon's own calls on an album: tracks he paired by hand, folders he says are one album
OVERRIDES = os.path.join(STATE, "overrides.json")
LOG = os.path.join(STATE, "sift.log")
# what left bin.json: emptied, undone, or failed partway through a batch
HISTORY = os.path.join(STATE, "history.json")
NOTIFY = os.path.join(STATE, "notify.json")
# the nightly check of the whole FLAC library: results per album folder, and dismissals
HEALTH = os.path.join(STATE, "health.json")
# decisions in progress, one file each, until they reach bin.json
PENDING = os.path.join(STATE, "pending")

QUEUES = {"retire": "ready", "no_mp3": "ready", "unconfirmed": "different",
          "keep_mp3": "lineup", "damaged": "damaged", "manual": "look",
          "collision": "look", "wait": "arriving"}

# A FLAC made from an MP3 has nothing above the MP3's lowpass. Measured on 16 Sep 2026 across
# the queue: CD-rate FLACs reach 21-22 kHz, LAME 320 stops near 20 kHz, 192 kbps near 19 kHz,
# 128 kbps near 16 kHz. Old tape and lo-fi recordings can stop lower too, so it's a flag.
SUSPECT_HZ = 20500
MEASURE_SECONDS = 60       # the spectrum is taken over this much from the middle of a track


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def now():
    return datetime.now().isoformat(timespec="seconds")


class Lock:
    """One writer at a time: the scheduled check and the web app share this."""
    def __init__(self, wait=True):
        self.f = open(os.path.join(STATE, "lock"), "w")
        self.wait = wait

    def __enter__(self):
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | (0 if self.wait else fcntl.LOCK_NB))
        except BlockingIOError:
            raise SystemExit("another Sift job is running")
        recover()
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)


# ---- Lidarr --------------------------------------------------------------------

def api_key(inst):
    """Read from Lidarr's own config, so no key lives in this repo."""
    with open(CONF[f"{inst}_config"]) as f:
        return re.search(r"<ApiKey>([^<]+)</ApiKey>", f.read()).group(1)


def lidarr(inst, path, method="GET", body=None):
    if os.environ.get("SIFT_FAKE_API"):            # tests: record the call, pretend it worked
        with open(os.environ["SIFT_FAKE_API"], "a") as f:
            f.write(json.dumps([inst, method, path, body]) + "\n")
        if method == "GET":
            return {"monitored": True, "anyReleaseOk": True, "releases": [{"foreignReleaseId": "rel-a", "monitored": True},
                                                    {"foreignReleaseId": "rel-b", "monitored": False}]}
        return {}
    req = urllib.request.Request(
        CONF[f"{inst}_api"] + path, method=method,
        headers={"X-Api-Key": api_key(inst), "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    raw = urllib.request.urlopen(req, timeout=120).read()
    return json.loads(raw) if raw else {}


def rescan(inst):
    """Let Lidarr notice moved files. A whole-library rescan, queued in Lidarr, not awaited."""
    try:
        lidarr(inst, "/command", "POST", {"name": "RescanFolders"})
    except Exception as e:
        log(f"WARNING: {inst} rescan not queued ({e})")


# ---- queue ---------------------------------------------------------------------

COVER_PX = 600


def shrink(path):
    """Covers can be 15 MB scans; the page never shows one wider than a phone."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            if max(im.size) <= COVER_PX and im.format == "JPEG":
                return
            im = im.convert("RGB")
            im.thumbnail((COVER_PX, COVER_PX))
            im.save(path + ".tmp", "JPEG", quality=85)
        os.replace(path + ".tmp", path)
    except Exception:
        pass                                      # an odd picture is served as it is


def cover(item_id, side, folders, files):
    """Save one picture for this side of the album, from a folder image or embedded art."""
    os.makedirs(COVERS, exist_ok=True)
    out = os.path.join(COVERS, f"{item_id}-{side}.jpg")
    if os.path.exists(out):
        return True
    for d in folders:
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        pics = [n for n in names if n.lower().endswith((".jpg", ".jpeg", ".png"))]
        pics.sort(key=lambda n: (not n.lower().startswith(("cover", "folder", "front")), n))
        if pics:
            shutil.copyfile(os.path.join(d, pics[0]), out)
            shrink(out)
            return True
    for p in files[:3]:
        try:
            m = mutagen.File(p)
            data = None
            if getattr(m, "pictures", None):
                data = m.pictures[0].data
            elif m.tags is not None:
                apic = [t for k, t in m.tags.items() if k.startswith("APIC")]
                data = apic[0].data if apic else None
            if data:
                with open(out, "wb") as f:
                    f.write(data)
                shrink(out)
                return True
        except Exception:
            continue
    return False


def covers(item_id, flac_folders, flac_files, mp3_folders, mp3_files):
    """Both sides' pictures, and the album's own picture: the FLAC's, else the MP3's."""
    sides = {"flac": cover(item_id, "flac", flac_folders, flac_files),
             "mp3": bool(mp3_files) and cover(item_id, "mp3", mp3_folders, mp3_files)}
    main = os.path.join(COVERS, f"{item_id}.jpg")
    if not os.path.exists(main):
        for side in ("flac", "mp3"):
            if sides[side]:
                shutil.copyfile(os.path.join(COVERS, f"{item_id}-{side}.jpg"), main)
                break
    return os.path.exists(main), [k for k, v in sides.items() if v]


def measure(path):
    """Where the spectrum stops, and integrated loudness (EBU R128), from one decode.
    Cached with the file's other facts, so it is redone only when the file changes."""
    e = fm.file_entry(path)
    if "cutoff" in e and "lufs" in e:
        return e
    secs = fm.duration(path) or 0
    start = max(0.0, secs / 2 - MEASURE_SECONDS / 2)
    w, h = 128, 512
    graph = (f"[0:a]asplit=2[l][s];[l]ebur128=framelog=quiet,anullsink;"
             f"[s]atrim=start={start:.1f}:duration={MEASURE_SECONDS},aformat=channel_layouts=mono,"
             f"showspectrumpic=s={w}x{h}:legend=0:saturation=0:win_func=bharris[v]")
    cutoff = lufs = None
    try:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-v", "info", "-i", path,
                            "-filter_complex", graph, "-map", "[v]", "-frames:v", "1",
                            "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                           capture_output=True, timeout=600)
        err = r.stderr.decode("utf-8", "replace")
        rate = re.search(r"Audio: .*?, (\d+) Hz", err)
        if len(r.stdout) == w * h and rate:
            # rows run from the top of the spectrum down; a row counts once its mean
            # brightness is off the floor, which a genuine recording's noise always is
            rows = [sum(r.stdout[y * w:(y + 1) * w]) / w for y in range(h)]
            if max(rows) >= 20:                      # not silence
                top = next(y for y, v in enumerate(rows) if v >= 1)
                cutoff = round((h - top) * int(rate.group(1)) / 2 / h)
        found = re.findall(r"I:\s+(-?[\d.]+) LUFS", err)
        if found and float(found[-1]) > -70:
            lufs = float(found[-1])
    except (subprocess.TimeoutExpired, OSError):
        pass
    with fm._cache_lock:
        e["cutoff"], e["lufs"] = cutoff, lufs
    return e


def tracks(files, flac=False, checks=True):
    if flac and checks:
        fm.flac_damaged(files)
    if checks:
        with ThreadPoolExecutor(6) as ex:
            list(ex.map(measure, files))
    out = []
    for p in files:
        i = fm.file_info(p)
        t = {"name": os.path.basename(p), "title": i.get("title") or "",
             "secs": round(i["secs"], 1) if i.get("secs") else None, "fmt": i.get("fmt") or "",
             "track": i.get("track"), "disc": i.get("disc")}
        if flac and i.get("damaged"):
            t["damaged"] = True
            t["decoded_s"] = i.get("decoded_s")
            t["bad_at"] = i.get("bad_at") or []
        if checks:
            t["cutoff"], t["lufs"] = i.get("cutoff"), i.get("lufs")
        out.append(t)
    return out


def suspect(item):
    """Flag an album whose FLAC tracks mostly stop short, as a converted MP3's would."""
    cuts = [t["cutoff"] for t in item["flac"]["tracks"] if t.get("cutoff")]
    low = sorted(c for c in cuts if c < SUSPECT_HZ)
    item["suspect"] = None
    if cuts and len(low) * 2 > len(cuts):
        mp3 = sorted(t["cutoff"] for t in (item["mp3"] or {}).get("tracks", []) if t.get("cutoff"))
        item["suspect"] = {"low": len(low), "of": len(cuts), "hz": low[len(low) // 2],
                           "mp3_hz": mp3[len(mp3) // 2] if mp3 else None}
        note = (f"Possibly a converted MP3: {len(low)} of {len(cuts)} FLAC tracks stop around "
                f"{low[len(low) // 2] / 1000:.1f} kHz")
        if item["suspect"]["mp3_hz"]:
            note += f" (the MP3 stops around {item['suspect']['mp3_hz'] / 1000:.1f} kHz)"
        item["reasons"].insert(0, note)
        item["_reasons"].insert(0, note)
    return item


# ---- release details -----------------------------------------------------------

TAGS = ["album", "albumartist", "date", "originaldate", "label", "catalognumber", "barcode",
        "media", "releasecountry", "releasestatus", "musicbrainz_albumid",
        "musicbrainz_releasegroupid", "genre"]
_releases = {}


def releases(inst):
    """Every album's release as Lidarr knows it: the release its files were imported as,
    else the one it has selected. One read of the database per build."""
    if inst in _releases:
        return _releases[inst]
    out = {}
    try:
        db = sqlite3.connect(CONF[f"{inst}_db"], uri=True)
        rows = db.execute("""
            select a.Id, a.ForeignAlbumId, a.ReleaseDate, a.AlbumType, r.Id, r.ForeignReleaseId,
                   r.Title, r.Disambiguation, r.ReleaseDate, r.Label, r.Country, r.Media,
                   r.TrackCount, r.Status, r.Monitored,
                   exists(select 1 from Tracks t where t.AlbumReleaseId = r.Id and t.TrackFileId > 0)
            from Albums a join AlbumReleases r on r.AlbumId = a.Id""").fetchall()
    except Exception as e:
        log(f"WARNING: {inst} database not read for release details ({e})")
        rows = []

    def listed(raw, key=None):
        try:
            v = json.loads(raw or "[]")
        except ValueError:
            return ""
        return ", ".join(sorted({str(x.get(key) if key else x) for x in v if (x.get(key) if key else x)}))
    for (aid, rg, first, kind, rid, mbid, title, dis, date, label, country, media,
         count, status, mon, has_files) in rows:
        rank = (has_files, mon)
        if aid in out and out[aid]["_rank"] >= rank:
            continue
        out[aid] = {"_rank": rank, "release": mbid, "release_group": rg,
                    "title": title + (f" ({dis})" if dis else ""), "date": (date or "")[:10],
                    "original": (first or "")[:10], "type": kind, "label": listed(label),
                    "country": listed(country), "format": listed(media, "format"),
                    "tracks": count, "status": status}
    _releases[inst] = out
    return out


def release_options(album_id):
    """Lidarr-FLAC's releases for an album, for choosing which one Soularr looks for. The
    browser picks by index into this list; the engine finds the release again by MBID."""
    try:
        db = sqlite3.connect(CONF["flac_db"], uri=True)
        rows = db.execute("""select ForeignReleaseId, Title, Disambiguation, ReleaseDate, Country, Label,
                                    Media, TrackCount, Monitored
                             from AlbumReleases where AlbumId = ? order by ReleaseDate, Id""", (album_id,)).fetchall()
    except Exception:
        return []
    out = []
    for mbid, title, dis, date, country, label, media, count, mon in rows:
        def listed(raw, key=None):
            try:
                v = json.loads(raw or "[]")
            except ValueError:
                return ""
            return ", ".join(sorted({str(x.get(key) if key else x) for x in v if (x.get(key) if key else x)}))
        out.append({"release": mbid, "title": title + (f" ({dis})" if dis else ""), "date": (date or "")[:10],
                    "country": listed(country), "label": listed(label), "format": listed(media, "format"),
                    "tracks": count, "selected": bool(mon)})
    return out


def details(inst, album_id, files):
    d = {k: v for k, v in releases(inst).get(album_id, {}).items() if not k.startswith("_")} \
        if inst and album_id else {}
    tags = {}
    try:
        m = mutagen.File(files[0], easy=True) if files else None
        for k in TAGS:
            if m and m.get(k):
                tags[k] = "; ".join(str(v) for v in m[k])[:200]
    except Exception:
        pass
    d["tags"] = tags
    # rsync -t and Lidarr's import keep mtimes, so the newest file is when the album arrived
    try:
        newest = max(os.path.getmtime(p) for p in files)
        d["imported"] = datetime.fromtimestamp(newest).strftime("%Y-%m-%dT%H:%M:%S")
    except (ValueError, OSError):
        pass
    return d


def binned_copy(path):
    """Where a folder that has left the library is now: still in place, or somewhere in the
    bin, found through the move that took it (or a folder above it) there."""
    if os.path.isdir(path):
        return path
    for e in fm.load_json(BIN, {"entries": []})["entries"]:
        for o in e["ops"]:
            if o["op"] == "move" and (path == o["from"] or path.startswith(o["from"] + "/")):
                there = o["to"] + path[len(o["from"]):]
                if os.path.isdir(there):
                    return there
    return None


def refetch_reference(rec):
    """The copy a refetched album replaced, if it is still in the bin: the MP3 it was first
    retired against, else the library FLAC Library health binned."""
    mp3 = [binned_copy(os.path.join(CONF["quarantine"], os.path.relpath(d, CONF["mp3_root"])))
           or binned_copy(d) for d in rec.get("mp3_dirs", [])]
    if mp3 and all(mp3):
        files = fm.folder_audio(mp3)
        if files:
            return "MP3", files
    old = rec.get("old_flac") and binned_copy(rec["old_flac"])
    files = fm.folder_audio([old]) if old else []
    return ("FLAC", files) if files else (None, [])


def refetched(e):
    """A no-MP3 album that is really a library album refetched from Library health: checked
    against the copy it replaced, so a good one can go through Stage all like any other."""
    rec = fm.load_json(CONF["refetched"], {}).get(str(e["flac_id"]))
    if not rec:
        return None
    day = datetime.fromisoformat(rec["at"]).strftime("%-d %b")
    kind, ref = refetch_reference(rec)
    out = {"on": rec["at"], "against": kind}
    if not ref:
        out["reason"] = (f"Refetched from Library health on {day}; the copy it replaced has left the bin, "
                         "so there is nothing to compare it with; every FLAC file decodes cleanly")
        return out
    odd = [t for t in fm.match_tracks(ref, e["flac_files"]) if not t["same"]]
    what = "the MP3 it first replaced" if kind == "MP3" else "the library copy it replaced"
    if odd:
        out["queue"] = "different"
        out["reason"] = (f"Refetched from Library health on {day}; {len(odd)} of {len(ref)} tracks of {what} "
                         "(still in the bin) have no fingerprint match: " + ", ".join(t["mp3"] for t in odd[:3]))
    else:
        out["queue"] = "ready"
        out["reason"] = (f"Refetched from Library health on {day}; every track matches {what} "
                         "(still in the bin) by fingerprint, and every FLAC file decodes cleanly")
    return out


def item_from_plan(e, hold):
    q = QUEUES[e["status"]]
    reasons = list(e["notes"])
    again = refetched(e) if e["status"] == "no_mp3" and e.get("flac_files") else None
    if again:
        reasons.insert(0, again["reason"])
        if again.get("queue"):
            e = {**e, "status": "refetched"}
            q = again["queue"]
    if e["status"] == "retire":
        reasons.insert(0, "Every track matches, and every FLAC file decodes cleanly")
    elif e["status"] == "no_mp3" and not again:
        reasons.insert(0, "No MP3 of this album to replace; every FLAC file decodes cleanly")
    flac_files, mp3_files = e.get("flac_files", []), e.get("mp3_files", [])
    if hold:
        reasons.append("An earlier damaged copy is also held; any decision puts it in the bin")
    has_mp3 = bool(mp3_files)
    allowed = []
    if q in ("ready", "different", "lineup") and not e.get("mp3_shared") \
            and not e.get("damaged_files") and not os.path.exists(e["dest"]):
        allowed.append("keep_flac")
    if q == "arriving":
        allowed = []
    else:
        if has_mp3:
            allowed.append("keep_mp3")
        elif e["status"] in ("no_mp3", "refetched"):
            # nothing was replaced, so there is no Keep MP3 to throw it out with:
            # Put in the bin is the only way to say this album was never wanted
            allowed.append("bin_album")
        allowed += ["refetch", "watch"]
    main, sides = covers(e["flac_id"], [e["flac_dir"]], flac_files, e.get("mp3_dirs", []), mp3_files)
    item = {
        "id": e["flac_id"], "artist": e["artist"], "title": e["title"], "queue": q,
        "status": e["status"], "reasons": reasons, "allowed": allowed,
        "watch": e.get("monitored", False),
        "refetched": {"on": again["on"], "checked": bool(again.get("queue"))} if again else None,
        "flac": {"tracks": tracks(flac_files, flac=True, checks=q != "arriving"),
                 "seconds": e.get("flac_seconds"), "details": details("flac", e["flac_id"], flac_files)},
        "mp3": {"tracks": tracks(mp3_files, checks=q != "arriving"), "seconds": e.get("mp3_seconds"),
                "details": details("mp3", e.get("mp3_id"), mp3_files)} if has_mp3 else None,
        "pairs": [{k: t[k] for k in ("m", "f", "sim", "same")} for t in e.get("track_checks", [])],
        "foreign": bool(e.get("foreign_ids")),
        "reorder": len({os.path.dirname(p) for p in flac_files}) == 1,
        "_status": e["status"],
        "_reasons": list(reasons),
        "cover": main, "covers": sides,
        "_do": {"flac_dir": e["flac_dir"], "dest": e["dest"], "mp3_dirs": e.get("mp3_dirs", []),
                "mp3_id": e.get("mp3_id"), "mbid": e["mbid"],
                "hold": hold["hold"] if hold else None, "foreign_ids": e.get("foreign_ids", []),
                # a shared MP3 folder blocks Keep FLAC, unless every file in it matches
                # this FLAC: then the folder is this album, whatever the MP3 Lidarr filed
                "shared_ok": q in ("ready", "different", "lineup") and bool(e.get("mp3_shared"))
                             and len(e.get("mp3_dirs", [])) == 1 and not e.get("damaged_files")
                             and not os.path.exists(e["dest"])},
        "_files": {"flac": flac_files, "mp3": mp3_files},
    }
    item["releases"] = release_options(e["flac_id"])
    return item if q == "arriving" else suspect(item)


def item_from_hold(k, h):
    flac_files = fm.folder_audio([h["hold"]])
    mp3_files = fm.folder_audio(h["mp3_dirs"])
    broken = fm.flac_damaged(flac_files)
    pairs = fm.match_tracks(mp3_files, flac_files) if mp3_files and flac_files else []
    main, sides = covers(int(k), [h["hold"]], flac_files, h["mp3_dirs"], mp3_files)
    return suspect({
        "id": int(k), "artist": h["artist"], "title": h["title"], "queue": "damaged",
        "status": "damaged",
        "reasons": [f"{len(broken)} FLAC file(s) fail flac -t",
                    "Held in FLAC-damaged; the MP3 is the copy in Roon"],
        "allowed": (["keep_mp3"] if mp3_files else []) + ["refetch", "watch"],
        "watch": h.get("watch", True),
        "flac": {"tracks": tracks(flac_files, flac=True),
                 "seconds": round(sum(fm.duration(p) or 0 for p in flac_files), 1),
                 "details": details("flac", int(k), flac_files)},
        "mp3": {"tracks": tracks(mp3_files),
                "seconds": round(sum(fm.duration(p) or 0 for p in mp3_files), 1),
                "details": details("mp3", h.get("mp3_id"), mp3_files)}
               if mp3_files else None,
        "pairs": [{k2: t[k2] for k2 in ("m", "f", "sim", "same")} for t in pairs],
        "foreign": False,
        "reorder": len({os.path.dirname(p) for p in flac_files}) == 1,
        "_status": "damaged",
        "_reasons": [f"{len(broken)} FLAC file(s) fail flac -t",
                     "Held in FLAC-damaged; the MP3 is the copy in Roon"],
        "cover": main, "covers": sides,
        "_do": {"flac_dir": None, "dest": None, "mp3_dirs": h["mp3_dirs"],
                "mp3_id": h.get("mp3_id"), "mbid": h["mbid"], "hold": h["hold"], "foreign_ids": []},
        "_files": {"flac": flac_files, "mp3": mp3_files},
    })


LENGTH_SLACK = 5            # seconds two paired tracks may differ before they're called different edits


def diagnose(item):
    """Say in one sentence why an album didn't line up, and which decision fits. Also opens
    Keep FLAC for a shared MP3 folder whose every file matches this FLAC."""
    item["diagnosis"] = None
    if not item.get("mp3") or item["queue"] in ("arriving", "damaged", "look", "ready"):
        return item
    mp3, flac, pairs = item["mp3"]["tracks"], item["flac"]["tracks"], item["pairs"]
    name = lambda t: t.get("title") or t["name"]
    matched = [p for p in pairs if p["same"] and p["f"] is not None]
    unmatched = [mp3[p["m"]] for p in pairs if not p["same"] or p["f"] is None]
    used = {p["f"] for p in matched}
    spare = [t for k, t in enumerate(flac) if k not in used]
    do = item["_do"]
    if do.get("shared_ok"):
        if not unmatched and pairs and "keep_flac" not in item["allowed"]:
            item["allowed"].insert(0, "keep_flac")
        elif unmatched and "keep_flac" in item["allowed"]:
            item["allowed"].remove("keep_flac")
    d = None
    if not unmatched and pairs and do.get("shared_ok"):
        d = {"kind": "shared", "suggest": "keep_flac",
             "text": f"Every file in the MP3 folder matches this FLAC, so the folder is this album even though "
                     f"the MP3 Lidarr files some of it under another. Keep FLAC bins the whole folder."}
    elif len(flac) < len(mp3) and unmatched:
        names = ", ".join(name(t) for t in unmatched[:3]) + ("…" if len(unmatched) > 3 else "")
        d = {"kind": "missing", "suggest": "refetch",
             "text": f"The FLAC is missing {len(unmatched)} track{'s' * (len(unmatched) != 1)} the MP3 has: {names}."}
    elif not unmatched and pairs:
        off = [(name(mp3[p["m"]]), flac[p["f"]]["secs"] - mp3[p["m"]]["secs"]) for p in matched
               if flac[p["f"]].get("secs") and mp3[p["m"]].get("secs")
               and abs(flac[p["f"]]["secs"] - mp3[p["m"]]["secs"]) > LENGTH_SLACK]
        if off:
            big = max(off, key=lambda o: abs(o[1]))
            d = {"kind": "edits", "suggest": None,
                 "text": f"Every track matches, but "
                         + (f"{big[0]} differs in length" if len(off) == 1 else f"{len(off)} tracks differ in length, most {big[0]}")
                         + f" ({'+' if big[1] > 0 else '−'}{abs(big[1]):.0f} s in the FLAC): probably different edits. Listen before deciding."}
        elif len(flac) > len(mp3):
            d = {"kind": "bonus", "suggest": "keep_flac" if "keep_flac" in item["allowed"] else None,
                 "text": f"Every MP3 track matches; the FLAC has {len(flac) - len(mp3)} more (bonus tracks)."}
    elif unmatched and len(unmatched) * 2 <= len(mp3):
        near = [(name(u), name(t)) for u in unmatched for t in spare
                if u.get("secs") and t.get("secs") and abs(u["secs"] - t["secs"]) <= 3]
        if near:
            d = {"kind": "pair", "suggest": "pair",
                 "text": f"{near[0][0]} has no fingerprint match, but the FLAC's {near[0][1]} is the same length. "
                         f"Listen, then pair them by hand if they're the same."}
        else:
            d = {"kind": "few", "suggest": None,
                 "text": f"{len(unmatched)} of {len(mp3)} MP3 tracks have no match in the FLAC. Listen to "
                         + ", ".join(name(t) for t in unmatched[:2]) + " in both."}
    elif unmatched:
        d = {"kind": "other", "suggest": "refetch",
             "text": f"{len(unmatched)} of {len(mp3)} MP3 tracks don't match: probably a different recording or release."}
    if d and d["suggest"] == "refetch" and item.get("dupe") and not item.get("lidarr_flac"):
        # a duplicate Lidarr-FLAC doesn't have can't be searched for: keeping the MP3 is all it can do
        d["suggest"] = "keep_mp3" if d["kind"] == "missing" else None
    if d and d["suggest"] and d["suggest"] != "pair" and d["suggest"] not in item["allowed"]:
        # a library duplicate can't be re-fetched: when its FLAC is the one missing tracks,
        # the MP3 is the fuller copy
        d["suggest"] = "keep_mp3" if d["kind"] == "missing" and "keep_mp3" in item["allowed"] else None
    item["diagnosis"] = d
    return item


def apply_overrides(item, ov):
    """Lay Simon's hand-made pairs over the automatic ones. The automatic pairs stay in
    _auto so this can be re-run without fingerprinting anything."""
    ov = ov or {}
    item["one_album"] = bool(ov.get("one_album"))
    if "_auto" not in item:
        item["_auto"] = item["pairs"]
    flac_names = [os.path.basename(p) for p in item["_files"]["flac"]]
    mp3_names = [os.path.basename(p) for p in item["_files"]["mp3"]]
    forced = {}
    for p in ov.get("pairs", []):
        if p["mp3"] in mp3_names and p["flac"] in flac_names:
            forced[mp3_names.index(p["mp3"])] = flac_names.index(p["flac"])
    taken = set(forced.values())
    pairs = []
    for a in item["_auto"]:
        if a["m"] in forced:
            pairs.append({"m": a["m"], "f": forced[a["m"]], "sim": None, "same": True, "manual": True})
        elif a["f"] in taken:
            pairs.append({"m": a["m"], "f": None, "sim": None, "same": False})
        else:
            pairs.append(dict(a))
            taken.add(a["f"])
    item["pairs"] = pairs
    item["reasons"] = list(item["_reasons"])
    if forced:
        item["reasons"].append(f"{len(forced)} track pair(s) set by hand")
    # hand pairing can confirm an album the fingerprints could not, or unconfirm one
    if item["_status"] in ("retire", "unconfirmed") and pairs:
        all_same = all(p["same"] for p in pairs)
        item["queue"] = "ready" if all_same else "different"
        if all_same and item["_status"] == "unconfirmed":
            item["reasons"][0:0] = ["Every track matches, counting the pairs set by hand"]
    diagnose(item)
    # a probable converted MP3 never waits in Ready, whatever else it passes
    if item.get("suspect") and item["queue"] in ("ready", "different", "lineup"):
        item["queue"] = "suspect"
    return item


# ---- where a FLAC came from ----------------------------------------------------
# slskd records every download with the Soulseek user it came from. Lidarr renames files on
# import, so an album is matched to the remote folder by artist and title instead.

def downloads():
    """Remote album folders downloaded in full or part: (squashed folder name, user, when)."""
    try:
        db = sqlite3.connect(CONF["transfers_db"], uri=True)
        rows = db.execute("""select Username, Filename, max(EndedAt) from Transfers
                             where Direction = 'Download' and State = 48
                             group by Username, rtrim(Filename, replace(Filename, '\\', ''))""").fetchall()
    except Exception:
        return []
    out = []
    for user, name, ended in rows:
        # the album folder and the one above it, which often holds the artist's name
        parts = name.replace("\\", "/").split("/")[:-1]
        out.append((fm.squash(" ".join(parts[-2:])), words(parts[-1] if parts else ""), user, ended or ""))
    return out


def ignored_users():
    try:
        for line in open(CONF["soularr_config"]):
            m = re.match(r"\s*ignored_users\s*=(.*)$", line)
            if m:
                return [u.strip() for u in m.group(1).split(",") if u.strip()]
    except OSError:
        pass
    return []


def words(name):
    """Lower-case words, space-separated and padded, for whole-word matching."""
    return " " + " ".join(re.findall(r"[a-z0-9]+", name.lower())) + " "


def source_match(artist, title, folder, album, title_words):
    """Does a downloaded folder (with the one above it) hold this album? `artist`, `title`
    and `folder` are squashed; `album` and `title_words` are words()."""
    if title not in folder or artist not in folder:
        return False
    if artist == title:
        # self-titled: the name once is any folder with the artist in it, a remix say
        return folder.count(artist) >= 2
    if len(title) <= 4:
        # a short title like "Fy" or "1991" turns up inside other words
        return title_words in album
    return True


def add_sources(items):
    """Name the user each album came from, and how their other albums in the queue fared."""
    dl = downloads()
    blocked = set(ignored_users())
    for i in items:
        i["source"] = None
        if i.get("dupe") or not i.get("flac"):
            continue
        artist, title = fm.squash(i["artist"]), fm.squash(i["title"])
        if not artist or not title:
            continue
        found = sorted((when, user) for folder, album, user, when in dl if source_match(artist, title, folder, album, words(i["title"])))
        if found:
            i["source"] = {"user": found[-1][1]}
    by_user = collections.defaultdict(list)
    for i in items:
        if i.get("source"):
            by_user[i["source"]["user"]].append(i)
    for user, albums in by_user.items():
        bad = sum(1 for i in albums if i["queue"] in ("suspect", "damaged"))
        for i in albums:
            i["source"].update(albums=len(albums), bad=bad, blocked=user in blocked)
    return items


def block_user(item):
    """Add the album's source user to Soularr's ignored_users, recorded for Undo."""
    user = (item.get("source") or {}).get("user")
    if not user or not re.fullmatch(r"[^,\r\n=]{1,60}", user):
        raise RuntimeError("no Soulseek user to block for this album")
    en = Entry("block_user", item)
    en.d["label"] = f"Blocked {user} (from {item['artist']} — {item['title']})"
    en.ignore_user(user)
    save_entry(en.d)
    log(f"blocked Soulseek user {user}")


def set_ignored(change):
    path = CONF["soularr_config"]
    lines = open(path).read().split("\n")
    for n, line in enumerate(lines):
        m = re.match(r"(\s*ignored_users\s*=)(.*)$", line)
        if m:
            users = [u.strip() for u in m.group(2).split(",") if u.strip()]
            lines[n] = m.group(1) + " " + ",".join(change(users))
            break
    else:
        raise RuntimeError("Soularr's config has no ignored_users line")
    tmp = path + ".sift-tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines))
        f.flush()
        os.fsync(f.fileno())                      # a power cut must not leave Soularr an empty config
    shutil.copymode(path, tmp)
    os.replace(tmp, path)
    d = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(d)
    finally:
        os.close(d)


# ---- library duplicates --------------------------------------------------------
# /mnt/roon-music/FLAC predates Lidarr-FLAC and holds some albums the MP3 library also has.
# Neither folder came through Soularr, so they're found by folder name alone.

DUPE_BASE = 900_000_000     # ids above every Lidarr album id, stable for a given FLAC folder


def dupe_id(flac_dir):
    return DUPE_BASE + zlib.crc32(flac_dir.encode()) % 100_000_000


def album_folders(root):
    out = []
    try:
        artists = sorted(os.listdir(root))
    except OSError:
        return out
    for a in artists:
        ad = os.path.join(root, a)
        if not os.path.isdir(ad) or a == "Sift-bin":
            continue
        for d in sorted(os.listdir(ad)):
            if os.path.isdir(os.path.join(ad, d)):
                out.append((a, d, os.path.join(ad, d)))
    return out


def mp3_owners():
    """MP3 file path -> the MP3 Lidarr album that holds it, if the database can be read."""
    try:
        return fm.mp3_albums()[2]
    except Exception:
        return {}


def find_dupes(taken):
    """FLAC library folders whose artist and album names match an MP3 folder: same title,
    and one artist name inside the other, as mp3_folder_named() matches. `taken` holds
    folders the review queue already covers."""
    index = collections.defaultdict(list)
    for a, d, path in album_folders(CONF["mp3_root"]):
        if path not in taken:
            index[fm.squash(d)].append((fm.squash(a), path))
    found = []
    for a, d, path in album_folders(CONF["flac_dest"]):
        want = fm.squash(a)
        mp3 = [p for have, p in index.get(fm.squash(d), [])
               if want and have and (want in have or have in want)]
        if mp3 and path not in taken:
            found.append({"artist": a, "title": d, "flac_dir": path, "mp3_dirs": mp3})
    return found


_mp3_titles = None


def same_album(mp3_id, title):
    """Whether the MP3 Lidarr's album `mp3_id` has this title. Unknown counts as yes, as before."""
    global _mp3_titles
    if _mp3_titles is None:
        try:
            db = sqlite3.connect(CONF["mp3_db"], uri=True)
            _mp3_titles = {aid: fm.squash(t) for aid, t in db.execute("select Id, Title from Albums")}
        except Exception as e:
            log(f"WARNING: MP3 Lidarr albums not read ({e})")
            _mp3_titles = {}
    have = _mp3_titles.get(mp3_id)
    return have is None or have == fm.squash(title)


_flac_titles = None


def lidarr_flac_album(artist, title):
    """The Lidarr-FLAC album a library duplicate is, found by name as find_dupes() matches
    folders: same title, one artist name inside the other. Only a single match counts.
    None when Lidarr-FLAC doesn't have it (often because MusicBrainz doesn't)."""
    global _flac_titles
    if _flac_titles is None:
        _flac_titles = collections.defaultdict(list)
        try:
            db = sqlite3.connect(CONF["flac_db"], uri=True)
            for aid, t, name, mon in db.execute("""select a.Id, a.Title, am.Name, a.Monitored from Albums a
                                                   join ArtistMetadata am on am.Id = a.ArtistMetadataId"""):
                _flac_titles[fm.squash(t)].append((fm.squash(name), aid, bool(mon)))
        except Exception as e:
            log(f"WARNING: Lidarr-FLAC albums not read ({e})")
    want = fm.squash(artist)
    hits = [(aid, mon) for name, aid, mon in _flac_titles.get(fm.squash(title), [])
            if want and name and (want in name or name in want)]
    return {"id": hits[0][0], "monitored": hits[0][1]} if len(hits) == 1 else None


def item_from_dupe(d, owners):
    flac_files = fm.folder_audio([d["flac_dir"]])
    mp3_files = fm.folder_audio(d["mp3_dirs"])
    if not flac_files or not mp3_files:
        return None
    iid = dupe_id(d["flac_dir"])
    broken = fm.flac_damaged(flac_files)
    pairs = fm.match_tracks(mp3_files, flac_files)
    odd = [t for t in pairs if not t["same"]]
    flac_s = round(sum(fm.duration(p) or 0 for p in flac_files), 1)
    mp3_s = round(sum(fm.duration(p) or 0 for p in mp3_files), 1)
    reasons = []
    if broken:
        reasons.append(f"{len(broken)} FLAC file(s) fail flac -t")
    if len(d["mp3_dirs"]) > 1:
        reasons.append(f"{len(d['mp3_dirs'])} MP3 folders have this name")
    if len(flac_files) < len(mp3_files):
        reasons.append("FLAC has fewer tracks")
    if odd:
        reasons.append(f"{len(odd)} MP3 track(s) not fingerprint-matched")
    if not reasons:
        reasons.append("Every track matches, and every FLAC file decodes cleanly")
    reasons.append("Both copies are in the Roon library already")
    ids = {owners.get(p) for p in mp3_files} - {None}
    mp3_id = next(iter(ids)) if len(ids) == 1 else None
    if mp3_id and not same_album(mp3_id, d["title"]):
        # the MP3 Lidarr files these tracks under an album of another name: unmonitoring that
        # album on Keep FLAC would change the wrong one
        mp3_id = None
    in_flac = lidarr_flac_album(d["artist"], d["title"])
    main, sides = covers(iid, [d["flac_dir"]], flac_files, d["mp3_dirs"], mp3_files)
    item = {
        "id": iid, "artist": d["artist"], "title": d["title"], "queue": "dupes",
        "status": "dupe", "reasons": reasons, "watch": False, "dupe": True,
        "allowed": (["keep_flac"] if not broken and len(d["mp3_dirs"]) == 1 else []) + ["keep_mp3", "refetch"],
        "lidarr_flac": {"monitored": in_flac["monitored"]} if in_flac else None,
        "flac": {"tracks": tracks(flac_files, flac=True), "seconds": flac_s,
                 "details": details(None, None, flac_files)},
        "mp3": {"tracks": tracks(mp3_files), "seconds": mp3_s,
                "details": details("mp3", mp3_id, mp3_files)},
        "pairs": [{k: t[k] for k in ("m", "f", "sim", "same")} for t in pairs],
        "foreign": False, "reorder": False,
        "_status": "dupe", "_reasons": list(reasons),
        "cover": main, "covers": sides,
        "_do": {"kind": "dupe", "flac_dir": d["flac_dir"], "mp3_dirs": d["mp3_dirs"],
                "mp3_id": mp3_id, "flac_album": in_flac and in_flac["id"], "hold": None, "foreign_ids": []},
        "_files": {"flac": flac_files, "mp3": mp3_files},
    }
    return suspect(item)


# ---- health of the FLAC library ---------------------------------------------------
# /mnt/roon-music/FLAC was never checked. A nightly job at low priority runs flac -t and the
# spectrum measurement over it a slice at a time; albums with damaged or suspect files come
# up in Library health. It is ext4, so reading while Roon plays is harmless.

HEALTH_BASE = 800_000_000


def folder_sig(files):
    st = [os.stat(p) for p in files]
    return [len(files), sum(x.st_size for x in st), max((x.st_mtime_ns for x in st), default=0)]


def health(minutes):
    # unmounted, the library is an empty folder, and every album would drop out of health.json
    require_mounted(mount_of(CONF["flac_dest"]))
    guard = open(os.path.join(STATE, "health.lock"), "w")
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("a health check is already running", flush=True)
        return
    stop = time.time() + minutes * 60
    albums = fm.load_json(HEALTH, {}).get("albums", {})
    folders = [path for _, _, path in album_folders(CONF["flac_dest"])]
    if albums and not folders:
        raise RuntimeError(f"refusing: {CONF['flac_dest']} has no albums in it")
    updates = {path: None for path in albums if path not in folders}
    # never-checked folders first, then the longest ago
    folders.sort(key=lambda p: (p in albums, albums.get(p, {}).get("checked", "")))
    done = 0
    for path in folders:
        if time.time() > stop:
            break
        # one album at a time under the shared lock, so a decision never moves files
        # health has open; it waits for this one album at most
        with Lock():
            try:
                files = fm.folder_audio([path]) if os.path.isdir(path) else []
                if not files:
                    continue
                sig = folder_sig(files)
                if albums.get(path, {}).get("sig") == sig:
                    continue
                broken = fm.flac_damaged(files)
                with ThreadPoolExecutor(3) as ex:
                    cuts = [e.get("cutoff") for e in ex.map(measure, [p for p in files if p.lower().endswith(".flac")])]
            except OSError as e:                  # moved or binned while we looked
                log(f"health: skipped {path}: {e}")
                continue
        cuts = [c for c in cuts if c]
        low = sorted(c for c in cuts if c < SUSPECT_HZ)
        updates[path] = albums[path] = {"checked": now(), "sig": sig, "tracks": len(files), "damaged": len(broken),
                                        "low": len(low), "of": len(cuts), "hz": low[len(low) // 2] if low else None}
        done += 1
        if done % 10 == 0:
            save_health(updates)
    save_health(updates)
    left = sum(1 for p in folders if p not in albums)
    log(f"health: checked {done} album folders, {left} never checked yet")


def save_health(updates):
    """Merge this run's results into health.json as it is on disk now, so a "looks fine"
    made while health runs is kept."""
    with Lock():
        h = fm.load_json(HEALTH, {})
        albums = h.setdefault("albums", {})
        for path, rec in updates.items():
            if rec is None:
                albums.pop(path, None)
            else:
                albums[path] = rec
        fm.save_json(HEALTH, h)
        fm.save_cache()
    updates.clear()


def health_items(taken):
    h = fm.load_json(HEALTH, {})
    # albums Sift or the migration moved here keep their Lidarr-FLAC id as the ledger key
    moved = {v.get("dest"): k for k, v in fm.load_json(CONF["migrated"], {}).items() if v.get("dest")}
    items = []
    for path, rec in h.get("albums", {}).items():
        bad = rec["damaged"] or (rec["of"] and rec["low"] * 2 > rec["of"])
        if not bad or path in taken or h.get("dismissed", {}).get(path) == rec["sig"] or not os.path.isdir(path):
            continue
        files = fm.folder_audio([path])
        if not files or folder_sig(files) != rec["sig"]:
            continue                          # changed since: the next night looks again
        iid = HEALTH_BASE + zlib.crc32(path.encode()) % 100_000_000
        artist, title = os.path.relpath(path, CONF["flac_dest"]).split(os.sep)
        reasons = ([f"{rec['damaged']} FLAC file(s) with damaged audio"] if rec["damaged"] else []) \
            + ["Already in the Roon FLAC library; no MP3 is involved"]
        main, sides = covers(iid, [path], files, [], [])
        key = moved.get(path)
        if key:
            in_flac = {"id": int(key), "monitored": False}
        else:                                 # "Album (2023)" is filed in Lidarr as "Album"
            in_flac = lidarr_flac_album(artist, re.sub(r"\s*\(\d{4}\)$", "", title))
        item = {"id": iid, "artist": artist, "title": title, "queue": "health", "status": "health",
                "reasons": reasons, "_reasons": list(reasons), "allowed": ["bin_album", "refetch", "dismiss"], "watch": False,
                "lidarr_flac": {"monitored": in_flac["monitored"]} if in_flac else None,
                "flac": {"tracks": tracks(files, flac=True), "seconds": round(sum(fm.duration(p) or 0 for p in files), 1),
                         "details": details(None, None, files)},
                "mp3": None, "pairs": [], "foreign": False, "reorder": False, "health": True,
                "cover": main, "covers": sides, "_status": "health",
                "_do": {"kind": "health", "flac_dir": path, "mp3_dirs": [], "mp3_id": None, "hold": None,
                        "foreign_ids": [], "sig": rec["sig"], "flac_album": in_flac and in_flac["id"],
                        "migrated_key": key},
                "_files": {"flac": files, "mp3": []}}
        items.append(suspect(item))
    return items


def dismiss(item):
    """Library health only: this album is fine as it is, until its files change."""
    h = fm.load_json(HEALTH, {})
    h.setdefault("dismissed", {})[item["_do"]["flac_dir"]] = item["_do"]["sig"]
    fm.save_json(HEALTH, h)
    q = fm.load_json(QUEUE, {})
    q["items"] = [i for i in q.get("items", []) if i["id"] != item["id"]]
    fm.save_json(QUEUE, q)
    log(f"looks fine: {item['artist']} — {item['title']}")


def health_bin(item, en):
    en.to_bin(item["_do"]["flac_dir"])


def health_refetch(item, en):
    """Bin a damaged or suspect library album and have Soularr look for a better one: its
    migration record goes, so a new copy comes through the queue again, and it is monitored
    in Lidarr-FLAC. Without a Lidarr-FLAC album this is Put in the bin."""
    do = item["_do"]
    key = do.get("migrated_key")
    rec = fm.load_json(CONF["migrated"], {}).get(key) if key else None
    en.to_bin(do["flac_dir"])
    if key:
        # the new copy arrives with no MP3 behind it: this is what it gets checked against
        en.ledger("refetched", key, {"at": now(), "mp3_dirs": (rec or {}).get("mp3_dirs", []),
                                     "old_flac": en.d["ops"][-1]["to"]})
        en.ledger("migrated", key, None)
    if do.get("flac_album"):
        en.monitor("flac", do["flac_album"], True)


def build_queue():
    ov = fm.load_json(OVERRIDES, {})
    one = {int(k) for k, v in ov.items() if v.get("one_album")}
    plan = fm.build_plan(one_album=one)
    hold = fm.load_json(CONF["damaged"], {})
    seen_ids = {e["flac_id"] for e in plan}
    items = [item_from_plan(e, hold.get(str(e["flac_id"]))) for e in plan]
    items += [item_from_hold(k, h) for k, h in hold.items()
              if int(k) not in seen_ids and os.path.isdir(h["hold"])]
    taken = {d for i in items for d in [i["_do"].get("dest"), *i["_do"].get("mp3_dirs", [])] if d}
    owners = mp3_owners()
    for i in items:
        if i["_do"].get("shared_ok"):
            i["_do"]["mp3_foreign_ids"] = sorted({owners[p] for p in i["_files"]["mp3"] if owners.get(p)}
                                                 - {i["_do"]["mp3_id"], None})
    dupes = [i for i in (item_from_dupe(d, owners) for d in find_dupes(taken)) if i]
    items += dupes
    items += health_items(taken | {i["_do"]["flac_dir"] for i in dupes})
    for i in items:
        apply_overrides(i, ov.get(str(i["id"])))
    add_sources(items)
    fm.save_cache()
    return items


def write_queue(items, checked=False):
    old = fm.load_json(QUEUE, {})
    first = {str(i["id"]): i.get("first_seen") for i in old.get("items", [])}
    for i in items:
        i["first_seen"] = first.get(str(i["id"])) or now()
    items.sort(key=lambda i: (i["artist"].casefold(), i["title"].casefold()))
    meta = {"built": now(),
            "checked": now() if checked else old.get("checked"),
            "previous_check": old.get("checked") if checked else old.get("previous_check")}
    fm.save_json(QUEUE, {**meta, "items": items})


def check():
    t = time.time()
    # one check at a time: a first run can outlast the 2-hour schedule
    guard = open(os.path.join(STATE, "check.lock"), "w")
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("a check is already running", flush=True)
        return
    build_queue()                        # the slow part - fingerprints land in the cache
    with Lock():
        write_queue(build_queue(), checked=True)   # all cached now, so quick
    q = fm.load_json(QUEUE, {})
    counts = {}
    for i in q["items"]:
        counts[i["queue"]] = counts.get(i["queue"], 0) + 1
    log(f"check: {counts} in {time.time() - t:.0f}s")
    try:
        notify(q["items"])
    except Exception as e:
        log(f"WARNING: jot not sent ({e})")


# ---- telling Simon -------------------------------------------------------------

def jot_cookie():
    """A short JotScribe session, signed the way its server signs one (see its makeSession)."""
    secret = json.load(open(CONF["jot_auth"]))["secret"]
    payload = base64.urlsafe_b64encode(json.dumps(
        {"exp": int((time.time() + 300) * 1000)}).encode()).rstrip(b"=").decode()
    mac = base64.urlsafe_b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256)
                                   .digest()).rstrip(b"=").decode()
    return f"mdedit_sid={payload}.{mac}"


QUEUE_WORDS = {"ready": "ready", "suspect": "suspect", "different": "different", "lineup": "don't line up",
               "damaged": "damaged", "look": "need a look", "dupes": "duplicates", "health": "library health"}


def refetch_outcomes(items, told):
    """Albums sent back to Soularr that have come back since: better, the same, or worse."""
    h = fm.load_json(HISTORY, {})
    decided = [e for e in fm.load_json(BIN, {"entries": []})["entries"]
               + [x for em in h.get("emptied", []) for x in em["entries"]] if e["decision"] == "refetch"]
    by_id = {i["id"]: i for i in items if i["queue"] != "arriving"}
    out = []
    for e in decided:
        i = by_id.get(e.get("album_id"))
        if not i or e["id"] in told or (i.get("first_seen") or "") <= e["at"]:
            continue
        verdict = {"ready": "better: now Ready", "suspect": "worse: suspect again",
                   "damaged": "worse: damaged again"}.get(i["queue"], f"no better yet ({QUEUE_WORDS.get(i['queue'], i['queue'])})")
        out.append((e["id"], f"{i['artist']} — {i['title']} came back {verdict}"))
    return out


def notify(items):
    """Jot when albums have arrived that need a decision: counts by queue, how re-fetched
    albums came back, and how much of the bin is past the retention setting. At most once a
    day; albums already told about are remembered, so nothing is announced twice. The first
    run only records what is already waiting."""
    state = fm.load_json(NOTIFY, None)
    waiting = {i["id"]: i for i in items if i["queue"] != "arriving"}
    if state is None:
        fm.save_json(NOTIFY, {"told": sorted(waiting), "sent": None, "refetches": []})
        return
    told = set(state.get("told", []))
    new = [i for k, i in waiting.items() if k not in told]
    last = state.get("sent")
    if not new or (last and datetime.fromisoformat(last) > datetime.now() - timedelta(days=1)):
        return
    counts = collections.Counter(i["queue"] for i in new)
    parts = [f"{n} {QUEUE_WORDS.get(q, q)}" for q, n in sorted(counts.items(), key=lambda x: list(QUEUE_WORDS).index(x[0])
                                                                 if x[0] in QUEUE_WORDS else 99)]
    outcomes = refetch_outcomes(items, set(state.get("refetches", [])))
    lines = [f"{i['artist']} — {i['title']}" + ("" if i["queue"] == "ready" else f" ({QUEUE_WORDS.get(i['queue'], i['queue'])})")
             for i in sorted(new, key=lambda i: (i["queue"] != "ready", i["artist"].casefold()))]
    body = lines[:40] + ([f"…and {len(lines) - 40} more"] if len(lines) > 40 else [])
    if outcomes:
        body += ["", "Re-fetched:"] + [t for _, t in outcomes]
    days = fm.load_json(SETTINGS, {}).get("retention_days")
    if days:
        old = older_than(fm.load_json(BIN, {"entries": []})["entries"], days)
        if old:
            body += ["", f"Bin: {sum(e.get('bytes', 0) for e in old) / 1e9:.1f} GB is over {days} days old."]
    body += ["", "http://100.70.110.7:8305"]
    req = urllib.request.Request(
        CONF["jot_url"], method="POST",
        data=json.dumps({"subject": "Sift: " + ", ".join(parts), "body": "\n".join(body)}).encode(),
        headers={"Content-Type": "application/json", "Cookie": jot_cookie()})
    urllib.request.urlopen(req, timeout=30).read()
    # albums decided since drop out, so one that comes back (a re-fetch) is announced again
    fm.save_json(NOTIFY, {"told": sorted(waiting), "sent": now(),
                          "refetches": sorted(set(state.get("refetches", [])) | {k for k, _ in outcomes})})
    log(f"jot sent: {', '.join(parts)}")


# ---- the bin and moves ---------------------------------------------------------

def mount_of(path):
    for m in CONF["bins"]:
        if path == m or path.startswith(m + "/"):
            return m
    raise SystemExit(f"refusing: {path} is not on a drive with a bin")


def require_mounted(m):
    """An unmounted drive leaves its mount point as a plain folder on the root disk:
    moving into it fills root, and the files hide once the drive comes back."""
    if CONF.get("check_mounts", True) and not os.path.ismount(m):
        raise RuntimeError(f"refusing: the {os.path.basename(m)} drive is not mounted")


def bin_dir(entry_id, path):
    m = mount_of(path)
    return os.path.join(CONF["bins"][m], entry_id, os.path.relpath(path, m))


def prune(path, stop):
    """Remove folders a move left empty - never a library root or a bin itself."""
    keep = {CONF["flac_src"], CONF["mp3_root"], CONF["flac_dest"], *CONF["bins"].values()}
    d = os.path.dirname(path)
    while d.startswith(stop + "/") and d not in keep and os.path.isdir(d) and not os.listdir(d):
        os.rmdir(d)
        d = os.path.dirname(d)


class Stranded(RuntimeError):
    """A cross-drive move failed and couldn't be put back whole: files are on both sides."""


def move(src, dst):
    """A rename on the same drive; across drives a checksummed rsync that removes each
    source file only once it has landed."""
    if not os.path.exists(src):
        raise RuntimeError(f"missing: {src}")
    if os.path.exists(dst):
        raise RuntimeError(f"already exists: {dst}")
    require_mounted(mount_of(src))
    require_mounted(mount_of(dst))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isfile(src) and mount_of(src) != mount_of(dst):
        raise RuntimeError(f"single files only move within a drive: {src}")
    if mount_of(src) == mount_of(dst):
        os.rename(src, dst)
    else:
        r = subprocess.run(["rsync", "-rt", "--checksum", "--remove-source-files",
                            "--exclude", ".fuse_hidden*", src + "/", dst + "/"],
                           capture_output=True, text=True)
        left = leftovers(src)
        if r.returncode or left:
            # put back whatever landed, so the caller's rollback starts from where it began
            back = subprocess.run(["rsync", "-rt", "--checksum", "--remove-source-files",
                                   "--exclude", ".fuse_hidden*", dst + "/", src + "/"], capture_output=True)
            stuck = leftovers(dst)
            if not stuck:
                subprocess.run(["find", dst, "-depth", "-type", "d", "-empty", "-delete"])
                prune(dst, mount_of(dst))
            why = f"rsync {src}: {r.stderr.strip()[:200]} ({len(left)} left: " + ", ".join(left[:3]) + ")"
            if back.returncode or stuck:
                raise Stranded(f"{why}; putting it back failed too, {len(stuck)} files still in {dst}")
            raise RuntimeError(why)
        clear_fuse_hidden(src)
        subprocess.run(["find", src, "-depth", "-type", "d", "-empty", "-delete"])
    prune(src, mount_of(src))


def merge_back(src, dst):
    """Undo a cross-drive move that was cut off: some files landed in `src`, the rest are
    still in `dst`. rsync only removes a source file once it has landed whole."""
    require_mounted(mount_of(src))
    require_mounted(mount_of(dst))
    r = subprocess.run(["rsync", "-rt", "--checksum", "--remove-source-files",
                        "--exclude", ".fuse_hidden*", src + "/", dst + "/"], capture_output=True, text=True)
    left = leftovers(src)
    if r.returncode or left:
        raise RuntimeError(f"rsync {src}: {r.stderr.strip()[:200]} ({len(left)} left)")
    clear_fuse_hidden(src)
    subprocess.run(["find", src, "-depth", "-type", "d", "-empty", "-delete"])
    prune(src, mount_of(src))


def leftovers(folder):
    """Files still in a folder after a move. `.fuse_hidden*` is ntfs-3g's name for a file
    already deleted while something still had it open - gone, just not yet released."""
    return [f for _, _, fs in os.walk(folder) for f in fs if not f.startswith(".fuse_hidden")]


def clear_fuse_hidden(folder, wait=10):
    """Give open handles a moment to close so the emptied folder can be removed."""
    for _ in range(wait):
        if not any(f.startswith(".fuse_hidden") for _, _, fs in os.walk(folder) for f in fs):
            return
        time.sleep(1)


class Entry:
    """Everything one decision did, in order, so undo can walk it backwards."""
    def __init__(self, decision, item):
        self.d = {"id": datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6],
                  "at": now(), "decision": decision, "album_id": item["id"],
                  "label": f"{item['artist']} — {item['title']}", "ops": []}

    def journal(self):
        """Written as each step starts, so a decision killed partway (a service restart,
        a crash) still reaches the bin and can be undone. See recover()."""
        os.makedirs(PENDING, exist_ok=True)
        fm.save_json(os.path.join(PENDING, self.d["id"] + ".json"), self.d)

    def move(self, src, dst):
        op = {"op": "move", "from": src, "to": dst, "pending": True}
        self.d["ops"].append(op)
        self.journal()
        try:
            move(src, dst)
        except Stranded:
            self.journal()                        # still pending: undo_ops merges it back
            raise
        except Exception:
            self.d["ops"].remove(op)              # move() has put everything back itself
            self.journal()
            raise
        del op["pending"]
        self.journal()

    def to_bin(self, src):
        self.move(src, bin_dir(self.d["id"], src))

    def monitor(self, inst, album_id, value):
        before = lidarr(inst, f"/album/{album_id}").get("monitored")
        lidarr(inst, "/album/monitor", "PUT", {"albumIds": [album_id], "monitored": value})
        self.d["ops"].append({"op": "monitor", "inst": inst, "album": album_id,
                              "before": before})
        self.journal()

    def release(self, album_id, mbid):
        """Make `mbid` the album's selected release in Lidarr-FLAC, which Soularr searches for."""
        album = lidarr("flac", f"/album/{album_id}")
        rels = album.get("releases", [])
        if not any(r["foreignReleaseId"] == mbid for r in rels):
            raise RuntimeError("Lidarr-FLAC doesn't list that release for this album")
        before = next((r["foreignReleaseId"] for r in rels if r.get("monitored")), None)
        any_ok = album.get("anyReleaseOk", False)
        set_release(album_id, mbid, album)
        self.d["ops"].append({"op": "release", "album": album_id, "before": before, "any_ok": any_ok})
        self.journal()

    def ignore_user(self, user):
        already = user in ignored_users()
        if not already:
            set_ignored(lambda users: users + [user])
        self.d["ops"].append({"op": "ignore_user", "user": user, "added": not already})
        self.journal()

    def ledger(self, which, key, value):
        """Set (or with value None, delete) one ledger entry, remembering the first
        value it had in this decision."""
        path = CONF[which]
        data = fm.load_json(path, {})
        if not any(o["op"] == "ledger" and o["file"] == which and o["key"] == key
                   for o in self.d["ops"]):
            self.d["ops"].append({"op": "ledger", "file": which, "key": key,
                                  "before": data.get(key)})
            self.journal()
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
        fm.save_json(path, data)


def set_release(album_id, mbid, album=None, any_ok=False):
    """Select `mbid` (None leaves the releases as they are) and set anyReleaseOk."""
    album = album or lidarr("flac", f"/album/{album_id}")
    if mbid:
        for r in album.get("releases", []):
            r["monitored"] = r["foreignReleaseId"] == mbid
    album["anyReleaseOk"] = any_ok
    lidarr("flac", f"/album/{album_id}", "PUT", album)


def undo_ops(ops, failed=None, progress=None):
    """Reverse `ops`, last first, carrying on past errors. The ops that couldn't be
    reversed are added to `failed` if given. With `progress` (which saves the ops), each op
    is marked `reversed` as it finishes, and a move is marked pending before it starts, so
    an undo that stops partway resumes from where it was: see undo_problems()."""
    errors = []
    for o in reversed(ops):
        if o.get("reversed"):
            continue
        try:
            if o["op"] == "move":
                if not o.get("pending") or not os.path.exists(o["from"]):
                    if progress and not o.get("pending"):
                        o["pending"] = True           # cut off from here, merge_back finishes it
                        progress()
                    move(o["to"], o["from"])
                elif os.path.exists(o["to"]):
                    merge_back(o["to"], o["from"])
                # pending with nothing at "to": the move never started
            elif o["op"] == "monitor":
                if o["before"] is not None:
                    lidarr(o["inst"], "/album/monitor", "PUT",
                           {"albumIds": [o["album"]], "monitored": o["before"]})
            elif o["op"] == "ignore_user":
                if o["added"]:
                    set_ignored(lambda users: [u for u in users if u != o["user"]])
            elif o["op"] == "release":
                set_release(o["album"], o["before"], any_ok=o.get("any_ok", False))
            elif o["op"] == "retag":
                retag(o["dir"], [{"from": c["to"], "to": c["from"], "tag": c["tag_before"]}
                                 for c in o["changes"]])
                rename_in_overrides(o["album"], {c["to"]: c["from"] for c in o["changes"]})
            elif o["op"] == "id3v1":
                with open(o["file"], "ab") as f:
                    f.write(base64.b64decode(o["tag"]))
            elif o["op"] == "ledger":
                data = fm.load_json(CONF[o["file"]], {})
                if o["before"] is None:
                    data.pop(o["key"], None)
                else:
                    data[o["key"]] = o["before"]
                fm.save_json(CONF[o["file"]], data)
        except Exception as e:
            errors.append(f"{o['op']}: {e}")
            if failed is not None:
                failed.insert(0, o)
            continue
        if progress:
            o["reversed"] = True
            progress()
    return errors


def entry_bytes(entry):
    total = 0
    for o in entry["ops"]:
        if o["op"] == "move" and "/Sift-bin/" in o["to"] and os.path.isdir(o["to"]):
            total += sum(os.path.getsize(os.path.join(dp, f))
                         for dp, _, fs in os.walk(o["to"]) for f in fs)
    return total


def save_entry(entry):
    b = fm.load_json(BIN, {"entries": []})
    entry["bytes"] = entry_bytes(entry)
    b["entries"].append(entry)
    fm.save_json(BIN, b)
    drop_journal(entry)


def drop_journal(entry):
    try:
        os.remove(os.path.join(PENDING, entry["id"] + ".json"))
    except FileNotFoundError:
        pass


def recover():
    """Decisions that were cut off go in the bin as they stand, marked interrupted, so
    Undo can put their files and ledgers back. Runs whenever the lock is taken."""
    try:
        names = [n for n in os.listdir(PENDING) if n.endswith(".json")]
    except FileNotFoundError:
        return
    for name in names:
        entry = fm.load_json(os.path.join(PENDING, name), None)
        if not entry:
            continue
        entry["interrupted"] = True
        entry["label"] += " (interrupted: undo to put it back)"
        save_entry(entry)
        log(f"INTERRUPTED {entry['decision']}: {entry['label']} is in the bin")


def undo_problems(entry, entries):
    """Everything that would stop this undo, found before anything changes."""
    # a block on a Soulseek user changes nothing an album decision touches
    touches = lambda e: any(o["op"] != "ignore_user" for o in e["ops"])
    after = entries[entries.index(entry) + 1:]           # bin.json is in the order decisions were made
    later = [e for e in after if entry.get("album_id") is not None and touches(entry) and touches(e)
             and e.get("album_id") == entry["album_id"]]
    if later:
        return [f"undo the later {later[-1]['decision']} on this album ({later[-1]['label']}) first"]
    problems = []
    for o in entry["ops"]:
        if o.get("reversed"):
            continue                              # put back by an undo that stopped partway
        if o["op"] == "move":
            try:
                require_mounted(mount_of(o["from"]))
                require_mounted(mount_of(o["to"]))
            except (RuntimeError, SystemExit) as e:
                problems.append(str(e))
                continue
            if o.get("pending") and os.path.exists(o["from"]):
                continue                          # merged back, or never started
            if not os.path.exists(o["to"]):
                problems.append(f"missing: {o['to']}")
            elif os.path.exists(o["from"]):
                problems.append(f"already exists: {o['from']}")
        elif o["op"] == "retag":
            tos = {c["to"] for c in o["changes"]}
            for c in o["changes"]:
                if not os.path.isfile(os.path.join(o["dir"], c["to"])):
                    problems.append(f"missing: {os.path.join(o['dir'], c['to'])}")
                elif c["from"] not in tos and os.path.exists(os.path.join(o["dir"], c["from"])):
                    problems.append(f"already exists: {os.path.join(o['dir'], c['from'])}")
        elif o["op"] == "id3v1":
            if not os.path.isfile(o["file"]):
                problems.append(f"missing: {o['file']}")
            elif has_id3v1(o["file"]):
                problems.append(f"already has a tag on the end: {o['file']}")
    return problems


# ---- ID3v1 tags on the end of old rips ---------------------------------------------

def has_id3v1(path):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        if f.tell() < 128:
            return False
        f.seek(-128, os.SEEK_END)
        return f.read(3) == b"TAG"


def strip_id3(folders=None):
    """Cut the ID3v1 tag off the end of every library FLAC that carries one and whose audio
    matches its own header MD5. Roon ignores the tag; the reference decoder trips over it,
    which is how these files were flagged as damaged. One bin entry per album folder holds
    each tag, so undo puts them back byte for byte."""
    folders = folders or [path for _, _, path in album_folders(CONF["flac_dest"])]
    done = 0
    for folder in folders:
        files = [p for p in fm.folder_audio([folder]) if p.lower().endswith(".flac") and has_id3v1(p)]
        if not files:
            continue
        with Lock():
            require_mounted(mount_of(folder))
            artist, title = (os.path.relpath(folder, CONF["flac_dest"]).split(os.sep) + ["", ""])[:2]
            item = {"id": HEALTH_BASE + zlib.crc32(folder.encode()) % 100_000_000, "artist": artist, "title": title}
            en = Entry("strip_id3", item)
            for p in files:
                r = fm.decode_check(p)
                if not r or not r["md5_ok"]:
                    log(f"strip-id3: left alone, audio doesn't match its header: {p}")
                    continue
                with open(p, "rb+") as f:
                    f.seek(-128, os.SEEK_END)
                    tag = f.read(128)
                    en.d["ops"].append({"op": "id3v1", "file": p, "tag": base64.b64encode(tag).decode()})
                    en.journal()
                    f.seek(-128, os.SEEK_END)
                    f.truncate()
                fm.file_entry(p)                   # the file changed: its cache record starts over
                done += 1
            if not en.d["ops"]:
                drop_journal(en.d)
                continue
            save_entry(en.d)
            h = fm.load_json(HEALTH, {})
            if h.get("albums", {}).pop(folder, None) is not None:
                fm.save_json(HEALTH, h)            # measured again on the next health run
            fm.save_cache()
        log(f"strip-id3: {len(en.d['ops'])} tag(s) cut from {artist} — {title}")
        print(f"{artist} — {title}: {len(en.d['ops'])} tag(s) cut", flush=True)
    print(f"{done} file(s) trimmed", flush=True)
    if done:
        refresh_queue()


# ---- decisions -----------------------------------------------------------------

def keep_flac(item, en):
    do, k = item["_do"], str(item["id"])
    if item.get("one_album"):
        # the rest of this folder goes with the album, so the entries Lidarr misfiled
        # those tracks under must not go looking for them
        for other in item["_do"].get("foreign_ids", []):
            en.monitor("flac", other, False)
    if os.path.exists(do["dest"]):
        raise RuntimeError(f"already in the FLAC library: {do['dest']}")
    en.monitor("flac", item["id"], False)
    en.ledger("migrated", k, {
        "mbid": do["mbid"], "artist": item["artist"], "title": item["title"],
        "status": "sift_keep_flac", "dest": do["dest"], "mp3_dirs": do["mp3_dirs"],
        "mp3_id": do["mp3_id"], "started": now()})
    en.ledger("returned", k, None)
    en.ledger("refetched", k, None)
    en.move(do["flac_dir"], do["dest"])
    for d in do["mp3_dirs"]:
        en.to_bin(d)
    if do["mp3_id"]:
        en.monitor("mp3", do["mp3_id"], False)
    if do.get("shared_ok"):
        # the other entries the MP3 Lidarr filed this folder's tracks under
        for other in do.get("mp3_foreign_ids", []):
            en.monitor("mp3", other, False)
    if do["hold"]:
        en.to_bin(do["hold"])
        en.ledger("damaged", k, None)
    rec = fm.load_json(CONF["migrated"], {})[k]
    en.ledger("migrated", k, {**rec, **fm.arrival_stats(do["dest"]), "done": now()})


def keep_mp3(item, en):
    do, k = item["_do"], str(item["id"])
    if item.get("one_album"):
        # the rest of this folder goes with the album, so the entries Lidarr misfiled
        # those tracks under must not go looking for them
        for other in item["_do"].get("foreign_ids", []):
            en.monitor("flac", other, False)
    en.monitor("flac", item["id"], False)
    en.ledger("returned", k, {"mbid": do["mbid"], "artist": item["artist"],
                              "title": item["title"], "status": "keep_mp3",
                              "decision": "sift_keep_mp3", "mp3_id": do["mp3_id"],
                              "mp3_dirs": do["mp3_dirs"], "decided": now()})
    if do["flac_dir"]:
        en.to_bin(do["flac_dir"])
    if do["hold"]:
        en.to_bin(do["hold"])
        en.ledger("damaged", k, None)


def bin_album(item, en):
    """An album with no MP3 behind it that wasn't wanted: the FLAC goes in the bin and
    nothing takes its place. Unmonitored, and recorded in the returned ledger so Soularr
    won't put it back on the wanted list - which Watch undoes, as it does for Keep MP3."""
    do, k = item["_do"], str(item["id"])
    if item.get("one_album"):
        for other in do.get("foreign_ids", []):
            en.monitor("flac", other, False)
    en.monitor("flac", item["id"], False)
    en.ledger("returned", k, {"mbid": do["mbid"], "artist": item["artist"],
                              "title": item["title"], "status": "bin_album",
                              "decision": "sift_bin_album", "mp3_id": None,
                              "mp3_dirs": [], "decided": now()})
    if do["flac_dir"]:
        en.to_bin(do["flac_dir"])
    if do["hold"]:
        en.to_bin(do["hold"])
        en.ledger("damaged", k, None)


def refetch(item, en):
    do, k = item["_do"], str(item["id"])
    if item.get("one_album"):
        # the rest of this folder goes with the album, so the entries Lidarr misfiled
        # those tracks under must not go looking for them
        for other in item["_do"].get("foreign_ids", []):
            en.monitor("flac", other, False)
    if do["flac_dir"]:
        en.to_bin(do["flac_dir"])
    if do["hold"]:
        en.to_bin(do["hold"])
        en.ledger("damaged", k, None)
    en.ledger("returned", k, None)
    if item.get("_release"):
        en.release(item["id"], item["_release"])
    en.monitor("flac", item["id"], True)


def dupe_keep_flac(item, en):
    """The FLAC is already in the library, so only the MP3 moves: into the bin."""
    do = item["_do"]
    if len(do["mp3_dirs"]) != 1:
        raise RuntimeError("several MP3 folders have this name; decide in the shell")
    en.to_bin(do["mp3_dirs"][0])
    if do["mp3_id"]:
        en.monitor("mp3", do["mp3_id"], False)


def dupe_keep_mp3(item, en):
    en.to_bin(item["_do"]["flac_dir"])


def dupe_refetch(item, en):
    """Keep the MP3 and bin the FLAC, then have Soularr look for a better one: monitored in
    Lidarr-FLAC when Lidarr-FLAC has the album. When it doesn't, this is Keep MP3."""
    en.to_bin(item["_do"]["flac_dir"])
    if item["_do"].get("flac_album"):
        en.monitor("flac", item["_do"]["flac_album"], True)


DECISIONS = {"keep_flac": keep_flac, "keep_mp3": keep_mp3, "refetch": refetch, "bin_album": bin_album}
STAGEABLE = {"keep_flac", "keep_mp3", "refetch", "bin_album"}
DUPE_DECISIONS = {"keep_flac": dupe_keep_flac, "keep_mp3": dupe_keep_mp3, "refetch": dupe_refetch}


# ---- track tools ---------------------------------------------------------------

def set_override(album_id, change):
    ov = fm.load_json(OVERRIDES, {})
    rec = ov.setdefault(str(album_id), {})
    change(rec)
    if not rec.get("pairs") and not rec.get("one_album"):
        ov.pop(str(album_id), None)
    fm.save_json(OVERRIDES, ov)
    return ov.get(str(album_id))


def rename_in_overrides(album_id, mapping):
    def change(rec):
        for p in rec.get("pairs", []):
            p["flac"] = mapping.get(p["flac"], p["flac"])
    set_override(album_id, change)


def requick(item, ov):
    """Re-apply overrides to one album in queue.json - no fingerprinting, instant."""
    q = fm.load_json(QUEUE, {})
    for n, i in enumerate(q.get("items", [])):
        if i["id"] == item["id"]:
            q["items"][n] = apply_overrides(i, ov)
    fm.save_json(QUEUE, q)


def pair(item, m, f):
    mp3, flac = item["_files"]["mp3"], item["_files"]["flac"]
    if not (0 <= m < len(mp3) and 0 <= f < len(flac)):
        raise RuntimeError("no such track")
    a, b = os.path.basename(mp3[m]), os.path.basename(flac[f])

    def change(rec):
        rec["pairs"] = [p for p in rec.get("pairs", []) if p["mp3"] != a and p["flac"] != b]
        rec["pairs"].append({"mp3": a, "flac": b})
    requick(item, set_override(item["id"], change))
    log(f"paired by hand: {item['artist']} — {item['title']}: {a} = {b}")


def unpair(item, m):
    mp3 = item["_files"]["mp3"]
    if not 0 <= m < len(mp3):
        raise RuntimeError("no such track")
    a = os.path.basename(mp3[m])

    def change(rec):
        rec["pairs"] = [p for p in rec.get("pairs", []) if p["mp3"] != a]
    requick(item, set_override(item["id"], change))


def one_album(item, on):
    def change(rec):
        rec["one_album"] = on
    set_override(item["id"], change)
    log(f"one album {'on' if on else 'off'}: {item['artist']} — {item['title']}")


def bin_track(item, f):
    flac = item["_files"]["flac"]
    if not 0 <= f < len(flac):
        raise RuntimeError("no such track")
    en = Entry("bin_track", item)
    en.d["label"] += f": {os.path.basename(flac[f])}"
    en.to_bin(flac[f])
    save_entry(en.d)
    log(f"track to bin: {en.d['label']}")


TRACKNO = [re.compile(r"^(.* - )(\d{1,3})( - .+)$"), re.compile(r"^(\d{1,3})(\D.*)$")]


def renamed(name, number):
    for rx in TRACKNO:
        m = rx.match(name)
        if m:
            g = m.groups()
            width = len(g[1]) if rx is TRACKNO[0] else len(g[0])
            num = str(number).zfill(width)
            return g[0] + num + g[2] if rx is TRACKNO[0] else num + g[1]
    return name


def retag(folder, changes):
    """Rename and renumber files in one folder. Two passes through temporary names, so
    swapping 04 and 06 never collides. Every name is checked first, and a rename that fails
    puts back the ones before it, so no track is left under a temporary name."""
    froms = {c["from"] for c in changes}
    for c in changes:
        if not os.path.isfile(os.path.join(folder, c["from"])):
            raise RuntimeError(f"missing: {c['from']}")
        if c["to"] not in froms and os.path.exists(os.path.join(folder, c["to"])):
            raise RuntimeError(f"already exists: {c['to']}")
    renames = [(c["from"], f".sift-tmp-{n}") for n, c in enumerate(changes)] \
        + [(f".sift-tmp-{n}", c["to"]) for n, c in enumerate(changes)]
    done = []
    try:
        for a, b in renames:
            os.rename(os.path.join(folder, a), os.path.join(folder, b))
            done.append((a, b))
    except OSError:
        for a, b in reversed(done):
            os.rename(os.path.join(folder, b), os.path.join(folder, a))
        raise
    for c in changes:
        path = os.path.join(folder, c["to"])
        m = mutagen.File(path, easy=True)
        if c["tag"] is None:
            if "tracknumber" in m:
                del m["tracknumber"]
        else:
            m["tracknumber"] = c["tag"]
        m.save()


def reorder(item, order):
    flac = item["_files"]["flac"]
    if sorted(order) != list(range(len(flac))):
        raise RuntimeError("the new order must list every track once")
    if not item.get("reorder"):
        raise RuntimeError("tracks span several folders")
    folder = os.path.dirname(flac[0])
    changes = []
    for pos, idx in enumerate(order, 1):
        name = os.path.basename(flac[idx])
        m = mutagen.File(flac[idx], easy=True)
        before = m.get("tracknumber")
        changes.append({"from": name, "to": renamed(name, pos), "tag": [str(pos)],
                        "tag_before": before})
    finals = {c["to"] for c in changes}
    if len(finals) != len(changes):
        raise RuntimeError("the new filenames would collide")
    others = set(os.listdir(folder)) - {c["from"] for c in changes}
    if finals & others:
        raise RuntimeError("a new filename is already taken in the folder")
    en = Entry("reorder", item)
    en.d["ops"].append({"op": "retag", "dir": folder, "album": item["id"], "changes": changes})
    en.journal()
    try:
        retag(folder, changes)
    except Exception:
        drop_journal(en.d)
        raise
    rename_in_overrides(item["id"], {c["from"]: c["to"] for c in changes})
    save_entry(en.d)
    log(f"reordered: {item['artist']} — {item['title']}")


def track_tool(album_id, tool, args):
    with Lock():
        item = find_item(album_id)
        if tool == "pair":
            pair(item, int(args[0]), int(args[1]))
            return
        if tool == "unpair":
            unpair(item, int(args[0]))
            return
        if tool == "one-album":
            one_album(item, args[0] == "on")
        elif tool == "bin-track":
            bin_track(item, int(args[0]))
            rescan("flac")
        elif tool == "block-user":
            block_user(item)
        elif tool == "reorder":
            reorder(item, [int(x) for x in args[0].split(",")])
            rescan("flac")
        else:
            raise SystemExit("unknown tool")
        refresh_queue()


def find_item(album_id):
    for i in fm.load_json(QUEUE, {}).get("items", []):
        if i["id"] == album_id:
            return i
    raise SystemExit(f"album {album_id} is not in the queue")


def watch(item, on):
    """Monitoring only - no files move, so nothing goes in the bin."""
    lidarr("flac", "/album/monitor", "PUT", {"albumIds": [item["id"]], "monitored": on})
    k = str(item["id"])
    for which in ("returned", "damaged"):
        data = fm.load_json(CONF[which], {})
        if k in data:
            data[k]["watch"] = on
            fm.save_json(CONF[which], data)
    q = fm.load_json(QUEUE, {})
    for i in q.get("items", []):
        if i["id"] == item["id"]:
            i["watch"] = on
    fm.save_json(QUEUE, q)
    log(f"watch {'on' if on else 'off'}: {item['artist']} — {item['title']}")


def decide(item, decision):
    if decision not in item["allowed"]:
        raise RuntimeError(f"{decision} is not available for this album")
    en = Entry(decision, item)
    table = {"dupe": DUPE_DECISIONS, "health": {"bin_album": health_bin, "refetch": health_refetch}}.get(item["_do"].get("kind"), DECISIONS)
    try:
        table[decision](item, en)
    except Exception as e:
        failed = []
        errors = undo_ops(en.d["ops"], failed)
        if failed:
            # something is still out of place, perhaps in the bin: keep what's left to put back
            # as a bin entry, so Undo can finish it and Empty bin never sees nameless files
            en.d["ops"] = failed
            en.d["interrupted"] = True
            en.d["label"] += " (rollback incomplete: undo to put it back)"
            save_entry(en.d)
        else:
            drop_journal(en.d)
        log(f"FAILED {decision} {en.d['label']}: {e}"
            + (f" - rollback problems: {errors}" if errors else " - rolled back"))
        raise
    save_entry(en.d)
    log(f"{decision}: {en.d['label']}")


def refresh_queue(done_ids=()):
    """Drop decided albums at once so the app updates, then rebuild properly."""
    q = fm.load_json(QUEUE, {})
    if done_ids and q:
        q["items"] = [i for i in q["items"] if i["id"] not in done_ids]
        fm.save_json(QUEUE, q)
    if not os.environ.get("SIFT_NO_REBUILD"):
        write_queue(build_queue())


def resolve(album_id, decision, release=None):
    with Lock():
        item = find_item(album_id)
        if release is not None:
            options = item.get("releases") or []
            if decision != "refetch" or not 0 <= release < len(options):
                raise SystemExit("no such release for this album")
            item["_release"] = options[release]["release"]
        if decision == "dismiss":
            if "dismiss" not in item["allowed"]:
                raise SystemExit("not available for this album")
            dismiss(item)
            return
        if decision in ("watch_on", "watch_off"):
            if "watch" not in item["allowed"]:
                raise SystemExit("watching is not available for this album")
            watch(item, decision == "watch_on")
            return
        decide(item, decision)
        rescan("flac"), rescan("mp3")
        refresh_queue({album_id})


def resolve_many(decision, ids, only_queue=None):
    """One decision for several albums, each its own bin entry so each undoes on its own.
    An album that fails is rolled back and skipped; the rest go ahead."""
    with Lock():
        items = [i for i in fm.load_json(QUEUE, {}).get("items", [])
                 if (only_queue is None and i["id"] in ids) or i["queue"] == only_queue]
        done = set()
        for i in items:
            try:
                decide(i, decision)
                done.add(i["id"])
            except Exception as e:
                print(f"skipped {i['artist']} — {i['title']}: {e}", flush=True)
                remember("failed", {"at": now(), "decision": decision, "album_id": i["id"],
                                    "label": f"{i['artist']} — {i['title']}", "error": str(e)[:300]})
        rescan("flac"), rescan("mp3")
        refresh_queue(done)
    return done, items


def apply_staged(spec):
    """Decisions staged in the app and then approved, each (album id, decision, release
    index or None). Each gets its own bin entry, as one at a time would; an album that
    fails is rolled back and skipped, and the rest go ahead."""
    with Lock():
        by_id = {i["id"]: i for i in fm.load_json(QUEUE, {}).get("items", [])}
        done = set()
        for album_id, decision, release in spec:
            i = by_id.get(album_id)
            label = f"{i['artist']} — {i['title']}" if i else f"album {album_id}"
            # one line per album as it starts and ends: the app follows these to take each
            # album off the Staged list as it is done
            print(f"working [{album_id}] {label}", flush=True)
            try:
                if not i:
                    raise RuntimeError("no longer in the queue")
                if release is not None:
                    options = i.get("releases") or []
                    if decision != "refetch" or not 0 <= release < len(options):
                        raise RuntimeError("no such release for this album")
                    i["_release"] = options[release]["release"]
                decide(i, decision)
                done.add(album_id)
                print(f"done [{album_id}] {decision}: {label}", flush=True)
            except Exception as e:
                print(f"skipped [{album_id}] {label}: {e}", flush=True)
                remember("failed", {"at": now(), "decision": decision, "album_id": album_id,
                                    "label": label, "error": str(e)[:300]})
        rescan("flac"), rescan("mp3")
        refresh_queue(done)
    log(f"apply-staged: {len(done)} of {len(spec)} done")
    return done


def approve_ready():
    done, ready = resolve_many("keep_flac", (), only_queue="ready")
    log(f"approve-ready: {len(done)} of {len(ready)} moved into the FLAC library")


def remember(kind, record):
    """history.json keeps what leaves bin.json, so the history page and totals outlive it."""
    h = fm.load_json(HISTORY, {})
    h.setdefault(kind, []).append(record)
    fm.save_json(HISTORY, h)


def summary(entry):
    return {k: entry.get(k) for k in ("id", "at", "decision", "album_id", "label", "bytes")}


def undo(entry_id):
    with Lock():
        b = fm.load_json(BIN, {"entries": []})
        entry = next((e for e in b["entries"] if e["id"] == entry_id), None)
        if not entry:
            raise SystemExit("no such bin entry")
        problems = undo_problems(entry, b["entries"])
        if problems:
            raise SystemExit("can't undo, nothing changed: " + "; ".join(problems[:3]))
        for o in entry["ops"]:
            # another entry still blocks this user: leave them blocked, and that entry's
            # undo becomes the one that unblocks
            other = next((x for e in b["entries"] if e is not entry for x in e["ops"]
                          if x["op"] == "ignore_user" and x["user"] == o.get("user")), None)
            if o["op"] == "ignore_user" and o["added"] and other:
                o["added"], other["added"] = False, True
        errors = undo_ops(entry["ops"], progress=lambda: fm.save_json(BIN, b))
        if errors:
            log(f"undo {entry['label']} incomplete: {errors}")
            raise SystemExit("undo incomplete, Undo again to finish once fixed: " + "; ".join(errors))
        b["entries"] = [e for e in b["entries"] if e["id"] != entry_id]
        fm.save_json(BIN, b)
        remember("undone", {**summary(entry), "undone": now()})
        rescan("flac"), rescan("mp3")
        refresh_queue()
    log(f"undo {entry['decision']}: {entry['label']}")


SETTINGS = os.path.join(STATE, "settings.json")      # written by the web app


def bin_roots():
    roots = []
    for m, root in CONF["bins"].items():
        real = os.path.realpath(root)
        # only ever a folder named Sift-bin directly on one of the two drives,
        # and both are checked before anything is deleted
        if os.path.basename(real) != "Sift-bin" or os.path.dirname(real) != m:
            raise SystemExit(f"refusing to empty unexpected bin path {real}")
        require_mounted(m)
        if os.path.isdir(real):
            roots.append(real)
    return roots


def older_than(entries, days):
    cut = datetime.now() - timedelta(days=days)
    return [e for e in entries if datetime.fromisoformat(e["at"]) < cut]


def empty_bin(days=None):
    """Delete everything in the bin, or with `days` only the entries older than that. One
    entry at a time, saving bin.json after each, so a delete that fails partway never leaves
    an entry listed whose files are gone."""
    with Lock():
        b = fm.load_json(BIN, {"entries": []})
        gone = b["entries"] if days is None else older_than(b["entries"], days)
        roots = bin_roots()
        emptied, error = [], None
        for e in gone:
            try:
                for real in roots:
                    remove_tree(os.path.join(real, e["id"]))
            except OSError as err:
                error = f"{e['label']}: {err}"
                break
            emptied.append(e)
            b["entries"] = [x for x in b["entries"] if x["id"] != e["id"]]
            fm.save_json(BIN, b)
        if days is None and not error:
            # leftovers no entry names, e.g. from before bin.json existed
            for real in roots:
                for name in os.listdir(real):
                    remove_tree(os.path.join(real, name))
        freed = sum(e.get("bytes", 0) for e in emptied)
        if emptied:
            remember("emptied", {"at": now(), "bytes": freed, "entries": [summary(e) for e in emptied]})
    log(f"emptied bin{f' (older than {days} days)' if days else ''}: {len(emptied)} entries, {freed / 1e9:.1f} GB"
        + (f"; stopped at {error}" if error else ""))
    if error:
        raise RuntimeError(f"emptying stopped at {error}")


def remove_tree(path):
    """A symlink in the bin is only ever unlinked, never followed."""
    if os.path.islink(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)
    elif os.path.exists(path):
        os.remove(path)


def adopt(path, label):
    path = os.path.realpath(path)
    with Lock():
        item = {"id": None, "artist": label, "title": "(added from the shell)"}
        en = Entry("adopted", item)
        en.d["label"] = label
        en.to_bin(path)
        save_entry(en.d)
    log(f"adopted into bin: {path}")


def main():
    os.makedirs(STATE, exist_ok=True)
    a = sys.argv[1:]
    try:
        if a == ["check"]:
            check()
        elif len(a) == 3 and a[0] == "resolve":
            resolve(int(a[1]), a[2])
        elif len(a) == 4 and a[0] == "resolve" and a[3].isdigit():
            resolve(int(a[1]), a[2], int(a[3]))
        elif len(a) == 3 and a[0] == "resolve-many" and a[1] in DECISIONS \
                and re.fullmatch(r"\d+(,\d+)*", a[2]):
            done, items = resolve_many(a[1], {int(x) for x in a[2].split(",")})
            log(f"{a[1]} for {len(done)} of {len(items)} albums")
        elif len(a) == 2 and a[0] == "health" and a[1].isdigit():
            health(int(a[1]))
        elif len(a) == 2 and a[0] == "apply-staged" \
                and re.fullmatch(r"\d+:[a-z0-9_]+(:\d+)?(,\d+:[a-z0-9_]+(:\d+)?)*", a[1]):
            spec = []
            for part in a[1].split(","):
                bits = part.split(":")
                if bits[1] not in STAGEABLE:
                    sys.exit(f"{bits[1]} can't be staged")
                spec.append((int(bits[0]), bits[1], int(bits[2]) if len(bits) == 3 else None))
            if not apply_staged(spec):
                sys.exit("nothing was done")
        elif a == ["approve-ready"]:
            approve_ready()
        elif len(a) == 2 and a[0] == "undo":
            undo(a[1])
        elif a == ["empty-bin"]:
            empty_bin()
        elif len(a) == 2 and a[0] == "empty-bin" and a[1].isdigit() and int(a[1]) > 0:
            empty_bin(int(a[1]))
        elif len(a) == 2 and a[0] == "block-user":
            track_tool(int(a[1]), "block-user", [])
        elif len(a) >= 3 and a[0] in ("pair", "unpair", "one-album", "bin-track", "reorder", "block-user"):
            track_tool(int(a[1]), a[0], a[2:])
        elif len(a) == 3 and a[0] == "adopt":
            adopt(a[1], a[2])
        elif a[:1] == ["strip-id3"]:
            strip_id3(a[1:] or None)
        else:
            sys.exit(__doc__)
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
