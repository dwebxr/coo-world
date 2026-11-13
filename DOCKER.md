# 🐳 Docker

What this page says comes from the `Dockerfile`, `scripts/coo-entrypoint.sh`, `.dockerignore`, `.github/workflows/docker.yml` and the server's start-up checks (`src/server/index.js`). The `docker` commands below were **not run** for this page (the machine it was written on has no Docker); the start-up rules were checked by running the built server (`npm run build`, `node build/index.js`) without Docker, and the entrypoint by `test/entrypoint.test.js` (below). What runs the image itself is the CI job in "Checked in CI".

## What the image is

The `Dockerfile` has two stages, both `FROM node:22.23.5-alpine` (the Node version in `.nvmrc` and in `engines`).

- **Build stage.** Copies `package.json` and `package-lock.json`, runs `npm ci` (what the lock file names, as the CI workflow installs it; it fails when `package.json` and the lock disagree), copies the build context, runs `npm run build` (the client into `build/public`, the server into `build/index.js`) and then `npm prune --omit=dev`.
- **Production stage.** Installs `curl` (for the health check), `brotli-libs>=1.2.1` and `su-exec` with `apk`; creates the group `nodeuser` (gid 1001) and the user `nodeuser` (uid 1001, in that group); copies `scripts/coo-entrypoint.sh` to `/usr/local/bin/coo-entrypoint.sh` (mode 755, set by `RUN chmod`); and copies from the build stage: `node_modules`, `build`, `src`, `package*.json` and `scripts`. `src` is needed at run time: the server copies the built-in assets and collections from `src/world` into the world folder when it starts.
- **Not in the image** (`.dockerignore` keeps them out of the build context): `world`, `.env` and `.env.*` (`.env.example` is in the context, but the production stage does not copy it), `*.md`, `.git`, `node_modules`, `.claude`. So the image holds no world data and no settings file.
- **Entry point and command.** `ENTRYPOINT ["/usr/local/bin/coo-entrypoint.sh"]` and `CMD ["node", "build/index.js"]`, in `WORKDIR /app`. The entrypoint ends by replacing itself with the command (below), so the server is the container's first process (PID 1) and gets the stop signal itself. npm is not used to start it any more.
- **Environment the image sets.** `NODE_ENV=production` and `COMMIT_HASH` (the build argument of that name, `local` when it is not given). The server returns `COMMIT_HASH` as `commitHash` in `GET /status`. `NODE_ENV=production` decides what a missing `ADMIN_CODE` means (below).
- **User.** The Dockerfile has no `USER` instruction: a container starts as root, and that is the entrypoint. It gives the world folder to `nodeuser` (1001:1001) and then runs the command as 1001:1001 through `su-exec`, which gives up root for good (the server's real, effective and saved uid and gid are all 1001). So the server process has no root rights. What still runs as root: the entrypoint itself, until that point; a `docker exec` without `--user`; and the image's health check. Nothing the image holds is given to `nodeuser`: of `/app`, it can write the world folder only.
- **Volumes.** The Dockerfile declares no `VOLUME`. Unless you mount something at the world's path (below), the world is written to the container's own file system.

## The entrypoint

`scripts/coo-entrypoint.sh` (POSIX `sh`; BusyBox `ash` in the image). Its arguments are the command to run: the image's `CMD`, or what the container was given. Every line it prints starts with `[entrypoint]`.

- **`WORLD` empty or not set:** the command runs at once, as whoever started the container; the server then stops with `[envs] WORLD not set` itself. No default is made up.
- **The world folder** is decided by `scripts/coo-world-folder.mjs` (`/app/scripts/coo-world-folder.mjs` in the image; the rules are in `scripts/lib/worldFolder.mjs`): `WORLD` joined to `/app/` with Node's `path.join`, as the server joins it (`world` is `/app/world`, `../data` is `/data`), then **resolved**: the part of that path that exists is put through `realpath`, and what does not exist yet is put back after it. The resolved folder is what is created, given away and checked, so a link anywhere in the path counts for where it leads, and a world folder that is a link to a data folder is taken as that data folder.
- **Refused**, decided on the joined path and on the resolved folder alike: `/`; `/app`; anything at or under `/app/build`, `/app/node_modules`, `/app/src` or `/app/scripts` (the image's code; giving it to `nodeuser` would let the server replace it); a folder that holds one of those (`/app`'s parent, …); anything at or under the system trees `/bin`, `/sbin`, `/lib`, `/lib64`, `/usr`, `/etc`, `/dev`, `/proc`, `/sys`, `/run`, `/root`, `/home`, `/boot`, `/var`, `/opt` (node and the entrypoint are in `/usr/local/bin`, and the entrypoint runs as root on the next start); `/tmp` itself (its owner may remove anyone's files there); a path that exists but is not a folder, or that leads through a link to nowhere. The entrypoint prints `[entrypoint] refused: WORLD="…" resolves to <folder>: <why>` and exits 1, whoever started the container. Not refused, on purpose: folders below `/tmp`, and `/data`, `/mnt`, `/media`, `/srv` and any other folder outside those trees, so that a data volume can be mounted outside `/app` (`WORLD=../data` with the volume at `/data`).
- **Started as root (the normal case):** it makes the folder if it is missing, and decides again: it has to be the same folder. Then, **on every start**:
  - it gives every entry at or under the folder that is not 1001:1001's to 1001:1001 (`find "$dir" -xdev \( ! -user 1001 -o ! -group 1001 \) -exec chown -h 1001:1001 {} +`) and prints `[entrypoint] entries given to 1001:1001 under /app/world: N` (`0` when there was nothing to change). On every start: a file root wrote later into a folder that is already 1001's (a root shell in the container, a restore) would otherwise stay root's, and a root-owned `db.sqlite` opens read-only without an error: the server would start, answer `/health`, and write no save;
  - it gives the owner read and write on every regular file that lacks them (`u+rw`), and read, write and search on every folder (`u+rwx`), and prints `[entrypoint] entries given u+rw (files) or u+rwx (folders) under /app/world: N`. A `chown` keeps the mode, and root used those files whatever their mode: a `db.sqlite` of mode 0400 worked for the old root process and would open read-only for its new owner. (It finds them with `find … -type f ! -perm -600` and `-type d ! -perm -700`: BusyBox find's `-perm -MODE`, all of those bits set. Links are left alone, since `chmod` would follow them.);
  - last, as 1001:1001 itself (`su-exec 1001:1001 test …`): the folder has to be writable and searchable, and `db.sqlite`, if it is there, readable and writable.
- **When any of that fails** (a read-only volume, a file system on which root may not change owners or modes, entries still not right after the `chown` or `chmod`, a folder above the world folder that 1001 may not search, a `db.sqlite` that is a link to a file 1001 cannot write), it says so, naming the folder or the file, and exits 1. The command is never run as root because a `chown` failed, nor started where it could not save.
- **Then** `exec su-exec 1001:1001` the command.
- **Started as another user** (`docker run --user`, or a platform that sets the uid): nothing can be given away, so nothing is changed; it prints `[entrypoint] started as uid …, not as root: …` and runs the command as that user. If that user cannot write the world folder, the server's own start-up says so: `[server] start-up failed; exiting with code 1: Error: EACCES: permission denied, …`, exit code 1.
- **Links and mounts.** Inside the world folder, `find` follows no symbolic link and `chown -h` changes a link itself, never what it points to: a link in the world folder to something outside it gives nothing outside away. (The world folder itself, and the folders on the way to it, are resolved first: see above.) `-xdev` keeps `find` on the world folder's own file system: when the folder is a volume, everything on the volume is covered. A file system mounted **below** the world folder is not entered: its top folder is given to 1001:1001, nothing on it is (and if that top folder cannot be changed, read-only, the start stops).
- **Not atomic.** The decision, the walk and the server's use of the path are separate steps: something writing the world's file system in between could swap a link into a folder of the path. Nothing else runs in the container before the server, and on a Fly volume attached to one machine nothing else writes the volume at that moment; that is the guard, beyond the second decision after the folder is made.
- **How long it takes.** Each start walks the whole world folder twice (once for the owners, once for the modes; more when something has to change). On a large `assets/` folder that adds to the start time; the first start on a volume written by root changes every entry.

`test/entrypoint.test.js` runs the script itself with `sh` and `dash`, the real `node` and decision, `mkdir`, `chmod` and `find` traversal, and stand-ins for `id`, `su-exec` (its `test` checks run as the test user), `chown` and the ids `find` compares with (a test that is not root cannot make files that belong to 1001). `test/worldFolder.test.js` holds the decision to its rules on real folders and links. Neither runs BusyBox, a real change of owner, or a mount point: the CI job does that with the image.

## Port and health check

- The server listens on `PORT`, on all interfaces (`0.0.0.0`). The Dockerfile says `EXPOSE 3000` (documentation only).
- `PORT` has to be **1024 or above**: the server has no root rights, and a process without them cannot normally listen on a lower port. Docker may let a container do it anyway (it can lower that limit inside the container), so a local or CI run does not show the problem; another platform may not.
- The health check is `curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1`, every 2 s, with a 10 s timeout, a 5 s start period and 5 retries. It is written in shell form, so the shell in the container reads `PORT` when the check runs: it asks the port the server listens on (3000 when `PORT` is not set). It runs as root, inside the container.
- `GET /health` answers `{"status":"ok", ...}` once the server listens, which is after the world has loaded.

## Environment needed to start

The image has no `.env` file, so every setting comes from the container's environment. The server refuses to start (a fatal error, most of them beginning `[envs]`, and exit code 1) unless all of these are set:

| Variable | Rule checked at start-up |
|---|---|
| `WORLD` | the world folder's name; it is joined to `/app`. The entrypoint refuses `/`, `/app`, the image's code folders, the system trees and `/tmp` itself, as written or through a link (above) |
| `PORT` | the port to listen on, 1024 or above (the health check asks it) |
| `JWT_SECRET` | not blank and not `hyper`; shorter than 32 characters is only warned about. Generate one with `openssl rand -hex 32` and keep using it: session tokens are signed with it |
| `SAVE_INTERVAL` | seconds between saves (`.env.example` has 60) |
| `PUBLIC_MAX_UPLOAD_SIZE` | a positive number of megabytes |
| `PUBLIC_WS_URL` | the address browsers connect to. Only its first two letters are checked (`ws`): give a whole `ws://` or `wss://` address |
| `PUBLIC_API_URL` | the address browsers use for `/api`; at most 1,024 characters |
| `ASSETS` | must not be empty. Exactly `s3` selects S3; any other value is local storage, so write `local` or `s3` |
| `ASSETS_BASE_URL` | the address browsers load assets from; no trailing `/`; at most 1,024 characters |
| `ASSETS_S3_URI` | only with `ASSETS=s3`, where it must be an S3 address the server can read (scheme and credentials: `src/server/AssetsS3.js`) |

- `ADMIN_CODE` is not needed to start. Because the image sets `NODE_ENV=production`, a container without it is `locked`: nobody can become admin with a code, and the server logs an error line saying so. Set `ADMIN_CODE` (16 or more random characters without spaces: `openssl rand -hex 16`), or `ADMIN_OPEN=true` if every visitor is meant to be an admin. Wrong codes are only slowed down: the code itself is the protection.
- Several optional settings are checked as well (`UPLOAD_*`, `WS_CONNECT_*`, `STORAGE_*`, `CLEAN_TRASH_DAYS`, `HSTS_MAX_AGE` among them): a value the server refuses stops the start-up the same way. `.env.example` lists the settings with their defaults.
- The three addresses (`PUBLIC_WS_URL`, `PUBLIC_API_URL`, `ASSETS_BASE_URL`) are used by browsers, so they name the host and port as reached from outside the container. The `PUBLIC_` values the page is handed (a list of names: `src/core/extras/publicEnv.js`) are read when the container starts and served as `/env.js`; they do not have to be present at build time. A `PUBLIC_` name that is not on the list is not served, and the start-up log names it (its name, not its value; `PUBLIC_RPC_URL` alone is left out without being named).

## Where the world's data is

The world folder is `WORLD` joined to the directory above `build/`: in the image that is `/app/<WORLD>`, so `/app/world` for `WORLD=world`. The entrypoint creates it if it is missing, and it belongs to 1001:1001 after every start. It holds `db.sqlite` (unless `DB_URI` names a PostgreSQL database), `assets/` (with `ASSETS=local`), `collections/`, and later `storage.json`, `assets-trash/` and `backups/` (made by `npm run world:backup`: see the README).

To keep the world, mount a volume or a host folder at that path: `-v "$(pwd)/world:/app/world"` for `WORLD=world`. The entrypoint changes the owner of what is in it: with a host folder on a Linux host, its files then belong to uid 1001 there too, which may not be your own user.

Work inside a running container that writes into the world (a backup, a restored file) should run as the server's user: `docker exec --user 1001:1001 <container> …`, or `su-exec 1001:1001 …` from a root shell in it. What root writes there instead stays root's until the next start gives it back, and until then the server may not be able to write it.

## Build and run

Not run for this page; derived from the Dockerfile and the checks above.

```bash
docker build -t coo-world .

# generate these once and keep them (the first signs the session tokens, the second is the admin code)
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_CODE=$(openssl rand -hex 16)

docker run -d -p 3000:3000 \
  -v "$(pwd)/world:/app/world" \
  -e WORLD=world \
  -e PORT=3000 \
  -e JWT_SECRET="$JWT_SECRET" \
  -e ADMIN_CODE="$ADMIN_CODE" \
  -e SAVE_INTERVAL=60 \
  -e PUBLIC_MAX_UPLOAD_SIZE=12 \
  -e PUBLIC_WS_URL=ws://localhost:3000/ws \
  -e PUBLIC_API_URL=http://localhost:3000/api \
  -e ASSETS=local \
  -e ASSETS_BASE_URL=http://localhost:3000/assets \
  coo-world
```

Replace `localhost:3000` in the three addresses with the host (and `wss://` / `https://`) your visitors use. A named volume (`-v coo-world-data:/app/world`) keeps the world without changing the owner of a folder on your machine.

## Checked in CI

`.github/workflows/image.yml` builds this image on a GitHub runner and runs it there with `scripts/image-check.mjs --model=nonroot`. This section says what that job checks, not what it found: the job's output and its `image-check` artifact say that for each run.

What its first run found (2026-11-13, on the image as it was **before** the entrypoint: `CMD ["npm", "run", "start"]`, no `USER`): the container's first process was `npm run start`, run by `node`, as root; the server was its direct child, with no shell in between; both `SIGTERM` and `SIGINT` reached the server, whose log then held `[server] SIG…: saving the world before exit` and `[network] final save complete`; each `docker stop` returned after about 0.2 s, and the container's exit code was 0. That exit code was PID 1's, npm's: the job did not see the server's own exit status then, only its log lines and how the container ended. With the entrypoint the server is PID 1, and the container's exit code is the server's own. (`--model=current` still describes that older image, for a run against it.)

It runs for a pull request, or a push to `main`, that changes what the image is built from (`Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`, `.nvmrc`, `scripts/build*.mjs`, `scripts/lib/`, `scripts/coo-entrypoint.sh`), `src/server/`, `src/core/` (bundled into the server; the final save is in `src/core/systems/ServerNetwork.js`), the script or the workflow; once a week (the base image's tag can be pushed again with other contents); and by hand. It is not a required check: with a path filter it does not report on most pull requests. Nothing is pushed, no port is published to the runner, and every setting is made up; the job's output shows the value of a setting with a secret's name (`JWT_SECRET`) as `***` all the same.

What the job asserts:

- `docker build` of the repository with a `COMMIT_HASH` succeeds.
- **A volume written by root is taken over.** A named volume at `/app/world` is first filled by the same image started the old way, `docker run --user 0 --entrypoint npm … run start`, until it is healthy, then stopped. A container started as the image starts (its own entry point and command, the settings of the table above) on that volume becomes `healthy` by the image's own health check; its PID 1 is `node build/index.js`, with `node` as its executable (no npm, no shell); `/proc/1/status` gives 1001 as its real, effective, saved and file-system uid and gid; `find /app/world -xdev ! -user 1001` and `find /app/world -xdev ! -group 1001` print nothing; the entrypoint's line says it gave at least one entry to 1001:1001; and `GET /status`, asked with `curl` inside the container, carries the `COMMIT_HASH` the build was given.
- **`docker stop -t 10`** (SIGTERM, Docker's defaults) of that container: it is gone within 8 s with exit code 0, and its log holds the server's `[server] SIGTERM: saving the world before exit` and `[network] final save complete` and none of the lines the server prints when something was not stopped or not saved: `[server] stopping the world failed`, `[server] close failed`, `[server] final save failed`, the save's deadline, a second signal, a signal during start-up, `[network] not persisted`, `[network] error saving`, `… was not loaded; changes will not be saved`, a user's row `not stored`, `[storage] failed to save` (`NOT_STOPPED_OR_SAVED` in `scripts/lib/imageCheck.mjs`, each quoted from its source). Any of them fails the stop whatever the exit code: the server still exits 0 after a failed stop of the world or of its listener.
- **Mixed ownership.** `db.sqlite` is made root's again through a throw-away root container on the volume (`--entrypoint chown … 0:0 /app/world/db.sqlite`). The next normal start becomes healthy, nothing under `/app/world` is left that is not 1001's, and the entrypoint's line says it gave at least one entry. That container is stopped with `docker stop --signal SIGINT -t 5` (the signal and the timeout Fly documents as its defaults): the same as above within 4 s, with `SIGINT` in the server's line.
- **Modes root could live with.** A throw-away root container makes `db.sqlite` root's with mode 0400 and `assets/` mode 0500. The next normal start becomes healthy; the owner line and the modes line each say at least one entry; nothing is left that is not 1001's; `docker exec --user 1001:1001 … test -w` succeeds for both; and its `docker stop -t 10` passes as above, so the final save was written into that database.
- **A start with nothing to give:** a further container on the volume becomes healthy, and both lines say 0.
- The 8 s and the 4 s are measured on Docker's own clock: from the `kill` event Docker records when it sends the signal to the container's `die` event (or, without one, its `State.FinishedAt`), read with `docker events` after the stop. The time the `docker stop` command itself took holds the CLI's start and the runner's scheduling as well; it is judged only when Docker's events cannot be read, and then against the whole timeout (10 s, 5 s), which a container killed after the timeout still fails.
- **Another port:** a container with `PORT=3100` (and the three addresses on 3100), without a volume (the entrypoint makes the folder), becomes healthy by the image's own health check.
- **Another user on a volume it cannot write:** `docker run --user 2000:2000` on a fresh volume (root's) ends by itself, never healthy, with exit code 1, the entrypoint's `started as uid 2000, not as root` line and the server's `[server] start-up failed; exiting with code 1:` line with `EACCES`.
- **The image's code through a link:** a throw-away root container puts a link `/app/world/link -> /app/build` on a fresh volume; with `-e WORLD=world/link/public` the container ends with exit code 1 and the refusal of `/app/build/public`, and `docker diff` of it shows nothing at or under `/app/build`.
- **A refused `WORLD`:** `-e WORLD=build` ends with exit code 1 and the entrypoint's `refused: WORLD="build" resolves to /app/build: …` line; `docker diff` of that container shows nothing at or under `/app/build`; and a throw-away root container of the image (`--entrypoint find … /app/build ! -user 0`) finds nothing there that is not root's.
- **A system tree:** `-e WORLD=../usr/local/bin` ends with exit code 1 and the refusal of `/usr/local/bin`; `docker diff` shows nothing under `/usr`.

What it records without asserting, in the job's output and in the artifact (`image-check.json` and each container's log): the image's configuration (user, entry point, command, health check); which signals PID 1 handles; the process tree; how long each start took; how many entries the entrypoint gave in each start; for each stop the signals Docker sent (a second `kill` with SIGKILL means the timeout ran out), the exit code its `die` event carries, and how long the `docker stop` command took; what is in the world folder; what `docker diff` listed for the refused container; the exit code of the old-way container's stop.

What it does not check:

- **Fly.** A Fly machine is not `docker run`; see "Rolling this out on Fly" for what this job does not show there.
- **Other architectures.** One build, for the runner's own (`linux/amd64`). `docker.yml` also builds `linux/arm64`; no job runs that image.
- **A world in use.** No client connects and nothing is changed in the world before the stops: they show that the signal reaches the server and that its final save runs and returns in time, not that a changed row is written (the persistence tests are for that). PostgreSQL and S3 are not used.
- **Other ways to store the world.** A host folder instead of a named volume (its ownership on the host), a read-only volume (the entrypoint's refusal to go on is covered by `test/entrypoint.test.js` only, with stand-ins for `chown` and `chmod`), a file system mounted below the world folder, a world that is a link to a data folder (the decision's tests cover it, not the image), a large world (how long the walks and the first `chown` take).

## Rolling this out on Fly

This image changes how production starts. What follows is the owner's checklist; nothing in it was done or checked from this repository, which has no `fly.toml` (it is the owner's, untracked) and no access to the app. What Fly's documentation (docs.fly.io) says is quoted as such; what comes only from Fly's community forum is marked **reported, not documented**.

1. **The port.** `internal_port` in `fly.toml` and the `PORT` the server gets must be 1024 or above: the server has no root rights any more. (Fly documents 8080 as `internal_port`'s default.) The CI job cannot show this: Docker may let a non-root process listen below 1024.
2. **The stop.** Fly documents `SIGINT` as the default `kill_signal` and 5 s as the default `kill_timeout` (at most 300 s). The server's final save has a 3.5 s deadline (`SHUTDOWN_DEADLINE_MS`) and the process exits by about 4 s; the CI job's SIGINT stop with 5 s is the same pair under Docker. Check what `fly.toml` sets.
3. **What bypasses or reuses the entrypoint.** Fly documents ([configuration reference](https://docs.fly.io/reference/configuration/)) that `[experimental] entrypoint` overrides the Dockerfile's `ENTRYPOINT`, `[experimental] exec` overrides both `ENTRYPOINT` and `CMD`, and `[experimental] cmd` overrides `CMD`: with the first two the entrypoint does not run, nothing is given to 1001:1001, and the command runs as root (or fails). A `[processes]` command replaces `CMD` and keeps `ENTRYPOINT` ([Run multiple processes](https://docs.fly.io/launch/processes/#run-multiple-processes): "they don't replace the ENTRYPOINT of your app image, but will supersede CMD"), so the entrypoint still runs before it. A `release_command` runs, as documented, in a temporary machine from the new image, with `ENTRYPOINT` always run and no volume attached: with this image it runs as 1001:1001, on a world folder the entrypoint makes in that machine, not on the volume. **Check for your app:** which of these your `fly.toml` uses.
4. **Where the volume is mounted.** `[mounts] destination` has to be the world folder itself (`/app/<WORLD>`, so `/app/world` for `WORLD=world`), or a folder above it outside `/app`. The entrypoint gives the world folder and what is on its file system to 1001:1001, nothing else. **Reported, not documented:** Fly sets the owner of the mount point itself when it mounts the volume, and the machine's log has a line about the mount that names the destination and a uid; look for it in `fly logs` around a start.
5. **Before the deploy: measure, size the waits, take a snapshot.**
   - **Measure without deploying.** On the running machine, from a root console (`fly ssh console`), count the volume's entries and time one walk over them: `time find /app/world -xdev | wc -l` (with the mount's real path). The first start of the new image walks them for the owners and for the modes, changes the owner of every entry root wrote (all of them, the first time), and only then starts the server; every later start walks them twice. The timed `find` is a lower bound for one walk, not for the `chown` that follows it.
   - **Size two waits, not one.** The start is that walk plus the server's own start-up. The health checks' `grace_period` in `fly.toml` ("The time to wait after a Machine starts before checking its health", [configuration reference](https://docs.fly.io/reference/configuration/); the page states no default, and its examples use 1 s and 10 s) has to cover it, and so does the time `fly deploy` waits for the new machine: [`fly deploy`](https://docs.fly.io/flyctl/cmd/fly_deploy/) documents `--wait-timeout` ("Time duration to wait for individual machines to transition states and become healthy", default `5m0s`), which `[deploy] wait_timeout` in `fly.toml` also sets ("the default 5 minute timeout"). If the walk may not fit, raise both before the deploy rather than find out during it (what a deploy that runs out of its wait leaves running was not looked up for this page).
   - **Take a snapshot.** Fly documents daily automatic snapshots (kept 5 days by default, 1 to 60) and an on-demand one, `fly volumes snapshots create <volume id>`; a snapshot is restored into a new volume (`fly volumes create <name> --snapshot-id <id> -s <GB>`).
6. **The first deploy's stop is the old image's.** The machine that is replaced still runs the old image (npm as PID 1, as root), and its stop is what the CI job's first run measured on that image under Docker, not on Fly. Deploy when the world is idle.
7. **`fly ssh console` is root.** Fly documents `root` as its default user (`-u, --user` chooses another). Maintenance that writes into the world (a backup, a restore, a file put there by hand) goes through `su-exec 1001:1001 …` (for example `cd /app && su-exec 1001:1001 npm run world:backup`) or a console as that user. What root writes there stays root's until the next start gives it back; until then the server may not be able to write it.
8. **Watch the first start and one stop.** In `fly logs`: `[entrypoint] entries given to 1001:1001 under /app/world: N` (large on the first start, then usually 0), `[entrypoint] entries given u+rw (files) or u+rwx (folders) under /app/world: N`, `server listening on port …`, and on a stop `[server] SIGINT: saving the world before exit` followed by `[network] final save complete`. An `[entrypoint] refused`, `could not …` or `cannot …` line means the server did not start.
9. **Rolling back.** Fly documents `fly deploy --image <ref>` and `fly releases --image` (which shows each release's image); no dedicated rollback command was found in its docs. Deploying the previous image reference brings back npm as root: it runs on the volume unchanged, since root reads and writes files that belong to 1001. If the volume itself is in doubt, restore the snapshot of step 5 into a new volume.

What the CI job does **not** show for Fly:

- **PID 1.** In CI the server is PID 1. On a Fly machine, Fly documents ([the init process](https://docs.fly.io/getting-started/troubleshooting/#the-init-process)) that it "injects a lightweight `init` process at runtime" that "runs in front of your app", reaps orphaned processes and forwards signals "from the host to your app", and that it cannot be disabled or replaced. So the server is not PID 1 there; the CI stops show what the server does when the signal reaches it, and that Fly forwards it is Fly's documented behaviour, not something this job tested. **Check for your app:** one deploy's stop in `fly logs` (step 8).
- **The health check.** The CI job judges the Dockerfile's `HEALTHCHECK`. Fly's documentation describes health checks set in `fly.toml` (`[checks]`, `[[services.tcp_checks]]`, `[[services.http_checks]]`, `[[http_service.checks]]`) and does not say that the Dockerfile's is used: the `PORT` in the image's check proves nothing there.
- **The volume's owner when it is mounted**, ports below 1024, the stop signal and its timeout (all `fly.toml` and the platform), the machine's architecture, and how long the first `chown` takes on the real world.

## The workflow

`.github/workflows/docker.yml` runs only when it is started by hand (`workflow_dispatch`). It builds the image for `linux/amd64` and `linux/arm64` with `COMMIT_HASH` set to the commit, and pushes it to `ghcr.io/<owner>/<repository>` under the tags `docker/metadata-action` makes from that file's settings. Its comment says production deploys build from the Dockerfile through Fly; the Fly configuration is not part of this repository.
