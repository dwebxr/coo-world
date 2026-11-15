# Backups

`npm run world:backup` writes one archive, `backup_<date>_<time>.tar.gz`, into `<world>/backups` and keeps the seven newest. The world is the folder `WORLD` names (`world` when it is not set), and it must exist. The server can be running, with the limit below.

- **What goes in.** The world's folder (assets, collections, `storage.json`, the clean-up's trash), without `backups/` itself. The SQLite database goes in as a copy made by SQLite's own backup, which is one consistent state of it; the live `db.sqlite` and the files SQLite keeps beside it are left out.
- **Not one moment.** The files are taken first and the database after them, so with the server running the two are not of the same moment: an asset uploaded in between can be named by the archived database and missing from the archived files. For a backup in which everything belongs together, stop the server first.
- **PostgreSQL is not included.** With `DB_URI` set to a PostgreSQL address the world's database is not in the folder and not in the archive (the script says so). Back it up by its own means.
- **It is not a backup until it is copied elsewhere.** The archive stays in the world's own folder, on the same disk as what it holds, and is lost with it.
- **Room it needs.** While it runs, a working folder in `<world>/backups` (`.staging-…`) holds the copy of the database, uncompressed; the other files are hard links, not second copies, except where hard links cannot be made: there they are copied and need their room too. The archive comes on top. A run that is killed leaves the working folder, to be removed by hand.
- Run one backup of a world at a time. It needs `tar`.
