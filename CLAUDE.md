# Sift

Review queue for Soularr's FLACs on roon, at http://100.70.110.7:8305. Read `README.md`
first. The design history is `~/notes/sift-review-plan.md`, and the next features, with the
rules to keep and the lessons from the first build, are in `~/notes/sift-features-plan.md`.

- The browser sends ids, decision names and integer indexes only. Paths come from
  `queue.json`/`bin.json` on the server, and keys starting with `_` never leave it.
- Every file change goes through `bin/sift.py` and is recorded in `bin.json` for Undo.
  Emptying the bin is the only delete.
- Classification lives in `~/claude-roon/flac_migrate.py` (outside this repo). Bump
  `MATCH_VERSION` there whenever fingerprint matching changes.
- `/mnt/roon-data` is NTFS: files deleted while open linger as `.fuse_hidden*`. Stop playback
  before moving files.
- No API keys in the repo; they are read from each Lidarr's `config.xml`.
- Tests: `npm test`, `npm run ui`. Restart with `systemctl --user restart sift`.
