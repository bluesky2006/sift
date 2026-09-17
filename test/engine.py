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
dupe = S.item_from_dupe(found[0], {f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/01.mp3": 31,
                                   f"{MUSIC}/MP3/The Dupe Band/Twice (1999)/02.mp3": 31})
check(dupe["queue"] == "dupes" and dupe["id"] >= S.DUPE_BASE and set(dupe["allowed"]) == {"keep_flac", "keep_mp3"},
      "it becomes a Library duplicates item")
check(dupe["_do"]["mp3_id"] == 31 and len(dupe["pairs"]) == 2, "with the MP3 Lidarr album and track pairs")
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
check(len(got) == 1 and got[0][1]["subject"] == "Sift: 2 new albums ready, 1 to review", f"new albums are jotted ({got and got[0][1]['subject']})")
payload, mac = got[0][0].split("=", 1)[1].split(".")
want = _b64.urlsafe_b64encode(_hmac.new(b"abc123", payload.encode(), _hashlib.sha256).digest()).rstrip(b"=").decode()
check(got[0][0].startswith("mdedit_sid=") and mac == want, "with a session cookie signed as JotScribe signs one")
S.notify([q(1, "ready"), q(7, "ready")])
check(len(got) == 1, "at most once a day")
st = load(S.NOTIFY); st["sent"] = "2000-01-01T00:00:00"; json.dump(st, open(S.NOTIFY, "w"))
S.notify([q(1, "ready"), q(2, "lineup"), q(3, "ready"), q(4, "ready"), q(5, "damaged")])
check(len(got) == 1, "and only when something new has arrived")
S.notify([q(1, "ready"), q(7, "ready")])
check(len(got) == 2 and got[1][1]["subject"] == "Sift: 1 new album ready", "the next day, the next arrival is told")
srv.shutdown()

shutil.rmtree(T)
print(f"\n{'all passed' if not failures else f'{failures} FAILED'}")
sys.exit(1 if failures else 0)
