# Sift

A review queue for Soularr's FLACs, at **http://100.70.110.7:8305**. The design is in
`~/notes/sift-review-plan.md`.

Every FLAC album in Lidarr-FLAC's library (`/mnt/roon-data/music-flac`) is checked against
the MP3 you already have and sorted into a queue:

| Queue | Meaning |
|---|---|
| Ready | Exact match: every FLAC file passes `flac -t`, every MP3 track matches a FLAC track by fingerprint, and the FLAC isn't suspect. Albums with **no MP3 to replace** wait here too, badged: nothing confirms them, so Stage all leaves them out and each is decided on its own |
| Suspect FLAC | Most FLAC tracks stop below 20.5 kHz, as a FLAC made from an MP3 does (`SUSPECT_HZ` in `bin/sift.py`) |
| Different or unconfirmed version | Some MP3 tracks have no fingerprint match in the FLAC |
| Doesn't line up | Fewer tracks, a noticeably different length, or an MP3 folder shared with another album |
| Damaged FLAC | FLAC files fail `flac -t`, including the 20 albums held in `/mnt/roon-music/FLAC-damaged` |
| Needs a look | FLAC folder holds another album's audio, spans folders, or the destination already exists |
| Library health | An album already in `/mnt/roon-music/FLAC` whose files fail `flac -t` or mostly stop short, from the nightly health check |
| Library duplicates | An album in both `/mnt/roon-music/FLAC` and `/mnt/roon-music/MP3`, matched by folder name |
| Arriving | Imported in the last 3 hours; checked next time |

Nothing moves until you approve a decision in the app. Nothing is deleted until you empty the bin.

## Pieces

- `server.js`: the web app (Node, no dependencies). Own password in `auth.json`, set on the
  first visit. Bound to `127.0.0.1` and the tailnet address only.
- `bin/sift.py`: the engine. It builds the queue and carries out decisions. Classification is
  `~/claude-roon/flac_migrate.py`'s `build_plan()`, the same code the migration used.
- `~/.local/state/sift/`: `queue.json`, `bin.json`, `overrides.json`, `history.json` (what left
  the bin: emptied, undone, failed in a batch), `notify.json` (the last jot), `covers/`,
  `spectra/`, `sift.log`, `audit.log`, `health.json`, `settings.json`, `staged.json` (decisions
  waiting for approval), `pending/` (decisions in
  progress), the `lock` files and the two cron logs.
- Cron runs `sift.py check` at 25 minutes past every second hour, just after `soularr_maintenance.py`.
  If albums have arrived that weren't there at the last jot, it leaves Simon a jot in
  JotScribe, at most once a day. The first run only records what is already waiting.

## Checks on every album

- `flac -t` on every FLAC file, and fingerprint pairing of MP3 and FLAC tracks (`flac_migrate.py`).
  A file `flac -t` objects to is only damaged if its decoded audio fails the MD5 in its own
  header: old rips with an ID3v1 tag stuck on the end trip the decoder after the last frame
  with every sample intact. The track badge says where a corrupt file loses sync, or how much
  of a truncated one decodes. `bin/sift.py strip-id3 [folder…]` cuts such tags off (one bin
  entry per album, undoable).
- One ffmpeg decode per file (FLAC and MP3) measures where the spectrum stops and the
  integrated loudness (EBU R128). Both are cached in `flac-check-cache.json` with the file's
  other facts. About 0.3 s a file.
- Release details from each Lidarr's database (the release the files were imported as) and
  the first file's tags, shown side by side with both covers.
- Spectrograms are drawn on request by the server and kept in `spectra/`. Starting any job
  stops one being drawn, so no file is held open during a move.

- A one-line diagnosis for albums in the review queues, with a suggested decision: tracks
  missing, different edits, a same-length track to pair, a different recording. A shared MP3
  folder whose every file matches the FLAC is this album, so Keep FLAC opens for it.
- The Soulseek user each album came from, from slskd's `transfers.db`, with how their other
  albums here fared. **Block** adds them to Soularr's `ignored_users` (Undo removes them).
- Cron runs `sift.py health 150` at 01:10 under `nice`/`ionice`: 150 minutes a night of
  `flac -t` and spectrum checks over the FLAC library, never-checked folders first, results in
  `health.json`. **Looks fine** dismisses an album until its files change.

## In the app

- After a decision, the next album in the queue opens. **Get a better FLAC** can choose the
  release Soularr looks for (Soularr's `use_selected_lidarr_release` is on for this).
- The bin can keep entries for a set number of days and empty only the older ones, still
  with the password. The daily jot says how re-fetched albums came back.
- **Staging.** Keep FLAC, Keep MP3, Get a better FLAC and Put in the bin don't run when
  pressed: the album moves to the **Staged** tab and the next one opens. There every decision
  starts ticked; untick any you're unsure of, or **Remove** one to send the album back to its
  queue, then **Approve** runs the ticked ones as one job, one bin entry per album. An album
  that fails is skipped and named, and the rest go ahead. Stage all (Ready), Select and the
  1/2/3 keys stage too. Watch, Looks fine, Block and the track tools still act at once, since
  they move no album. The server alone writes `staged.json` and drops an entry whose album
  has left the queue or no longer allows the decision.
- Search, sort (artist, newest, reason), and **Select** to stage one decision for several albums.
- **Previous** and **Next** in the player step through the album's tracks (↑/↓ on a keyboard).
- **Match volume** in the player turns the louder version down to the quieter one's loudness
  (Web Audio, built on the first tap that needs it).
- **History**: every decision and what became of it, with totals.
- An album's header says when each side's files arrived (their newest mtime, which Lidarr's
  import and rsync keep), Release details give the time too, and Newest first shows it on
  each row.
- **Show file paths** (⋯ menu) puts each track's path inside its music folder under it, so a
  split or misfiled MP3 folder is plain to see. Library duplicates always show them.
- Keyboard: Space, A, ←/→, ↑/↓, J/K, 1/2/3, Esc; `?` lists them.

## Decisions

| Button | Files | Lidarr |
|---|---|---|
| Keep FLAC | FLAC → `/mnt/roon-music/FLAC`; MP3 → bin | FLAC unmonitored, recorded in `flac-migrated.json`; MP3 unmonitored |
| Keep MP3 | FLAC → bin | FLAC unmonitored, recorded in `flac-returned.json` so nothing re-monitors it |
| Get a better FLAC | FLAC → bin | FLAC monitored, so Soularr searches again |
| Watch for a better copy | none | FLAC monitoring on or off |
| Keep FLAC (duplicate) | MP3 → bin; the FLAC stays | MP3 unmonitored if the MP3 Lidarr has it |
| Keep MP3 (duplicate) | FLAC → bin | none |
| Put in the bin (no MP3) | FLAC → bin | FLAC unmonitored, recorded in `flac-returned.json` so nothing re-monitors it |
| Put in the bin (health) | FLAC → bin | none |
| Block this user | none | Soularr's `ignored_users` gains the user |

Every decision is recorded step by step in `bin.json`, so **Undo** reverses it exactly:
files, monitoring and ledger entries. Bins are `/mnt/roon-music/Sift-bin` and
`/mnt/roon-data/Sift-bin`, so a move into the bin stays on the same drive and is instant.
**Empty bin** asks for the password again and is the only delete.

Undo checks everything first and changes nothing if it can't finish: a file already back in
place, a drive not mounted, or a later decision on the same album still in the bin (undo that
one first). Each step of a decision is written to `pending/` as it starts, so one cut off by a
restart or crash lands in the bin marked *interrupted* the next time Sift runs, and Undo puts
the half-moved files back together.

## Safety

The browser sends album ids or a bin entry id and a decision name from a fixed list, nothing
else. The server checks the id against `queue.json`/`bin.json` and runs `sift.py` with a
fixed argv. Absolute file paths never leave the server (an album shows each file's path
inside its music folder, e.g. `FLAC/Artist/Album/01.flac`, and nothing outside them: always for
Library duplicates, elsewhere behind **Show file paths** in the ⋯ menu), and audio and spectrograms are only served
from the four music folders (symlinks resolved first).

Nothing moves unless both drives it touches are mounted: an unmounted drive's mount point is
an ordinary folder on the root disk. Library health measures one album at a time under the
same lock as decisions, so it never has files open that a decision is moving. Wrong passwords,
at sign-in or when emptying the bin, share one lockout: 10 in 5 minutes. **Sign out** ends
every session, on every device. Engine output shown in the page has its paths replaced with
`…`; the full text is in `audit.log`. Requests for any host name other than Sift's own
addresses are refused.

## Shell

```
python3 ~/sift/bin/sift.py check                    # re-check now
python3 ~/sift/bin/sift.py resolve-many keep_mp3 1,2 # one decision for several albums
python3 ~/sift/bin/sift.py apply-staged 1:keep_flac,2:refetch:0  # what Approve runs
python3 ~/sift/bin/sift.py adopt PATH "label"       # put an existing folder in the bin
python3 ~/sift/bin/sift.py strip-id3 [FOLDER...]    # cut ID3v1 tags off intact library FLACs
systemctl --user restart sift
npm test                                            # server tests, then engine tests in a sandbox
npm run ui                                          # the page in headless Chrome
```
