# Sift

A review queue for Soularr's FLACs, at **http://100.70.110.7:8305**. The design is in
`~/notes/sift-review-plan.md`.

Every FLAC album in Lidarr-FLAC's library (`/mnt/roon-data/music-flac`) is checked against
the MP3 you already have and sorted into a queue:

| Queue | Meaning |
|---|---|
| Ready | Exact match: every FLAC file passes `flac -t`, every MP3 track matches a FLAC track by fingerprint, and the FLAC isn't suspect |
| Suspect FLAC | Most FLAC tracks stop below 20.5 kHz, as a FLAC made from an MP3 does (`SUSPECT_HZ` in `bin/sift.py`) |
| Different or unconfirmed version | Some MP3 tracks have no fingerprint match in the FLAC |
| Doesn't line up | Fewer tracks, a noticeably different length, or an MP3 folder shared with another album |
| Damaged FLAC | FLAC files fail `flac -t`, including the 20 albums held in `/mnt/roon-music/FLAC-damaged` |
| Needs a look | FLAC folder holds another album's audio, spans folders, or the destination already exists |
| Library duplicates | An album in both `/mnt/roon-music/FLAC` and `/mnt/roon-music/MP3`, matched by folder name |
| Arriving | Imported in the last 3 hours; checked next time |

Nothing moves until you decide in the app. Nothing is deleted until you empty the bin.

## Pieces

- `server.js`: the web app (Node, no dependencies). Own password in `auth.json`, set on the
  first visit. Bound to `127.0.0.1` and the tailnet address only.
- `bin/sift.py`: the engine. It builds the queue and carries out decisions. Classification is
  `~/claude-roon/flac_migrate.py`'s `build_plan()`, the same code the migration used.
- `~/.local/state/sift/`: `queue.json`, `bin.json`, `overrides.json`, `history.json` (what left
  the bin: emptied, undone, failed in a batch), `notify.json` (the last jot), `covers/`,
  `spectra/`, `sift.log`, `audit.log`.
- Cron runs `sift.py check` at 25 minutes past every second hour, just after `soularr_maintenance.py`.
  If albums have arrived that weren't there at the last jot, it leaves Simon a jot in
  JotScribe, at most once a day. The first run only records what is already waiting.

## Checks on every album

- `flac -t` on every FLAC file, and fingerprint pairing of MP3 and FLAC tracks (`flac_migrate.py`).
- One ffmpeg decode per file (FLAC and MP3) measures where the spectrum stops and the
  integrated loudness (EBU R128). Both are cached in `flac-check-cache.json` with the file's
  other facts. About 0.3 s a file.
- Release details from each Lidarr's database (the release the files were imported as) and
  the first file's tags, shown side by side with both covers.
- Spectrograms are drawn on request by the server and kept in `spectra/`. Starting any job
  stops one being drawn, so no file is held open during a move.

## In the app

- Search, sort (artist, newest, reason), and **Select** to decide several albums at once:
  one job, one bin entry per album.
- **Match volume** in the player turns the louder version down to the quieter one's loudness
  (Web Audio, built on the first tap that needs it).
- **History**: every decision and what became of it, with totals.
- Keyboard: Space, A, ←/→, ↑/↓, Esc; `?` lists them.

## Decisions

| Button | Files | Lidarr |
|---|---|---|
| Keep FLAC | FLAC → `/mnt/roon-music/FLAC`; MP3 → bin | FLAC unmonitored, recorded in `flac-migrated.json`; MP3 unmonitored |
| Keep MP3 | FLAC → bin | FLAC unmonitored, recorded in `flac-returned.json` so nothing re-monitors it |
| Get a better FLAC | FLAC → bin | FLAC monitored, so Soularr searches again |
| Watch for a better copy | none | FLAC monitoring on or off |
| Keep FLAC (duplicate) | MP3 → bin; the FLAC stays | MP3 unmonitored if the MP3 Lidarr has it |
| Keep MP3 (duplicate) | FLAC → bin | none |

Every decision is recorded step by step in `bin.json`, so **Undo** reverses it exactly:
files, monitoring and ledger entries. Bins are `/mnt/roon-music/Sift-bin` and
`/mnt/roon-data/Sift-bin`, so a move into the bin stays on the same drive and is instant.
**Empty bin** asks for the password again and is the only delete.

## Safety

The browser sends album ids or a bin entry id and a decision name from a fixed list, nothing
else. The server checks the id against `queue.json`/`bin.json` and runs `sift.py` with a
fixed argv. File paths never leave the server, and audio and spectrograms are only served
from the four music folders (symlinks resolved first).

## Shell

```
python3 ~/sift/bin/sift.py check                    # re-check now
python3 ~/sift/bin/sift.py resolve-many keep_mp3 1,2 # one decision for several albums
python3 ~/sift/bin/sift.py adopt PATH "label"       # put an existing folder in the bin
systemctl --user restart sift
npm test                                            # server tests, then engine tests in a sandbox
npm run ui                                          # the page in headless Chrome
```
