# DFS slate scheduler

A single web page that reads your DraftKings and FanDuel entry CSVs and shows each slate's first lock and late swap times in Eastern time. It can also schedule ntfy push alerts before each lock.

Open the GitHub Pages site, drop in your entry files, enter your ntfy topic, and tap "Schedule alerts".

- DraftKings times come from the file's "Game Info" column.
- FanDuel times are matched to same-day DraftKings games, then looked up on ESPN's scoreboard. If neither has a time, you can type it in.
- Everything runs in your browser. Files are never uploaded anywhere.

## Dupe Checker (`analytics.html`)

Post-contest duplication and strategy analytics (the former DFS Dupe Checker), linked from the Slate Locks header.

- `js/dupe-core.js`: calculations (no DOM). Definitions and conventions are documented at the top of the file.
- `js/dupe-db.js`: IndexedDB history (`dfsContestAnalytics`), schema migrations, gzip JSON backup/restore, import of old Dupe Checker backups.
- `js/analytics-ui.js`: the page.
- `js/dupe-sync.js`: optional History sync between devices through a private GitHub repo of yours (fine-grained token, Contents read/write, stored only in the browser). Index at `history/index.json.gz`, raw files at `history/src/<hash>.bin`; deletions sync too.
- `node tests/run-tests.js [fixture-dir]`: spec acceptance checks; with a fixture folder it also checks the real contest files (kept out of this public repo).

Everything runs in the browser; uploaded files and history stay on the device unless you export a backup or turn on sync (which writes only to your own private repo).
