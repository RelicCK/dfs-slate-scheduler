# DFS slate scheduler

A single web page that reads your DraftKings and FanDuel entry CSVs and shows each slate's first lock and late swap times in Eastern time. It can also schedule ntfy push alerts before each lock.

Open the GitHub Pages site, drop in your entry files, enter your ntfy topic, and tap "Schedule alerts".

- DraftKings times come from the file's "Game Info" column.
- FanDuel times are matched to same-day DraftKings games, then looked up on ESPN's scoreboard. If neither has a time, you can type it in.
- Everything runs in your browser. Files are never uploaded anywhere.
