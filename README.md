# Sift

A review queue for Soularr's FLACs, at **http://100.70.110.7:8305**. The design is in
`~/notes/sift-review-plan.md`.

Every FLAC album in Lidarr-FLAC's library (`/mnt/roon-data/music-flac`) is checked against
the MP3 you already have and sorted into a queue:

| Queue | Meaning |
|---|---|
| Ready | Exact match: every FLAC file passes `flac -t` and every MP3 track matches a FLAC track by fingerprint |
| Different or unconfirmed version | Some MP3 tracks have no fingerprint match in the FLAC |
| Doesn't line up | Fewer tracks, a noticeably different length, or an MP3 folder shared with another album |
| Damaged FLAC | FLAC files fail `flac -t`, including the 20 albums held in `/mnt/roon-music/FLAC-damaged` |
| Needs a look | FLAC folder holds another album's audio, spans folders, or the destination already exists |
| Arriving | Imported in the last 3 hours; checked next time |

Nothing moves until you decide in the app. Nothing is deleted until you empty the bin.

## Pieces

- `server.js`: the web app (Node, no dependencies). Own password in `auth.json`, set on the
  first visit. Bound to `127.0.0.1` and the tailnet address only.
- `bin/sift.py`: the engine. It builds the queue and carries out decisions. Classification is
  `~/claude-roon/flac_migrate.py`'s `build_plan()`, the same code the migration used.
- `~/.local/state/sift/`: `queue.json`, `bin.json`, `covers/`, `sift.log`, `audit.log`.
- Cron runs `sift.py check` at 25 minutes past every second hour, just after `soularr_maintenance.py`.

## Decisions

| Button | Files | Lidarr |
|---|---|---|
| Keep FLAC | FLAC → `/mnt/roon-music/FLAC`; MP3 → bin | FLAC unmonitored, recorded in `flac-migrated.json`; MP3 unmonitored |
| Keep MP3 | FLAC → bin | FLAC unmonitored, recorded in `flac-returned.json` so nothing re-monitors it |
| Get a better FLAC | FLAC → bin | FLAC monitored, so Soularr searches again |
| Watch for a better copy | none | FLAC monitoring on or off |

Every decision is recorded step by step in `bin.json`, so **Undo** reverses it exactly:
files, monitoring and ledger entries. Bins are `/mnt/roon-music/Sift-bin` and
`/mnt/roon-data/Sift-bin`, so a move into the bin stays on the same drive and is instant.
**Empty bin** asks for the password again and is the only delete.

## Safety

The browser sends an album id or bin entry id and a decision name from a fixed list, nothing
else. The server checks the id against `queue.json`/`bin.json` and runs `sift.py` with a
fixed argv. File paths never leave the server, and audio is only served from the three
music folders (symlinks resolved first).

## Shell

```
python3 ~/sift/bin/sift.py check                    # re-check now
python3 ~/sift/bin/sift.py adopt PATH "label"       # put an existing folder in the bin
systemctl --user restart sift
npm test                                            # server tests, then engine tests in a sandbox
```
