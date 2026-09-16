#!/usr/bin/env python3
"""Sift's engine: builds the review queue and carries out decisions. See ~/sift/README.md.

    sift.py check                      classify every FLAC album, write queue.json
    sift.py resolve ID DECISION        keep_flac | keep_mp3 | refetch | watch_on | watch_off
    sift.py approve-ready              keep_flac for everything in the Ready queue
    sift.py undo ENTRY                 reverse a decision that is still in the bin
    sift.py empty-bin                  delete everything in the bin - the only delete there is
    sift.py adopt PATH LABEL           shell only: put an existing folder in the bin

    sift.py pair ID M F                MP3 track M is FLAC track F (indexes into the album)
    sift.py unpair ID M                forget a hand-made pair
    sift.py bin-track ID F             put one FLAC track in the bin
    sift.py reorder ID 2,0,1,...       renumber and rename FLAC tracks into this order
    sift.py one-album ID on|off        the whole FLAC folder is this album

The web app only ever runs the first five, with an album id or bin entry id it has checked
against queue.json / bin.json. Every path comes from those files, never from the browser.

Classification is flac_migrate.build_plan(), the same code the migration used, so an album
lands in Ready only after every FLAC file passes `flac -t` and every MP3 track matches a
FLAC track by fingerprint.
"""
import fcntl, json, os, re, shutil, subprocess, sys, time, urllib.request, uuid
from datetime import datetime

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
    "flac_api": fm.FLAC_API, "flac_config": "/DATA/AppData/lidarr-flac/config/config.xml",
    "mp3_api": "http://localhost:8686/api/v1", "mp3_config": "/DATA/AppData/lidarr/config/config.xml",
}
if os.environ.get("SIFT_CONF"):                    # the test suite's sandbox
    CONF.update(json.load(open(os.environ["SIFT_CONF"])))

QUEUE = os.path.join(STATE, "queue.json")
BIN = os.path.join(STATE, "bin.json")
COVERS = os.path.join(STATE, "covers")
# Simon's own calls on an album: tracks he paired by hand, folders he says are one album
OVERRIDES = os.path.join(STATE, "overrides.json")
LOG = os.path.join(STATE, "sift.log")

QUEUES = {"retire": "ready", "no_mp3": "ready", "unconfirmed": "different",
          "keep_mp3": "lineup", "damaged": "damaged", "manual": "look",
          "collision": "look", "wait": "arriving"}


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
        return {"monitored": True} if method == "GET" else {}
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

def cover(item_id, side, folders, files):
    """Save one picture for the album, from a folder image or embedded art. `side` only
    says where it was looked for; the FLAC's is tried first."""
    os.makedirs(COVERS, exist_ok=True)
    out = os.path.join(COVERS, f"{item_id}.jpg")
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
                return True
        except Exception:
            continue
    return False


def tracks(files, flac=False):
    if flac:
        fm.flac_damaged(files)
    out = []
    for p in files:
        i = fm.file_info(p)
        t = {"name": os.path.basename(p), "title": i.get("title") or "",
             "secs": round(i["secs"], 1) if i.get("secs") else None, "fmt": i.get("fmt") or ""}
        if flac and i.get("damaged"):
            t["damaged"] = True
            t["decoded_s"] = i.get("decoded_s")
        out.append(t)
    return out


def item_from_plan(e, hold):
    q = QUEUES[e["status"]]
    reasons = list(e["notes"])
    if e["status"] == "retire":
        reasons.insert(0, "Every track matches, and every FLAC file decodes cleanly")
    elif e["status"] == "no_mp3":
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
        allowed += ["refetch", "watch"]
    return {
        "id": e["flac_id"], "artist": e["artist"], "title": e["title"], "queue": q,
        "status": e["status"], "reasons": reasons, "allowed": allowed,
        "watch": e.get("monitored", False),
        "flac": {"tracks": tracks(flac_files, flac=q != "arriving"),
                 "seconds": e.get("flac_seconds")},
        "mp3": {"tracks": tracks(mp3_files), "seconds": e.get("mp3_seconds")} if has_mp3 else None,
        "pairs": [{k: t[k] for k in ("m", "f", "sim", "same")} for t in e.get("track_checks", [])],
        "foreign": bool(e.get("foreign_ids")),
        "reorder": len({os.path.dirname(p) for p in flac_files}) == 1,
        "_status": e["status"],
        "_reasons": list(reasons),
        "cover": cover(e["flac_id"], "flac", [e["flac_dir"]], flac_files)
                 or (has_mp3 and cover(e["flac_id"], "mp3", e["mp3_dirs"], mp3_files)),
        "_do": {"flac_dir": e["flac_dir"], "dest": e["dest"], "mp3_dirs": e.get("mp3_dirs", []),
                "mp3_id": e.get("mp3_id"), "mbid": e["mbid"],
                "hold": hold["hold"] if hold else None, "foreign_ids": e.get("foreign_ids", [])},
        "_files": {"flac": flac_files, "mp3": mp3_files},
    }


def item_from_hold(k, h):
    flac_files = fm.folder_audio([h["hold"]])
    mp3_files = fm.folder_audio(h["mp3_dirs"])
    broken = fm.flac_damaged(flac_files)
    pairs = fm.match_tracks(mp3_files, flac_files) if mp3_files and flac_files else []
    return {
        "id": int(k), "artist": h["artist"], "title": h["title"], "queue": "damaged",
        "status": "damaged",
        "reasons": [f"{len(broken)} FLAC file(s) fail flac -t",
                    "Held in FLAC-damaged; the MP3 is the copy in Roon"],
        "allowed": (["keep_mp3"] if mp3_files else []) + ["refetch", "watch"],
        "watch": h.get("watch", True),
        "flac": {"tracks": tracks(flac_files, flac=True),
                 "seconds": round(sum(fm.duration(p) or 0 for p in flac_files), 1)},
        "mp3": {"tracks": tracks(mp3_files),
                "seconds": round(sum(fm.duration(p) or 0 for p in mp3_files), 1)}
               if mp3_files else None,
        "pairs": [{k2: t[k2] for k2 in ("m", "f", "sim", "same")} for t in pairs],
        "foreign": False,
        "reorder": len({os.path.dirname(p) for p in flac_files}) == 1,
        "_status": "damaged",
        "_reasons": [f"{len(broken)} FLAC file(s) fail flac -t",
                     "Held in FLAC-damaged; the MP3 is the copy in Roon"],
        "cover": cover(int(k), "flac", [h["hold"]], flac_files)
                 or cover(int(k), "mp3", h["mp3_dirs"], mp3_files),
        "_do": {"flac_dir": None, "dest": None, "mp3_dirs": h["mp3_dirs"],
                "mp3_id": h.get("mp3_id"), "mbid": h["mbid"], "hold": h["hold"], "foreign_ids": []},
        "_files": {"flac": flac_files, "mp3": mp3_files},
    }


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
    return item


def build_queue():
    ov = fm.load_json(OVERRIDES, {})
    one = {int(k) for k, v in ov.items() if v.get("one_album")}
    plan = fm.build_plan(one_album=one)
    hold = fm.load_json(CONF["damaged"], {})
    seen_ids = {e["flac_id"] for e in plan}
    items = [item_from_plan(e, hold.get(str(e["flac_id"]))) for e in plan]
    items += [item_from_hold(k, h) for k, h in hold.items()
              if int(k) not in seen_ids and os.path.isdir(h["hold"])]
    for i in items:
        apply_overrides(i, ov.get(str(i["id"])))
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


# ---- the bin and moves ---------------------------------------------------------

def mount_of(path):
    for m in CONF["bins"]:
        if path == m or path.startswith(m + "/"):
            return m
    raise SystemExit(f"refusing: {path} is not on a drive with a bin")


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


def move(src, dst):
    """A rename on the same drive; across drives a checksummed rsync that removes each
    source file only once it has landed."""
    if not os.path.exists(src):
        raise RuntimeError(f"missing: {src}")
    if os.path.exists(dst):
        raise RuntimeError(f"already exists: {dst}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isfile(src) and mount_of(src) != mount_of(dst):
        raise RuntimeError(f"single files only move within a drive: {src}")
    if mount_of(src) == mount_of(dst):
        os.rename(src, dst)
    else:
        r = subprocess.run(["rsync", "-rt", "--checksum", "--remove-source-files",
                            src + "/", dst + "/"], capture_output=True, text=True)
        left = [f for _, _, fs in os.walk(src) for f in fs]
        if r.returncode or left:
            raise RuntimeError(f"rsync {src}: {r.stderr.strip()[:200]} ({len(left)} left)")
        subprocess.run(["find", src, "-depth", "-type", "d", "-empty", "-delete"])
    prune(src, mount_of(src))


class Entry:
    """Everything one decision did, in order, so undo can walk it backwards."""
    def __init__(self, decision, item):
        self.d = {"id": datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6],
                  "at": now(), "decision": decision, "album_id": item["id"],
                  "label": f"{item['artist']} — {item['title']}", "ops": []}

    def move(self, src, dst):
        move(src, dst)
        self.d["ops"].append({"op": "move", "from": src, "to": dst})

    def to_bin(self, src):
        self.move(src, bin_dir(self.d["id"], src))

    def monitor(self, inst, album_id, value):
        before = lidarr(inst, f"/album/{album_id}").get("monitored")
        lidarr(inst, "/album/monitor", "PUT", {"albumIds": [album_id], "monitored": value})
        self.d["ops"].append({"op": "monitor", "inst": inst, "album": album_id,
                              "before": before})

    def ledger(self, which, key, value):
        """Set (or with value None, delete) one ledger entry, remembering the first
        value it had in this decision."""
        path = CONF[which]
        data = fm.load_json(path, {})
        if not any(o["op"] == "ledger" and o["file"] == which and o["key"] == key
                   for o in self.d["ops"]):
            self.d["ops"].append({"op": "ledger", "file": which, "key": key,
                                  "before": data.get(key)})
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
        fm.save_json(path, data)


def undo_ops(ops):
    errors = []
    for o in reversed(ops):
        try:
            if o["op"] == "move":
                move(o["to"], o["from"])
            elif o["op"] == "monitor":
                if o["before"] is not None:
                    lidarr(o["inst"], "/album/monitor", "PUT",
                           {"albumIds": [o["album"]], "monitored": o["before"]})
            elif o["op"] == "retag":
                retag(o["dir"], [{"from": c["to"], "to": c["from"], "tag": c["tag_before"]}
                                 for c in o["changes"]])
                rename_in_overrides(o["album"], {c["to"]: c["from"] for c in o["changes"]})
            elif o["op"] == "ledger":
                data = fm.load_json(CONF[o["file"]], {})
                if o["before"] is None:
                    data.pop(o["key"], None)
                else:
                    data[o["key"]] = o["before"]
                fm.save_json(CONF[o["file"]], data)
        except Exception as e:
            errors.append(f"{o['op']}: {e}")
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
    en.move(do["flac_dir"], do["dest"])
    for d in do["mp3_dirs"]:
        en.to_bin(d)
    if do["mp3_id"]:
        en.monitor("mp3", do["mp3_id"], False)
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
    en.monitor("flac", item["id"], True)


DECISIONS = {"keep_flac": keep_flac, "keep_mp3": keep_mp3, "refetch": refetch}


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
    swapping 04 and 06 never collides."""
    for n, c in enumerate(changes):
        os.rename(os.path.join(folder, c["from"]), os.path.join(folder, f".sift-tmp-{n}"))
    for n, c in enumerate(changes):
        path = os.path.join(folder, c["to"])
        os.rename(os.path.join(folder, f".sift-tmp-{n}"), path)
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
    retag(folder, changes)
    en.d["ops"].append({"op": "retag", "dir": folder, "album": item["id"], "changes": changes})
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
    try:
        DECISIONS[decision](item, en)
    except Exception as e:
        errors = undo_ops(en.d["ops"])
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


def resolve(album_id, decision):
    with Lock():
        item = find_item(album_id)
        if decision in ("watch_on", "watch_off"):
            if "watch" not in item["allowed"]:
                raise SystemExit("watching is not available for this album")
            watch(item, decision == "watch_on")
            return
        decide(item, decision)
        rescan("flac"), rescan("mp3")
        refresh_queue({album_id})


def approve_ready():
    with Lock():
        ready = [i for i in fm.load_json(QUEUE, {}).get("items", []) if i["queue"] == "ready"]
        done = set()
        for i in ready:
            try:
                decide(i, "keep_flac")
                done.add(i["id"])
            except Exception as e:
                print(f"skipped {i['artist']} — {i['title']}: {e}", flush=True)
        rescan("flac"), rescan("mp3")
        refresh_queue(done)
    log(f"approve-ready: {len(done)} of {len(ready)} moved into the FLAC library")


def undo(entry_id):
    with Lock():
        b = fm.load_json(BIN, {"entries": []})
        entry = next((e for e in b["entries"] if e["id"] == entry_id), None)
        if not entry:
            raise SystemExit("no such bin entry")
        errors = undo_ops(entry["ops"])
        if errors:
            log(f"undo {entry['label']} incomplete: {errors}")
            raise SystemExit("undo incomplete: " + "; ".join(errors))
        b["entries"] = [e for e in b["entries"] if e["id"] != entry_id]
        fm.save_json(BIN, b)
        rescan("flac"), rescan("mp3")
        refresh_queue()
    log(f"undo {entry['decision']}: {entry['label']}")


def empty_bin():
    with Lock():
        b = fm.load_json(BIN, {"entries": []})
        freed = sum(e.get("bytes", 0) for e in b["entries"])
        roots = []
        for m, root in CONF["bins"].items():
            real = os.path.realpath(root)
            # only ever a folder named Sift-bin directly on one of the two drives,
            # and both are checked before anything is deleted
            if os.path.basename(real) != "Sift-bin" or os.path.dirname(real) != m:
                raise SystemExit(f"refusing to empty unexpected bin path {real}")
            if os.path.isdir(real):
                roots.append(real)
        for real in roots:
            for name in os.listdir(real):
                shutil.rmtree(os.path.join(real, name))
        fm.save_json(BIN, {"entries": []})
    log(f"emptied bin: {len(b['entries'])} entries, {freed / 1e9:.1f} GB")


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
        elif a == ["approve-ready"]:
            approve_ready()
        elif len(a) == 2 and a[0] == "undo":
            undo(a[1])
        elif a == ["empty-bin"]:
            empty_bin()
        elif len(a) >= 3 and a[0] in ("pair", "unpair", "one-album", "bin-track", "reorder"):
            track_tool(int(a[1]), a[0], a[2:])
        elif len(a) == 3 and a[0] == "adopt":
            adopt(a[1], a[2])
        else:
            sys.exit(__doc__)
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
