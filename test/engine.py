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
    "check_mounts": False,                       # sandbox folders are not mount points
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
        {"id": 4, "artist": "Art4", "title": "Lone", "queue": "ready", "status": "no_mp3",
         "allowed": ["keep_flac", "bin_album", "refetch", "watch"], "watch": False,
         "_do": {"flac_dir": f"{DATA}/music-flac/Art4/Lone", "dest": f"{MUSIC}/FLAC/Art4/Lone",
                 "mp3_dirs": [], "mp3_id": None, "mbid": "mb-4", "hold": None}},
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
    tone(f"{DATA}/music-flac/Art4/Lone/01.flac", "flac")
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

print("binning an album with no MP3 behind it")
before4 = snapshot()
r = sift("resolve", "4", "bin_album")
check(r.returncode == 0, "succeeds")
check(not os.path.exists(f"{DATA}/music-flac/Art4/Lone"), "the FLAC leaves the queue folder")
check(not os.path.exists(f"{MUSIC}/FLAC/Art4/Lone"), "and nothing is put in the library")
calls = [json.loads(l) for l in open(API)]
check(["flac", "PUT", "/album/monitor", {"albumIds": [4], "monitored": False}] in calls,
      "unmonitored, so Soularr doesn't fetch it again")
check(load(conf["returned"])["4"]["decision"] == "sift_bin_album", "recorded in the returned ledger")
e4 = load(f"{STATE}/bin.json")["entries"][-1]
check(e4["decision"] == "bin_album", "the bin entry says what it was")
r = sift("undo", e4["id"])
check(r.returncode == 0 and snapshot() == before4, "undo puts it back")
check("4" not in load(conf["returned"]), "and the ledger entry goes with it")
write_queue()

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

print("re-fetch a chosen release")
write_queue()
q0 = load(f"{STATE}/queue.json")
q0["items"][0]["releases"] = [{"release": "rel-a"}, {"release": "rel-b"}]
json.dump(q0, open(f"{STATE}/queue.json", "w"))
tone(f"{DATA}/music-flac/Art/Alb/01.flac", "flac") if not os.path.exists(f"{DATA}/music-flac/Art/Alb/01.flac") else None
open(API, "w").close()
r = sift("resolve", "1", "refetch", "1")
calls = [json.loads(l) for l in open(API)]
put = [c for c in calls if c[1] == "PUT" and c[2] == "/album/1"]
check(r.returncode == 0 and put and [x["monitored"] for x in put[0][3]["releases"]] == [False, True]
      and put[0][3]["anyReleaseOk"] is False, "the chosen release is selected in Lidarr-FLAC")
check(sift("resolve", "1", "refetch", "5", ok=False).returncode != 0, "a release index past the list is refused")
open(API, "w").close()
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
calls = [json.loads(l) for l in open(API)]
check(any(c[1] == "PUT" and c[2] == "/album/1" and [x["monitored"] for x in c[3]["releases"]] == [True, False] for c in calls),
      "undo selects the old release again")
check(any(c[1] == "PUT" and c[2] == "/album/1" and c[3]["anyReleaseOk"] is True for c in calls),
      "and turns any-release-OK back on")

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

print("approving staged decisions")
write_queue()
n_before = len(load(f"{STATE}/bin.json")["entries"])
r = sift("apply-staged", "1:keep_flac,99:keep_mp3,2:keep_mp3")
check(r.returncode == 0, "succeeds when some go ahead")
check(os.path.isfile(f"{MUSIC}/FLAC/Art/Alb/01.flac") and not os.path.exists(f"{MUSIC}/FLAC-damaged/Art2"), "both albums carried out")
check("skipped [99] album 99: no longer in the queue" in r.stdout and "done [1] keep_flac" in r.stdout, "an album gone from the queue is skipped and said")
entries = load(f"{STATE}/bin.json")["entries"]
check(len(entries) == n_before + 2, "each gets its own bin entry")
check(sift("apply-staged", "1:watch_on", ok=False).returncode != 0, "only album decisions can be staged")
check(sift("apply-staged", "1:keep_flac;ls", ok=False).returncode != 0, "a malformed list is refused")
for e in reversed(entries[n_before:]):
    sift("undo", e["id"])
check(os.path.isfile(f"{DATA}/music-flac/Art/Alb/01.flac") and os.path.isdir(f"{MUSIC}/FLAC-damaged/Art2"), "and each undoes on its own")

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

print("measuring")
# stand-ins for the calibration: broadband noise as a genuine CD rip, and the same noise
# through a 128 kbps MP3 and back to FLAC, which is what a converted download is
os.environ.update({"SIFT_STATE": STATE, "SIFT_CONF": f"{T}/conf.json"})
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
json.dump(conf, open(f"{T}/conf.json", "w"))
import sift as S
S.fm.CACHE = f"{T}/cache.json"                     # never the real check cache
M = f"{T}/measure"
os.makedirs(M, exist_ok=True)
noise = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:r=44100:a=0.3"]
subprocess.run(noise + [f"{M}/real.flac"], check=True)
subprocess.run(noise + ["-af", "volume=-6dB", f"{M}/quiet.flac"], check=True)
subprocess.run(["ffmpeg", "-v", "error", "-i", f"{M}/real.flac", "-b:a", "128k", "-cutoff", "16000", f"{M}/lossy.mp3"], check=True)
subprocess.run(["ffmpeg", "-v", "error", "-i", f"{M}/lossy.mp3", f"{M}/fake.flac"], check=True)
real, fake, quiet = (S.measure(f"{M}/{n}.flac") for n in ("real", "fake", "quiet"))
check(real["cutoff"] > 21000, f"a genuine FLAC reaches the top ({real['cutoff']} Hz)")
check(fake["cutoff"] < S.SUSPECT_HZ, f"a FLAC made from an MP3 stops short ({fake['cutoff']} Hz)")
check(real["lufs"] is not None and abs(real["lufs"] - quiet["lufs"] - 6) < 0.5,
      f"loudness measured ({real['lufs']} and {quiet['lufs']} LUFS)")
check(S.fm.file_entry(f"{M}/fake.flac")["cutoff"] == fake["cutoff"], "and cached with the file")

tr = lambda c: {"name": "x", "cutoff": c}
sus = {"flac": {"tracks": [tr(16000), tr(16100), tr(22050)]}, "mp3": {"tracks": [tr(16000)]},
       "reasons": ["Every track matches"], "_reasons": ["Every track matches"]}
S.suspect(sus)
check(sus["suspect"] == {"low": 2, "of": 3, "hz": 16100, "mp3_hz": 16000} and "converted MP3" in sus["reasons"][0],
      "an album whose FLAC tracks mostly stop short is flagged")
ok_album = {"flac": {"tracks": [tr(16000), tr(22050), tr(22050)]}, "mp3": None, "reasons": [], "_reasons": []}
check(S.suspect(ok_album)["suspect"] is None, "one short track is not enough")
over = {**sus, "id": 40, "queue": "ready", "_status": "retire", "pairs": [{"m": 0, "f": 0, "sim": .9, "same": True}],
        "_files": {"flac": ["a.flac"], "mp3": ["a.mp3"]}}
check(S.apply_overrides(over, None)["queue"] == "suspect", "a suspect album never lands in Ready")

print("diagnosis")
def diag_item(mp3_secs, flac_secs, pairs, queue="lineup", status="keep_mp3", shared=False):
    t = lambda k, secs, side: {"name": f"{side}{k}", "title": f"T{k}", "secs": secs}
    return {"id": 50, "queue": queue, "_status": status, "_reasons": ["r"], "reasons": ["r"],
            "allowed": ["keep_mp3", "refetch", "watch"],
            "mp3": {"tracks": [t(k, x, "m") for k, x in enumerate(mp3_secs)]},
            "flac": {"tracks": [t(k, x, "f") for k, x in enumerate(flac_secs)]},
            "pairs": pairs, "_do": {"shared_ok": shared, "mp3_id": 1},
            "_files": {"flac": [f"f{k}" for k in range(len(flac_secs))], "mp3": [f"m{k}" for k in range(len(mp3_secs))]}}
P = lambda m, f, same=True: {"m": m, "f": f, "sim": .9 if same else .5, "same": same}
dg = S.apply_overrides(diag_item([100, 200], [100, 200], [P(0, 0), P(1, 1)], shared=True), None)
check(dg["diagnosis"]["kind"] == "shared" and dg["allowed"][0] == "keep_flac",
      "a shared MP3 folder whose every file matches opens Keep FLAC")
dg = S.apply_overrides(diag_item([100, 200], [100, 200], [P(0, 0), P(1, None, False)], shared=True), None)
check("keep_flac" not in dg["allowed"], "but not while a file in it is unmatched")
dg = S.apply_overrides(diag_item([100, 200, 300], [100, 200], [P(0, 0), P(1, 1), P(2, None, False)]), None)
check(dg["diagnosis"]["kind"] == "missing" and "T2" in dg["diagnosis"]["text"] and dg["diagnosis"]["suggest"] == "refetch",
      "a FLAC short of tracks names them and suggests a re-fetch")
dg = S.apply_overrides(diag_item([100, 200], [100, 260], [P(0, 0), P(1, 1)]), None)
check(dg["diagnosis"]["kind"] == "edits" and "+60 s" in dg["diagnosis"]["text"], "matching tracks of different lengths are called edits")
dg = S.apply_overrides(diag_item([100, 200, 300, 400], [100, 200, 300, 401], [P(0, 0), P(1, 1), P(2, 2), P(3, None, False)],
                                 queue="different", status="unconfirmed"), None)
check(dg["diagnosis"]["kind"] == "pair" and dg["diagnosis"]["suggest"] == "pair", "an unmatched track with a same-length spare suggests pairing")
dupe = diag_item([100, 200, 300], [100], [P(0, 0), P(1, None, False), P(2, None, False)], queue="dupes", status="dupe")
dupe["allowed"] = ["keep_flac", "keep_mp3"]
dg = S.apply_overrides(dupe, None)
check(dg["diagnosis"]["kind"] == "missing" and dg["diagnosis"]["suggest"] == "keep_mp3",
      "a duplicate whose FLAC is missing tracks suggests keeping the MP3, not a re-fetch it can't have")
other = diag_item([100, 200], [150, 250], [P(0, None, False), P(1, None, False)], queue="dupes", status="dupe")
other["allowed"] = ["keep_flac", "keep_mp3"]
check(S.apply_overrides(other, None)["diagnosis"]["suggest"] is None, "and suggests nothing when it can't take the suggestion")

print("what an album with no MP3 may be decided")
lone_plan = {"status": "no_mp3", "notes": [], "flac_files": [], "mp3_files": [],
             "flac_dir": f"{DATA}/music-flac/Art4/Lone", "dest": f"{MUSIC}/FLAC/Art4/Lone",
             "mbid": "mb-4", "flac_id": 4, "artist": "Art4", "title": "Lone", "monitored": False}
S.CONF["flac_db"] = f"file:{T}/none.db?mode=ro"        # never the real Lidarr database
lone = S.item_from_plan(lone_plan, None)
S._releases.clear()                                    # the release test below reads its own
check(lone["queue"] == "ready" and lone["allowed"] == ["keep_flac", "bin_album", "refetch", "watch"],
      "Put in the bin stands in for the Keep MP3 it can't have")

print("shared MP3 folder, Keep FLAC")
tone(f"{DATA}/music-flac/Shared2/Alb/01.flac", "flac")
tone(f"{MUSIC}/MP3/Shared2/Alb/01.mp3", "libmp3lame")
sh = {"id": 51, "artist": "Shared2", "title": "Alb", "queue": "lineup", "status": "keep_mp3",
      "allowed": ["keep_flac", "keep_mp3"], "_do": {"flac_dir": f"{DATA}/music-flac/Shared2/Alb",
      "dest": f"{MUSIC}/FLAC/Shared2/Alb", "mp3_dirs": [f"{MUSIC}/MP3/Shared2/Alb"], "mp3_id": 61, "mbid": "mb-51",
      "hold": None, "foreign_ids": [], "shared_ok": True, "mp3_foreign_ids": [62]}}
json.dump({"items": [sh]}, open(f"{STATE}/queue.json", "w"))
open(API, "w").close()
r = sift("resolve", "51", "keep_flac")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and ["mp3", "PUT", "/album/monitor", {"albumIds": [62], "monitored": False}] in calls,
      "Keep FLAC also unmonitors the MP3 entry that held some of the folder")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])

print("where it came from")
import sqlite3
tdb = f"{T}/transfers.db"
c = sqlite3.connect(tdb)
c.executescript("""create table Transfers (Username, Direction, Filename, State, EndedAt);
insert into Transfers values ('baduser', 'Download', 'music\\Zed - Blue (2001) [FLAC]\\01 One.flac', 48, '2026-09-01');
insert into Transfers values ('other', 'Download', 'share\\Zed\\Blue\\01 One.flac', 80, '2026-09-02');
insert into Transfers values ('gooduser', 'Download', 'share\\Quill\\Green\\01.flac', 48, '2026-09-03');""")
c.commit()
cfg = f"{T}/soularr.ini"
open(cfg, "w").write("[Search Settings]\nignored_users = someone\nsearch_type = x\n")
S.CONF.update(transfers_db=f"file:{tdb}?mode=ro", soularr_config=cfg)
src = S.add_sources([{"id": 1, "artist": "Zed", "title": "Blue", "queue": "suspect", "flac": {"tracks": []}},
                     {"id": 2, "artist": "Quill", "title": "Green", "queue": "ready", "flac": {"tracks": []}}])
check(src[0]["source"] == {"user": "baduser", "albums": 1, "bad": 1, "blocked": False}, "a finished download names its user, not a cancelled one")
check(src[1]["source"]["user"] == "gooduser", "found by the artist folder above the album too")
sq, w = S.fm.squash, S.words
remix = "Perel - Matrix (Sofia Kourtesis Remix)"
check(not S.source_match(sq("Sofia Kourtesis"), sq("Sofia Kourtesis"), sq(remix), w(remix), w("Sofia Kourtesis"))
      and S.source_match(sq("Sofia Kourtesis"), sq("Sofia Kourtesis"), sq("Sofia Kourtesis - Sofia Kourtesis (BARN058) FLAC"), w(""), w("Sofia Kourtesis")),
      "a self-titled album needs the name twice, so a remix folder isn't its source")
check(not S.source_match(sq("Angel 1"), sq("Fy"), sq("Angel 1 Fyodor Live"), w("Fyodor Live"), w("Fy"))
      and S.source_match(sq("Angel 1"), sq("Fy"), sq("Angel 1 - Fy [FLAC]"), w("Angel 1 - Fy [FLAC]"), w("Fy")),
      "a short title must be a whole word in the folder's name")
json.dump(conf, open(f"{T}/conf.json", "w"))
json.dump({**conf, "soularr_config": cfg}, open(f"{T}/conf.json", "w"))
json.dump({"items": [{"id": 1, "artist": "Zed", "title": "Blue", "queue": "suspect", "source": src[0]["source"], "_do": {}}]},
          open(f"{STATE}/queue.json", "w"))
r = sift("block-user", "1")
check(r.returncode == 0 and "ignored_users = someone,baduser\n" in open(cfg).read() and "search_type = x" in open(cfg).read(),
      "Block adds them to Soularr's ignored users, leaving the rest")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
check("ignored_users = someone\n" in open(cfg).read(), "and undo takes them off again")
json.dump(conf, open(f"{T}/conf.json", "w"))

print("release details")
import sqlite3
db = f"{T}/lidarr.db"
c = sqlite3.connect(db)
c.executescript("""
create table Albums (Id, ForeignAlbumId, ReleaseDate, AlbumType);
create table AlbumReleases (Id, AlbumId, ForeignReleaseId, Title, Disambiguation, ReleaseDate, Label, Country, Media, TrackCount, Status, Monitored);
create table Tracks (Id, AlbumReleaseId, TrackFileId);
insert into Albums values (7, 'rg-1', '1971-05-10 00:00:00Z', 'Album');
insert into AlbumReleases values (1, 7, 'rel-selected', 'Alb', '', '1971-05-10', '["Cotillion"]', '["United States"]', '[{"format":"Vinyl"}]', 9, 'Official', 1);
insert into AlbumReleases values (2, 7, 'rel-imported', 'Alb', 'remaster', '2012-01-01', '["Rhino"]', '["Europe"]', '[{"format":"CD"}]', 9, 'Official', 0);
insert into Tracks values (1, 2, 55);
""")
c.commit()
S.CONF["flac_db"] = f"file:{db}?mode=ro"
d = S.details("flac", 7, [f"{MUSIC}/MP3/Art/Alb/01.mp3"])
check(d["release"] == "rel-imported" and d["date"] == "2012-01-01" and d["label"] == "Rhino"
      and d["title"] == "Alb (remaster)" and d["original"] == "1971-05-10" and d["format"] == "CD",
      "the release the files were imported as, over the selected one")
check(isinstance(d["tags"], dict), "and the file's tags")

print("library duplicates")
tone(f"{MUSIC}/FLAC/Dupe Band/Twice/01.flac", "flac")
tone(f"{MUSIC}/FLAC/Dupe Band/Twice/02.flac", "flac")
tone(f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/01.mp3", "libmp3lame")
tone(f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/02.mp3", "libmp3lame")
tone(f"{MUSIC}/FLAC/Solo/Only FLAC/01.flac", "flac")
found = [f for f in S.find_dupes(set()) if f["artist"] == "Dupe Band"]
check(len(found) == 1 and found[0]["mp3_dirs"] == [f"{MUSIC}/MP3/The Dupe Band/Twice (1999)"],
      "a FLAC library album with an MP3 folder of the same name is found")
check(not any(f["artist"] == "Solo" for f in S.find_dupes(set())), "an album only in FLAC is not")
check(not any(f["artist"] == "Dupe Band" for f in S.find_dupes({f"{MUSIC}/FLAC/Dupe Band/Twice"})),
      "a folder the review queue already covers is left to it")
# the two Lidarrs, as far as duplicates read them
import sqlite3
for name, sql in (("mp3", "create table Albums (Id, Title); insert into Albums values (31, 'Twice'), (32, 'Something Else');"),
                  ("flac", """create table Albums (Id, Title, ArtistMetadataId, Monitored); create table ArtistMetadata (Id, Name);
                              insert into ArtistMetadata values (1, 'Dupe Band'); insert into Albums values (4400, 'Twice', 1, 0);""")):
    c = sqlite3.connect(f"{T}/dupe-{name}.db"); c.executescript(sql); c.commit(); c.close()
    S.CONF[f"{name}_db"] = f"file:{T}/dupe-{name}.db?mode=ro"
S._mp3_titles = S._flac_titles = None
mp3s = [f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/01.mp3", f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/02.mp3"]
dupe = S.item_from_dupe(found[0], {p: 31 for p in mp3s})
check(dupe["queue"] == "dupes" and dupe["id"] >= S.DUPE_BASE and set(dupe["allowed"]) == {"keep_flac", "keep_mp3", "refetch"},
      "it becomes a Library duplicates item")
check(dupe["_do"]["mp3_id"] == 31 and len(dupe["pairs"]) == 2, "with the MP3 Lidarr album and track pairs")
check(dupe["_do"]["flac_album"] == 4400 and dupe["lidarr_flac"] == {"monitored": False}, "and the Lidarr-FLAC album of the same name")
check(S.item_from_dupe(found[0], {p: 32 for p in mp3s})["_do"]["mp3_id"] is None,
      "an MP3 Lidarr album of another name is not taken for it")
S._flac_titles = None
S.CONF["flac_db"] = f"file:{T}/missing.db?mode=ro"
lonely = S.item_from_dupe(found[0], {})
check(lonely["_do"]["flac_album"] is None and lonely["lidarr_flac"] is None and "refetch" in lonely["allowed"],
      "without a Lidarr-FLAC album, Get a better FLAC is still offered")
json.dump({"items": [dupe]}, open(f"{STATE}/queue.json", "w"))
before_dupe = snapshot()
open(API, "w").close()
r = sift("resolve", str(dupe["id"]), "keep_flac")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and os.path.isfile(f"{MUSIC}/FLAC/Dupe Band/Twice/01.flac")
      and not os.path.exists(f"{MUSIC}/MP3/The Dupe Band"), "Keep FLAC bins the MP3 and leaves the FLAC")
check(["mp3", "PUT", "/album/monitor", {"albumIds": [31], "monitored": False}] in calls
      and not any(c[0] == "flac" and c[2].startswith("/album") for c in calls), "and unmonitors only the MP3")
de = load(f"{STATE}/bin.json")["entries"][-1]
r = sift("undo", de["id"])
check(r.returncode == 0 and snapshot() == before_dupe, "undo puts the MP3 back")
json.dump({"items": [dupe]}, open(f"{STATE}/queue.json", "w"))
r = sift("resolve", str(dupe["id"]), "keep_mp3")
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/FLAC/Dupe Band")
      and os.path.isfile(f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/01.mp3"), "Keep MP3 bins the FLAC")
check(os.path.isdir(f"{MUSIC}/FLAC"), "the FLAC library root stays")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
check(snapshot() == before_dupe, "and undo restores it")
json.dump({"items": [dupe]}, open(f"{STATE}/queue.json", "w"))
open(API, "w").close()
r = sift("resolve", str(dupe["id"]), "refetch")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/FLAC/Dupe Band")
      and os.path.isfile(f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/01.mp3"), "Get a better FLAC bins the FLAC and keeps the MP3")
check(["flac", "PUT", "/album/monitor", {"albumIds": [4400], "monitored": True}] in calls, "and monitors the album in Lidarr-FLAC")
open(API, "w").close()
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
calls = [json.loads(l) for l in open(API)]
check(snapshot() == before_dupe and any(c[0] == "flac" and c[2] == "/album/monitor" for c in calls), "undo restores the FLAC and the monitoring")
json.dump({"items": [lonely]}, open(f"{STATE}/queue.json", "w"))
open(API, "w").close()
r = sift("resolve", str(lonely["id"]), "refetch")
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/FLAC/Dupe Band")
      and not any("/album" in c for c in open(API)), "without a Lidarr-FLAC album it only bins the FLAC")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])

print("several albums at once")
json.dump(conf, open(f"{T}/conf.json", "w"))
write_queue()
for i in (1, 2):
    if not os.path.exists(f"{DATA}/music-flac/Art/Alb/0{i}.flac"):
        tone(f"{DATA}/music-flac/Art/Alb/0{i}.flac", "flac")
r = sift("resolve-many", "keep_mp3", "1,3,2")
entries = load(f"{STATE}/bin.json")["entries"]
check(r.returncode == 0 and {e["album_id"] for e in entries[-3:]} == {1, 2, 3}, "each album gets its own bin entry")
write_queue()
r = sift("resolve-many", "keep_flac", "1,3")
hist = load(f"{STATE}/history.json", {})
check(r.returncode == 0 and any(f["album_id"] == 3 for f in hist.get("failed", [])),
      "an album that can't take the decision is recorded as failed")
check(sift("resolve-many", "rm", "1", ok=False).returncode != 0, "an unknown decision is refused")
check(sift("resolve-many", "keep_mp3", "1;2", ok=False).returncode != 0, "ids must be integers")
last = load(f"{STATE}/bin.json")["entries"][-1]
sift("undo", last["id"])
check(any(u["id"] == last["id"] for u in load(f"{STATE}/history.json")["undone"]), "undo is kept in the history")
n_before = len(load(f"{STATE}/bin.json")["entries"])
sift("empty-bin")
em = load(f"{STATE}/history.json")["emptied"][-1]
check(len(em["entries"]) == n_before and em["bytes"] > 0 and "ops" not in em["entries"][0],
      "emptying records what went and how much, without paths")

print("jot")
import http.server, threading, hmac as _hmac, hashlib as _hashlib, base64 as _b64
got = []


class Jot(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        got.append((self.headers["Cookie"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
        self.send_response(201); self.end_headers(); self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Jot)
threading.Thread(target=srv.serve_forever, daemon=True).start()
json.dump({"secret": "abc123"}, open(f"{T}/jotauth.json", "w"))
S.CONF.update(jot_url=f"http://127.0.0.1:{srv.server_port}/api/jot", jot_auth=f"{T}/jotauth.json")
S.NOTIFY = f"{T}/notify.json"
q = lambda i, queue: {"id": i, "artist": f"A{i}", "title": "T", "queue": queue}
S.notify([q(1, "ready"), q(2, "lineup")])
check(not got and load(S.NOTIFY)["told"] == [1, 2], "the first check only records what is already waiting")
S.notify([q(1, "ready"), q(2, "lineup"), q(3, "ready"), q(4, "ready"), q(5, "damaged"), q(6, "arriving")])
check(len(got) == 1 and got[0][1]["subject"] == "Sift: 2 ready, 1 damaged", f"new albums are jotted ({got and got[0][1]['subject']})")
payload, mac = got[0][0].split("=", 1)[1].split(".")
want = _b64.urlsafe_b64encode(_hmac.new(b"abc123", payload.encode(), _hashlib.sha256).digest()).rstrip(b"=").decode()
check(got[0][0].startswith("mdedit_sid=") and mac == want, "with a session cookie signed as JotScribe signs one")
S.notify([q(1, "ready"), q(7, "ready")])
check(len(got) == 1, "at most once a day")
st = load(S.NOTIFY); st["sent"] = "2000-01-01T00:00:00"; json.dump(st, open(S.NOTIFY, "w"))
S.notify([q(1, "ready"), q(2, "lineup"), q(3, "ready"), q(4, "ready"), q(5, "damaged")])
check(len(got) == 1, "and only when something new has arrived")
S.notify([q(1, "ready"), q(7, "ready")])
check(len(got) == 2 and got[1][1]["subject"] == "Sift: 1 ready", "the next day, the next arrival is told")
print("digest")
S.HISTORY, S.BIN, S.SETTINGS = f"{T}/h.json", f"{T}/b.json", f"{T}/settings.json"
json.dump({"entries": [{"id": "rf", "at": "2026-09-01T10:00:00", "decision": "refetch", "album_id": 8, "bytes": 0},
                       {"id": "old", "at": "2000-01-01T10:00:00", "decision": "keep_flac", "album_id": 9, "bytes": 3e9}]},
          open(S.BIN, "w"))
json.dump({"retention_days": 30}, open(S.SETTINGS, "w"))
st = load(S.NOTIFY); st["sent"] = "2000-01-01T00:00:00"; json.dump(st, open(S.NOTIFY, "w"))
back = {**q(8, "ready"), "first_seen": "2026-09-10T10:00:00"}
S.notify([q(1, "ready"), q(7, "ready"), back])
body = got[-1][1]["body"]
check("A8 — T came back better: now Ready" in body, "a re-fetched album that came back is reported, with how it fared")
check("Bin: 3.0 GB is over 30 days old." in body, "and how much of the bin is past the retention setting")
st = load(S.NOTIFY); st["sent"] = "2000-01-01T00:00:00"; json.dump(st, open(S.NOTIFY, "w"))
S.notify([q(1, "ready"), q(7, "ready"), back, q(10, "suspect")])
check(got[-1][1]["subject"] == "Sift: 1 suspect" and "came back" not in got[-1][1]["body"], "a re-fetch is only reported once")
srv.shutdown()

print("library health")
json.dump(conf, open(f"{T}/conf.json", "w"))
S.CONF.update(conf)
S.HEALTH = f"{STATE}/health.json"
os.makedirs(f"{MUSIC}/FLAC/Well/Fine", exist_ok=True); shutil.copy(f"{M}/real.flac", f"{MUSIC}/FLAC/Well/Fine/01.flac")
os.makedirs(f"{MUSIC}/FLAC/Fake/Copy", exist_ok=True)
for n in (1, 2):
    shutil.copy(f"{M}/fake.flac", f"{MUSIC}/FLAC/Fake/Copy/0{n}.flac")
for x in ("Art", "Art3", "Busy", "Stuck", "Tools", "Dupe Band", "Solo"):
    shutil.rmtree(f"{MUSIC}/FLAC/{x}", ignore_errors=True)
S.health(5)
hr = load(S.HEALTH)["albums"]
check(hr[f"{MUSIC}/FLAC/Fake/Copy"]["low"] == 2 and hr[f"{MUSIC}/FLAC/Well/Fine"]["low"] == 0, "the nightly check measures every album folder")
hi = S.health_items(set())
check([i["title"] for i in hi] == ["Copy"] and hi[0]["queue"] == "health" and hi[0]["suspect"], "only the suspect one comes up in Library health")
check(S.health_items({f"{MUSIC}/FLAC/Fake/Copy"}) == [], "not if another queue already covers the folder")
json.dump({"items": [hi[0]]}, open(f"{STATE}/queue.json", "w"))
r = sift("resolve", str(hi[0]["id"]), "dismiss")
check(r.returncode == 0 and S.health_items(set()) == [], "Looks fine dismisses it")
open(f"{MUSIC}/FLAC/Fake/Copy/02.flac", "ab").write(b"\0")
check(S.health_items(set()) == [], "a changed folder waits for the next night")
S.health(5)
check(len(S.health_items(set())) == 1, "and comes back if it's still bad")
h2 = S.health_items(set())[0]
json.dump({"items": [h2]}, open(f"{STATE}/queue.json", "w"))
r = sift("resolve", str(h2["id"]), "bin_album")
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/FLAC/Fake") and os.path.isdir(f"{MUSIC}/FLAC"), "Put in the bin bins the album")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
check(os.path.isfile(f"{MUSIC}/FLAC/Fake/Copy/01.flac"), "and undo brings it back")
migrated0 = load(conf["migrated"], {})
json.dump({**migrated0, "77": {"artist": "Fake", "title": "Copy", "dest": f"{MUSIC}/FLAC/Fake/Copy", "status": "retire"}},
          open(conf["migrated"], "w"))
S._flac_titles = None
h3 = S.health_items(set())[0]
check("refetch" in h3["allowed"] and h3["_do"]["flac_album"] == 77 and h3["lidarr_flac"] is not None,
      "a library album the migration moved can Get a better FLAC, through its Lidarr-FLAC id")
json.dump({"items": [h3]}, open(f"{STATE}/queue.json", "w"))
open(API, "w").close()
r = sift("resolve", str(h3["id"]), "refetch")
calls = [json.loads(l) for l in open(API)]
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/FLAC/Fake") and "77" not in load(conf["migrated"])
      and ["flac", "PUT", "/album/monitor", {"albumIds": [77], "monitored": True}] in calls,
      "which bins it, forgets the migration and monitors the album again")
sift("undo", load(f"{STATE}/bin.json")["entries"][-1]["id"])
check(os.path.isfile(f"{MUSIC}/FLAC/Fake/Copy/01.flac") and "77" in load(conf["migrated"]), "and undo restores both")
json.dump(migrated0, open(conf["migrated"], "w"))
shutil.rmtree(f"{MUSIC}/FLAC/Fake"); shutil.rmtree(f"{MUSIC}/FLAC/Well")

print("empty only the old part of the bin")
json.dump(conf, open(f"{T}/conf.json", "w"))
os.makedirs(f"{MUSIC}/Sift-bin/oldentry/MP3/X", exist_ok=True); open(f"{MUSIC}/Sift-bin/oldentry/MP3/X/a", "w").write("x")
os.makedirs(f"{MUSIC}/Sift-bin/newentry/MP3/Y", exist_ok=True); open(f"{MUSIC}/Sift-bin/newentry/MP3/Y/a", "w").write("x")
json.dump({"entries": [{"id": "oldentry", "at": "2026-01-01T00:00:00", "decision": "keep_flac", "label": "Old", "bytes": 5, "ops": []},
                       {"id": "newentry", "at": S.now(), "decision": "keep_flac", "label": "New", "bytes": 7, "ops": []}]},
          open(f"{STATE}/bin.json", "w"))
r = sift("empty-bin", "30")
check(r.returncode == 0 and not os.path.exists(f"{MUSIC}/Sift-bin/oldentry") and os.path.isfile(f"{MUSIC}/Sift-bin/newentry/MP3/Y/a"),
      "entries older than the setting go, newer ones stay")
check([e["id"] for e in load(f"{STATE}/bin.json")["entries"]] == ["newentry"] and load(f"{STATE}/history.json")["emptied"][-1]["bytes"] == 5,
      "and only they are recorded as emptied")
check(sift("empty-bin", "0", ok=False).returncode != 0, "zero days is refused")

print("unmounted drives")
json.dump({"entries": []}, open(f"{STATE}/bin.json", "w"))
tone(f"{DATA}/music-flac/Mnt/Alb/01.flac", "flac")
mnt = {**busy, "id": 20, "artist": "Mnt", "_do": {**busy["_do"], "flac_dir": f"{DATA}/music-flac/Mnt/Alb",
       "dest": f"{MUSIC}/FLAC/Mnt/Alb", "mp3_dirs": [], "mp3_id": None, "mbid": "mb-20"}}
json.dump({"items": [mnt]}, open(f"{STATE}/queue.json", "w"))
json.dump({**conf, "check_mounts": True}, open(f"{T}/conf.json", "w"))    # sandbox drives are never mount points
migrated_before = load(conf["migrated"], {})
r = sift("resolve", "20", "keep_flac", ok=False)
check(r.returncode != 0 and "not mounted" in r.stdout + r.stderr, "a move onto a drive that isn't mounted is refused")
check(os.path.isfile(f"{DATA}/music-flac/Mnt/Alb/01.flac") and not os.path.exists(f"{MUSIC}/FLAC/Mnt")
      and load(conf["migrated"], {}) == migrated_before, "and nothing moved or changed")
json.dump({"entries": [{"id": "keepme", "at": S.now(), "decision": "keep_flac", "label": "K", "ops": []}]}, open(f"{STATE}/bin.json", "w"))
r = sift("empty-bin", ok=False)
check(r.returncode != 0 and len(load(f"{STATE}/bin.json")["entries"]) == 1, "emptying the bin refuses too, and forgets nothing")
json.dump(conf, open(f"{T}/conf.json", "w"))

print("a decision cut off partway")
# what a restart in the middle of Keep FLAC's rsync leaves: one track landed, one still in the source
json.dump({"entries": []}, open(f"{STATE}/bin.json", "w"))
os.makedirs(f"{MUSIC}/FLAC/Mnt/Alb", exist_ok=True)
shutil.move(f"{DATA}/music-flac/Mnt/Alb/01.flac", f"{MUSIC}/FLAC/Mnt/Alb/01.flac")
tone(f"{DATA}/music-flac/Mnt/Alb/02.flac", "flac")
led = load(conf["migrated"], {}); led["20"] = {"status": "sift_keep_flac", "started": S.now()}; json.dump(led, open(conf["migrated"], "w"))
os.makedirs(f"{STATE}/pending", exist_ok=True)
json.dump({"id": "20260917-000000-cutoff", "at": S.now(), "decision": "keep_flac", "album_id": 20, "label": "Mnt — Alb",
           "ops": [{"op": "ledger", "file": "migrated", "key": "20", "before": None},
                   {"op": "move", "from": f"{DATA}/music-flac/Mnt/Alb", "to": f"{MUSIC}/FLAC/Mnt/Alb", "pending": True}]},
          open(f"{STATE}/pending/20260917-000000-cutoff.json", "w"))
sift("undo", "no-such-entry", ok=False)                                   # any command that takes the lock
entries = load(f"{STATE}/bin.json")["entries"]
check([e["id"] for e in entries] == ["20260917-000000-cutoff"] and entries[0]["interrupted"]
      and not os.listdir(f"{STATE}/pending"), "the next command puts it in the bin, marked interrupted")
r = sift("undo", "20260917-000000-cutoff")
check(r.returncode == 0 and sorted(os.listdir(f"{DATA}/music-flac/Mnt/Alb")) == ["01.flac", "02.flac"]
      and not os.path.exists(f"{MUSIC}/FLAC/Mnt") and "20" not in load(conf["migrated"], {}),
      "and undo merges both halves back and clears the ledger")
check(not os.path.exists(f"{STATE}/pending") or not os.listdir(f"{STATE}/pending"), "a finished decision leaves no journal")

print("undo in the wrong order")
json.dump({"entries": []}, open(f"{STATE}/bin.json", "w"))
mnt2 = {**mnt, "allowed": ["keep_mp3"], "reorder": True, "_files": {"flac": [f"{DATA}/music-flac/Mnt/Alb/01.flac",
        f"{DATA}/music-flac/Mnt/Alb/02.flac"], "mp3": []}}
json.dump({"items": [mnt2]}, open(f"{STATE}/queue.json", "w"))
sift("bin-track", "20", "1")
json.dump({"items": [mnt2]}, open(f"{STATE}/queue.json", "w"))
sift("resolve", "20", "keep_mp3")
first, second = load(f"{STATE}/bin.json")["entries"]
r = sift("undo", first["id"], ok=False)
check(r.returncode != 0 and "first" in r.stdout + r.stderr, "undoing an older decision while a newer one on the album is in the bin is refused")
check(len(load(f"{STATE}/bin.json")["entries"]) == 2 and not os.path.exists(f"{DATA}/music-flac/Mnt"), "and nothing changed")
check(sift("undo", second["id"]).returncode == 0 and sift("undo", first["id"]).returncode == 0
      and sorted(os.listdir(f"{DATA}/music-flac/Mnt/Alb")) == ["01.flac", "02.flac"], "newest first, both undo cleanly")

print("renames that can't finish")
d = f"{DATA}/music-flac/Mnt/Alb"
changes = [{"from": "01.flac", "to": "02.flac", "tag": ["2"]}, {"from": "02.flac", "to": "01.flac", "tag": ["1"]},
           {"from": "03.flac", "to": "04.flac", "tag": ["4"]}]
try:
    S.retag(d, changes)
    raised = False
except RuntimeError:
    raised = True
check(raised and sorted(os.listdir(d)) == ["01.flac", "02.flac"], "a missing track is found before anything is renamed")
real_rename, calls = os.rename, []
def flaky(a, b):                                                         # the third rename fails
    calls.append(a)
    if len(calls) == 3:
        raise OSError("disk went away")
    real_rename(a, b)
os.rename = flaky
try:
    S.retag(d, changes[:2])
except OSError:
    pass
os.rename = real_rename
check(len(calls) >= 3 and sorted(os.listdir(d)) == ["01.flac", "02.flac"], "a rename that fails partway puts the others back")

print("blocked from two albums")
cfg2 = f"{T}/soularr2.ini"
open(cfg2, "w").write("[Search Settings]\nignored_users = \n")
json.dump({**conf, "soularr_config": cfg2}, open(f"{T}/conf.json", "w"))
json.dump({"entries": []}, open(f"{STATE}/bin.json", "w"))
for n in (1, 2):
    json.dump({"items": [{"id": n, "artist": "Zed", "title": f"T{n}", "queue": "suspect", "_do": {},
                          "source": {"user": "twice"}}]}, open(f"{STATE}/queue.json", "w"))
    sift("block-user", str(n))
e1, e2 = load(f"{STATE}/bin.json")["entries"]
sift("undo", e1["id"])
check("twice" in open(cfg2).read(), "undoing one block leaves the user blocked while the other still stands")
sift("undo", e2["id"])
check("twice" not in open(cfg2).read(), "and undoing the other unblocks them")
json.dump(conf, open(f"{T}/conf.json", "w"))

print("emptying that fails partway")
os.makedirs(f"{MUSIC}/Sift-bin/aaa/X", exist_ok=True); open(f"{MUSIC}/Sift-bin/aaa/X/f", "w").write("x")
os.makedirs(f"{MUSIC}/Sift-bin/bbb/Y", exist_ok=True); open(f"{MUSIC}/Sift-bin/bbb/Y/f", "w").write("x")
os.symlink(f"{T}/precious", f"{MUSIC}/Sift-bin/ccc"); os.makedirs(f"{T}/precious", exist_ok=True); open(f"{T}/precious/keep", "w").write("x")
json.dump({"entries": [{"id": i, "at": "2026-01-01T00:00:00", "decision": "keep_flac", "label": i, "bytes": 1, "ops": []}
                       for i in ("aaa", "bbb", "ccc")]}, open(f"{STATE}/bin.json", "w"))
os.chmod(f"{MUSIC}/Sift-bin/bbb/Y", 0o555)                               # its file can't be deleted
r = sift("empty-bin", ok=False)
os.chmod(f"{MUSIC}/Sift-bin/bbb/Y", 0o755)
check(r.returncode != 0 and [e["id"] for e in load(f"{STATE}/bin.json")["entries"]] == ["bbb", "ccc"]
      and not os.path.exists(f"{MUSIC}/Sift-bin/aaa"), "a failed delete stops there, and bin.json lists exactly what is left")
r = sift("empty-bin")
check(r.returncode == 0 and os.path.isfile(f"{T}/precious/keep") and not os.path.lexists(f"{MUSIC}/Sift-bin/ccc"),
      "a symlink in the bin is removed, never followed")

print("covers")
from PIL import Image
big = f"{T}/big.jpg"
Image.new("RGB", (3000, 3000), "red").save(big)
S.shrink(big)
check(max(Image.open(big).size) == S.COVER_PX, "a big cover is shrunk to phone size")

print("health keeps a dismissal made while it runs")
json.dump({"albums": {}, "dismissed": {"/x": [1, 2, 3]}}, open(S.HEALTH, "w"))
S.save_health({"/y": {"sig": [1]}})
hj = load(S.HEALTH)
check(hj["dismissed"] == {"/x": [1, 2, 3]} and "/y" in hj["albums"], "results merge into health.json as it is on disk")

shutil.rmtree(T)
print(f"\n{'all passed' if not failures else f'{failures} FAILED'}")
sys.exit(1 if failures else 0)
