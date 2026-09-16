#!/usr/bin/env python3
"""Sift engine tests, in a throwaway sandbox: real moves, real rsync, fake Lidarr.

Two directories stand in for the two drives, so a FLAC moving into the library takes the
cross-drive rsync path exactly as it does on roon. Nothing under /mnt is touched.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SIFT = os.path.join(HERE, "..", "bin", "sift.py")
T = tempfile.mkdtemp(prefix="sift-test-")
MUSIC, DATA = f"{T}/music", f"{T}/data"          # "/mnt/roon-music" and "/mnt/roon-data"
STATE, API = f"{T}/state", f"{T}/api.log"
conf = {
    "flac_src": f"{DATA}/music-flac", "mp3_root": f"{MUSIC}/MP3", "flac_dest": f"{MUSIC}/FLAC",
    "bins": {MUSIC: f"{MUSIC}/Sift-bin", DATA: f"{DATA}/Sift-bin"},
    "migrated": f"{T}/migrated.json", "returned": f"{T}/returned.json",
    "damaged": f"{T}/damaged.json",
}
failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += not cond


def tone(path, fmt):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    "-c:a", fmt, path], check=True)


def sift(*args, ok=True):
    env = {**os.environ, "SIFT_STATE": STATE, "SIFT_CONF": f"{T}/conf.json",
           "SIFT_FAKE_API": API, "SIFT_NO_REBUILD": "1"}
    r = subprocess.run([sys.executable, SIFT, *args], env=env, capture_output=True, text=True)
    if ok and r.returncode:
        print(r.stdout, r.stderr)
    return r


def load(p, default=None):
    try:
        return json.load(open(p))
    except OSError:
        return default


def write_queue():
    flac_dir, mp3_dir = f"{DATA}/music-flac/Art/Alb", f"{MUSIC}/MP3/Art/Alb"
    items = [
        {"id": 1, "artist": "Art", "title": "Alb", "queue": "ready", "status": "retire",
         "allowed": ["keep_flac", "keep_mp3", "refetch", "watch"], "watch": True,
         "_do": {"flac_dir": flac_dir, "dest": f"{MUSIC}/FLAC/Art/Alb", "mp3_dirs": [mp3_dir],
                 "mp3_id": 11, "mbid": "mb-1", "hold": None}},
        {"id": 2, "artist": "Art2", "title": "Alb2", "queue": "damaged", "status": "damaged",
         "allowed": ["keep_mp3", "refetch", "watch"], "watch": True,
         "_do": {"flac_dir": None, "dest": None, "mp3_dirs": [f"{MUSIC}/MP3/Art2/Alb2"],
                 "mp3_id": 12, "mbid": "mb-2", "hold": f"{MUSIC}/FLAC-damaged/Art2/Alb2"}},
        {"id": 3, "artist": "Art3", "title": "Shared", "queue": "lineup", "status": "keep_mp3",
         "allowed": ["keep_mp3", "refetch", "watch"], "watch": False,
         "_do": {"flac_dir": f"{DATA}/music-flac/Art3/Shared", "dest": f"{MUSIC}/FLAC/Art3/Shared",
                 "mp3_dirs": [], "mp3_id": None, "mbid": "mb-3", "hold": None}},
    ]
    os.makedirs(STATE, exist_ok=True)
    json.dump({"items": items}, open(f"{STATE}/queue.json", "w"))


def setup():
    for i in (1, 2):
        tone(f"{DATA}/music-flac/Art/Alb/0{i}.flac", "flac")
        tone(f"{MUSIC}/MP3/Art/Alb/0{i}.mp3", "libmp3lame")
    tone(f"{MUSIC}/MP3/Art/Other/01.mp3", "libmp3lame")          # a sibling album that must survive
    tone(f"{MUSIC}/FLAC-damaged/Art2/Alb2/01.flac", "flac")
    tone(f"{MUSIC}/MP3/Art2/Alb2/01.mp3", "libmp3lame")
    tone(f"{DATA}/music-flac/Art3/Shared/01.flac", "flac")
    os.makedirs(f"{MUSIC}/FLAC", exist_ok=True)
    json.dump(conf, open(f"{T}/conf.json", "w"))
    json.dump({"2": {"artist": "Art2", "title": "Alb2", "mbid": "mb-2", "mp3_id": 12,
                     "mp3_dirs": [f"{MUSIC}/MP3/Art2/Alb2"],
                     "hold": f"{MUSIC}/FLAC-damaged/Art2/Alb2"}}, open(conf["damaged"], "w"))
    json.dump({"1": {"mbid": "mb-1", "status": "keep_mp3"}}, open(conf["returned"], "w"))
    write_queue()


def snapshot():
    return sorted(os.path.relpath(os.path.join(dp, f), T)
                  for dp, _, fs in os.walk(T) for f in fs
                  if "/state" not in dp and not f.endswith(".json") and not f.endswith(".log"))


setup()
before = snapshot()
returned_before = load(conf["returned"])

print("keep FLAC")
r = sift("resolve", "1", "keep_flac")
check(r.returncode == 0, "succeeds")
check(os.path.isfile(f"{MUSIC}/FLAC/Art/Alb/01.flac"), "FLAC is in the library")
check(not os.path.exists(f"{DATA}/music-flac/Art"), "source folder gone, empty artist folder pruned")
check(os.path.isdir(f"{DATA}/music-flac"), "library root kept")
entry = load(f"{STATE}/bin.json")["entries"][-1]
check(os.path.isfile(f"{MUSIC}/Sift-bin/{entry['id']}/MP3/Art/Alb/01.mp3"), "MP3 is in the bin")
check(os.path.isfile(f"{MUSIC}/MP3/Art/Other/01.mp3"), "sibling MP3 album untouched")
m = load(conf["migrated"])["1"]
check(m["status"] == "sift_keep_flac" and m["tracks"] == 2 and "done" in m, "migrated ledger records arrival")
check("1" not in load(conf["returned"]), "removed from returned ledger")
calls = [json.loads(l) for l in open(API)]
check(["flac", "PUT", "/album/monitor", {"albumIds": [1], "monitored": False}] in calls, "Lidarr-FLAC unmonitored")
check(["mp3", "PUT", "/album/monitor", {"albumIds": [11], "monitored": False}] in calls, "MP3 Lidarr unmonitored")
check(entry["bytes"] > 0, "bin entry has a size")
check(all(i["id"] != 1 for i in load(f"{STATE}/queue.json")["items"]), "album leaves the queue")

print("undo keep FLAC")
open(API, "w").close()
r = sift("undo", entry["id"])
check(r.returncode == 0, "succeeds")
check(snapshot() == before, "every file back where it was")
check("1" not in load(conf["migrated"], {}), "migrated ledger entry removed")
check(load(conf["returned"]) == returned_before, "returned ledger restored")
calls = [json.loads(l) for l in open(API)]
check(["flac", "PUT", "/album/monitor", {"albumIds": [1], "monitored": True}] in calls, "monitoring restored")
check(load(f"{STATE}/bin.json")["entries"] == [], "bin entry gone")

print("keep MP3 on a damaged hold")
write_queue()
r = sift("resolve", "2", "keep_mp3")
check(r.returncode == 0, "succeeds")
check(not os.path.exists(f"{MUSIC}/FLAC-damaged/Art2"), "damaged FLAC out of holding")
check(os.path.isfile(f"{MUSIC}/MP3/Art2/Alb2/01.mp3"), "MP3 stays")
check("2" not in load(conf["damaged"]), "damaged ledger cleared")
check(load(conf["returned"])["2"]["decision"] == "sift_keep_mp3", "recorded as kept MP3")
e2 = load(f"{STATE}/bin.json")["entries"][-1]
r = sift("undo", e2["id"])
check(r.returncode == 0 and snapshot() == before, "undo restores it")
check("2" in load(conf["damaged"]), "damaged ledger restored")

print("get a better FLAC")
write_queue()
open(API, "w").close()
r = sift("resolve", "1", "refetch")
check(r.returncode == 0, "succeeds")
check(not os.path.exists(f"{DATA}/music-flac/Art/Alb"), "FLAC in the bin")
check(os.path.isfile(f"{MUSIC}/MP3/Art/Alb/01.mp3"), "MP3 stays")
calls = [json.loads(l) for l in open(API)]
check(["flac", "PUT", "/album/monitor", {"albumIds": [1], "monitored": True}] in calls, "monitored again")

print("refusals")
write_queue()
r = sift("resolve", "3", "keep_flac", ok=False)
check(r.returncode != 0 and os.path.isdir(f"{DATA}/music-flac/Art3/Shared"), "a decision the album does not allow is refused")
r = sift("resolve", "99", "keep_mp3", ok=False)
check(r.returncode != 0, "an album not in the queue is refused")
os.makedirs(f"{MUSIC}/FLAC/Art3/Shared")
json.dump({"items": [{**load(f"{STATE}/queue.json")["items"][2], "allowed": ["keep_flac"],
                      "_do": {"flac_dir": f"{DATA}/music-flac/Art3/Shared", "dest": f"{MUSIC}/FLAC/Art3/Shared",
                              "mp3_dirs": [], "mp3_id": None, "mbid": "mb-3", "hold": None}}]},
          open(f"{STATE}/queue.json", "w"))
r = sift("resolve", "3", "keep_flac", ok=False)
check(r.returncode != 0 and os.path.isfile(f"{DATA}/music-flac/Art3/Shared/01.flac"), "an existing destination is refused, nothing moved")
check("3" not in load(conf["migrated"], {}), "and nothing recorded")
os.rmdir(f"{MUSIC}/FLAC/Art3/Shared"); os.rmdir(f"{MUSIC}/FLAC/Art3")

print("watch")
write_queue()
open(API, "w").close()
r = sift("resolve", "2", "watch_off")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and ["flac", "PUT", "/album/monitor", {"albumIds": [2], "monitored": False}] in calls, "watch off unmonitors")
check(load(conf["damaged"])["2"]["watch"] is False, "and is remembered")

print("empty bin")
r = sift("empty-bin")
check(r.returncode == 0, "succeeds")
check(os.listdir(f"{DATA}/Sift-bin") == [], "bin emptied")
check(load(f"{STATE}/bin.json")["entries"] == [], "entries cleared")
check(os.path.isfile(f"{MUSIC}/MP3/Art/Alb/01.mp3") and os.path.isdir(f"{MUSIC}/FLAC"), "library untouched")
conf2 = {**conf, "bins": {MUSIC: f"{MUSIC}/FLAC", DATA: f"{DATA}/Sift-bin"}}
json.dump(conf2, open(f"{T}/conf.json", "w"))
r = sift("empty-bin", ok=False)
check(r.returncode != 0 and os.path.isdir(f"{MUSIC}/FLAC"), "refuses to empty a bin that is not named Sift-bin")

print("moves that go wrong")
json.dump(conf, open(f"{T}/conf.json", "w"))
tone(f"{DATA}/music-flac/Busy/Alb/01.flac", "flac")
tone(f"{MUSIC}/MP3/Busy/Alb/01.mp3", "libmp3lame")
open(f"{DATA}/music-flac/Busy/Alb/.fuse_hidden0001", "w").write("deleted but still open")
busy = {"id": 8, "artist": "Busy", "title": "Alb", "queue": "ready", "status": "retire",
        "allowed": ["keep_flac"], "_do": {"flac_dir": f"{DATA}/music-flac/Busy/Alb", "dest": f"{MUSIC}/FLAC/Busy/Alb",
        "mp3_dirs": [f"{MUSIC}/MP3/Busy/Alb"], "mp3_id": 18, "mbid": "mb-8", "hold": None, "foreign_ids": []}}
json.dump({"items": [busy]}, open(f"{STATE}/queue.json", "w"))
r = sift("resolve", "8", "keep_flac")
check(r.returncode == 0 and os.path.isfile(f"{MUSIC}/FLAC/Busy/Alb/01.flac"), "a .fuse_hidden leftover does not fail the move")
check(not os.path.exists(f"{MUSIC}/FLAC/Busy/Alb/.fuse_hidden0001"), "and is not copied into the library")

tone(f"{DATA}/music-flac/Stuck/Alb/01.flac", "flac")
tone(f"{DATA}/music-flac/Stuck/Alb/02.flac", "flac")
tone(f"{MUSIC}/MP3/Stuck/Alb/01.mp3", "libmp3lame")
os.chmod(f"{DATA}/music-flac/Stuck/Alb/02.flac", 0)
stuck = {**busy, "id": 9, "artist": "Stuck", "_do": {**busy["_do"], "flac_dir": f"{DATA}/music-flac/Stuck/Alb",
         "dest": f"{MUSIC}/FLAC/Stuck/Alb", "mp3_dirs": [f"{MUSIC}/MP3/Stuck/Alb"], "mp3_id": 19, "mbid": "mb-9"}}
json.dump({"items": [stuck]}, open(f"{STATE}/queue.json", "w"))
migrated_before = load(conf["migrated"], {})
r = sift("resolve", "9", "keep_flac", ok=False)
os.chmod(f"{DATA}/music-flac/Stuck/Alb/02.flac", 0o644)
check(r.returncode != 0, "a move that cannot finish fails")
check(sorted(os.listdir(f"{DATA}/music-flac/Stuck/Alb")) == ["01.flac", "02.flac"], "every file is back in the source")
check(not os.path.exists(f"{MUSIC}/FLAC/Stuck"), "nothing is left in the library")
check(os.path.isfile(f"{MUSIC}/MP3/Stuck/Alb/01.mp3") and load(conf["migrated"], {}) == migrated_before, "MP3 and ledger untouched")

print("track tools")
json.dump(conf, open(f"{T}/conf.json", "w"))
tone(f"{DATA}/music-flac/Tools/Alb/Tools - Alb - 01 - One.flac", "flac")
tone(f"{DATA}/music-flac/Tools/Alb/Tools - Alb - 02 - Three.flac", "flac")
tone(f"{DATA}/music-flac/Tools/Alb/Tools - Alb - 03 - Two.flac", "flac")
tone(f"{DATA}/music-flac/Tools/Alb/Tools - Alb - 04 - Two again.flac", "flac")
for n in (1, 2, 3):
    tone(f"{MUSIC}/MP3/Tools/Alb/0{n}.mp3", "libmp3lame")
import mutagen
d = f"{DATA}/music-flac/Tools/Alb"
names = sorted(os.listdir(d))
for n, name in enumerate(names, 1):
    m = mutagen.File(f"{d}/{name}", easy=True); m["tracknumber"] = str(n); m.save()
tool_item = {"id": 5, "artist": "Tools", "title": "Alb", "queue": "different", "status": "unconfirmed",
    "_status": "unconfirmed", "_reasons": ["1 MP3 track(s) not fingerprint-matched"],
    "allowed": ["keep_flac", "keep_mp3", "refetch", "watch"], "watch": True, "reorder": True,
    "pairs": [{"m": 0, "f": 0, "sim": .97, "same": True}, {"m": 1, "f": 2, "sim": .97, "same": True},
              {"m": 2, "f": 3, "sim": .6, "same": False}],
    "_do": {"flac_dir": d, "dest": f"{MUSIC}/FLAC/Tools/Alb", "mp3_dirs": [f"{MUSIC}/MP3/Tools/Alb"],
            "mp3_id": 15, "mbid": "mb-5", "hold": None, "foreign_ids": [77]},
    "_files": {"flac": [f"{d}/{x}" for x in names], "mp3": [f"{MUSIC}/MP3/Tools/Alb/0{n}.mp3" for n in (1, 2, 3)]}}
json.dump({"items": [tool_item]}, open(f"{STATE}/queue.json", "w"))
qi = lambda: load(f"{STATE}/queue.json")["items"][0]

r = sift("pair", "5", "2", "1")
item = qi()
check(r.returncode == 0 and item["pairs"][2] == {"m": 2, "f": 1, "sim": None, "same": True, "manual": True}, "pair by hand is recorded")
check(item["queue"] == "ready" and "set by hand" in " ".join(item["reasons"]), "an album confirmed by hand moves to Ready")
check(load(f"{STATE}/overrides.json")["5"]["pairs"] == [{"mp3": "03.mp3", "flac": names[1]}], "stored by filename")
r = sift("unpair", "5", "2")
check(r.returncode == 0 and qi()["queue"] == "different" and "5" not in load(f"{STATE}/overrides.json"), "unpair puts it back")

sift("pair", "5", "2", "1")
r = sift("reorder", "5", "0,2,1,3")
after = sorted(os.listdir(d))
check(r.returncode == 0 and after == ["Tools - Alb - 01 - One.flac", "Tools - Alb - 02 - Two.flac",
      "Tools - Alb - 03 - Three.flac", "Tools - Alb - 04 - Two again.flac"], "reorder renames files")
check(mutagen.File(f"{d}/Tools - Alb - 02 - Two.flac", easy=True)["tracknumber"] == ["2"], "and renumbers tags")
check(load(f"{STATE}/overrides.json")["5"]["pairs"][0]["flac"] == "Tools - Alb - 03 - Three.flac", "hand pairs follow the rename")
check(sift("reorder", "5", "0,0,1,2", ok=False).returncode != 0, "an order that repeats a track is refused")
re_entry = load(f"{STATE}/bin.json")["entries"][-1]
r = sift("undo", re_entry["id"])
check(r.returncode == 0 and sorted(os.listdir(d)) == names, "undo restores the names")
check(mutagen.File(f"{d}/{names[1]}", easy=True)["tracknumber"] == ["2"], "and the tags")
check(load(f"{STATE}/overrides.json")["5"]["pairs"][0]["flac"] == names[1], "and the hand pairs")

json.dump({"items": [tool_item]}, open(f"{STATE}/queue.json", "w"))
r = sift("bin-track", "5", "3")
bt = load(f"{STATE}/bin.json")["entries"][-1]
check(r.returncode == 0 and not os.path.exists(f"{d}/{names[3]}")
      and os.path.isfile(f"{DATA}/Sift-bin/{bt['id']}/music-flac/Tools/Alb/{names[3]}"), "a single track goes to the bin")
r = sift("undo", bt["id"])
check(r.returncode == 0 and os.path.isfile(f"{d}/{names[3]}"), "and comes back on undo")
check(sift("bin-track", "5", "9", ok=False).returncode != 0, "a track index past the end is refused")

json.dump({"items": [tool_item]}, open(f"{STATE}/queue.json", "w"))
r = sift("one-album", "5", "on")
check(r.returncode == 0 and load(f"{STATE}/overrides.json")["5"]["one_album"] is True, "one album is recorded")
json.dump({"items": [{**tool_item, "one_album": True}]}, open(f"{STATE}/queue.json", "w"))
open(API, "w").close()
r = sift("resolve", "5", "keep_mp3")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and ["flac", "PUT", "/album/monitor", {"albumIds": [77], "monitored": False}] in calls,
      "deciding a one-album folder unmonitors the entry that held its stray tracks")

shutil.rmtree(T)
print(f"\n{'all passed' if not failures else f'{failures} FAILED'}")
sys.exit(1 if failures else 0)
