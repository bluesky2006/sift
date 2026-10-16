# Sift

Review queue for Soularr's FLACs on roon, at http://100.70.110.7:8305. Read `README.md`
first. `~/notes/sift-buttons.md` explains every button and page. The audits are
`~/notes/sift-audit-3.md` and `sift-audit-4.md` (both closed): read them before changing
how files move, how Undo works or how the browser caches. The early plans were retired on
22 Sep and are in `~/notes`' git history only.

- The browser sends ids, decision names and integer indexes only. Paths come from
  `queue.json`/`bin.json` on the server, and keys starting with `_` never leave it.
  The one exception: Library duplicates show each file's path relative to its music folder
  (`FLAC/Artist/Album/01.flac`), never an absolute path.
- Every file change goes through `bin/sift.py` and is recorded in `bin.json` for Undo.
  Emptying the bin is the only delete. The one exception is importing a hand-made Soulseek
  download, where Lidarr moves the files (`ManualImport`, whole folder, one batch, per
  `~/notes/flac-upgrade-runbook.md`); it is still recorded in `bin.json`, but not undoable.
- Classification and the shared check cache live in `bin/flac_migrate.py`, moved here from
  `~/claude-roon` on 16 Oct 2026 (a symlink stays there). Its data files and `soularr_dupes`
  still live in `~/claude-roon`, which is not a git repo and must not become one: it hosts the
  claude-roon remote session. The Lidarr key is read from Lidarr's config, never written here. Bump
  `MATCH_VERSION` there whenever fingerprint matching changes.
- `SUSPECT_HZ` in `bin/sift.py` was calibrated on the queue on 16 Sep 2026. Recalibrate on
  known-genuine albums before moving it. Changing how cutoff or loudness is measured means
  clearing `cutoff`/`lufs` from the check cache, since cached values are kept. `SHARP_EDGE`
  (sharp encoder lowpass vs gentle roll-off) was set on 14 Oct 2026 against LAME transcodes
  and the ambient albums kept from the queue that day. Moving either one re-checks the whole
  library over the next nights (`HEALTH_RULE`), so expect Library health to change.
- `/mnt/roon-data` is NTFS: files deleted while open linger as `.fuse_hidden*`. Stop playback
  before moving files.
- No API keys in the repo; they are read from each Lidarr's `config.xml`.
- Tests: `npm test`, `npm run ui`. Restart with `systemctl --user restart sift`.
