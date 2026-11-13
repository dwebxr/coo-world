# 🐳 Docker

What this page says comes from the `Dockerfile`, `.dockerignore`, `.github/workflows/docker.yml` and the server's start-up checks (`src/server/index.js`). The `docker` commands below were **not run** for this page (the machine it was written on has no Docker); the start-up rules were checked by running the built server (`npm run build`, `node build/index.js`) without Docker.

## What the image is

The `Dockerfile` has two stages, both `FROM node:22.23.5-alpine` (the Node version in `.nvmrc` and in `engines`).

- **Build stage.** Copies `package.json` and `package-lock.json`, runs `npm install` (not `npm ci`, which is what the CI workflow runs), copies the build context, runs `npm run build` (the client into `build/public`, the server into `build/index.js`) and then `npm prune --omit=dev`.
- **Production stage.** Installs `curl` (for the health check) and `brotli-libs>=1.2.1` with `apk`, and copies from the build stage: `node_modules`, `build`, `src`, `package*.json` and `scripts`. `src` is needed at run time: the server copies the built-in assets and collections from `src/world` into the world folder when it starts.
- **Not in the image** (`.dockerignore` keeps them out of the build context): `world`, `.env` and `.env.*` (`.env.example` is in the context, but the production stage does not copy it), `*.md`, `.git`, `node_modules`, `.claude`. So the image holds no world data and no settings file.
- **Command.** `CMD ["npm", "run", "start"]`, which is `node build/index.js`, in `WORKDIR /app`.
- **Environment the image sets.** `NODE_ENV=production` and `COMMIT_HASH` (the build argument of that name, `local` when it is not given). The server returns `COMMIT_HASH` as `commitHash` in `GET /status`. `NODE_ENV=production` decides what a missing `ADMIN_CODE` means (below).
- **User.** The Dockerfile has no `USER` instruction, so the server runs as the base image's default user (root in the official Node images; not checked here). It creates a user `nodeuser` (uid 1001) and never switches to it. Running as a non-root user is not done.
- **Volumes.** The Dockerfile declares no `VOLUME`. Unless you mount something at the world's path (below), the world is written to the container's own file system.

## Port and health check

- The server listens on `PORT`, on all interfaces (`0.0.0.0`). The Dockerfile says `EXPOSE 3000`.
- The health check is `curl -f http://localhost:3000/health`, every 2 s, with a 10 s timeout, a 5 s start period and 5 retries. It is fixed to port 3000: with another `PORT` the check asks a port nobody listens on. Keep `PORT=3000` inside the container and choose the outside port with `-p`.
- `GET /health` answers `{"status":"ok", ...}` once the server listens, which is after the world has loaded.

## Environment needed to start

The image has no `.env` file, so every setting comes from the container's environment. The server refuses to start (a fatal error, most of them beginning `[envs]`, and exit code 1) unless all of these are set:

| Variable | Rule checked at start-up |
|---|---|
| `WORLD` | the world folder's name; it is joined to `/app` |
| `PORT` | the port to listen on (3000 for the health check) |
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
- The three addresses (`PUBLIC_WS_URL`, `PUBLIC_API_URL`, `ASSETS_BASE_URL`) are used by browsers, so they name the host and port as reached from outside the container. `PUBLIC_*` values are read when the container starts and served to the page (`/env.js`); they do not have to be present at build time.

## Where the world's data is

The world folder is `WORLD` joined to the directory above `build/`: in the image that is `/app/<WORLD>`, so `/app/world` for `WORLD=world`. The server creates it when it starts. It holds `db.sqlite` (unless `DB_URI` names a PostgreSQL database), `assets/` (with `ASSETS=local`), `collections/`, and later `storage.json`, `assets-trash/` and `backups/` (made by `npm run world:backup`: see the README).

To keep the world, mount a volume or a host folder at that path: `-v "$(pwd)/world:/app/world"` for `WORLD=world`.

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

Replace `localhost:3000` in the three addresses with the host (and `wss://` / `https://`) your visitors use.

## Checked in CI

`.github/workflows/image.yml` builds this image on a GitHub runner and runs it there with `scripts/image-check.mjs`. This section says what that job checks, not what it found: the job's output and its `image-check` artifact say that for each run.

It runs for a pull request, or a push to `main`, that changes what the image is built from (`Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`, `.nvmrc`, `scripts/build*.mjs`, `scripts/lib/`), `src/server/`, the script or the workflow; once a week (the base image's tag can be pushed again with other contents); and by hand. It is not a required check: with a path filter it does not report on most pull requests. Nothing is pushed, no port is published to the runner, and every setting is made up.

What the job asserts:

- `docker build` of the repository with a `COMMIT_HASH` succeeds.
- A container started with the image's own entry point and command, a named volume at `/app/world` and the settings of the table above becomes `healthy` by the image's own health check. A `node build/index.js` process runs in it, and `GET /status`, asked with `curl` inside the container, carries the `COMMIT_HASH` the build was given.
- `docker stop -t 10` (SIGTERM, Docker's defaults): the container is gone within 8 s with exit code 0, and its log holds the server's `[server] SIGTERM: saving the world before exit` and `[network] final save complete` and none of the lines the server prints when something was not saved (`[network] not persisted` among them).
- A second container on the same volume, stopped with `docker stop --signal SIGINT -t 5` (the signal and the timeout Fly documents as its defaults): the same within 4 s, with `SIGINT` in the server's line.
- A third container on the same volume becomes healthy: the world the first two wrote loads.

What it records without asserting, in the job's output and in the artifact (`image-check.json` and each container's log): the image's configuration (user, entry point, command, health check); who PID 1 is and whether it has a handler for SIGTERM and for SIGINT; whether a shell sits between PID 1 and the server; the uids; how long the start and each stop took; what is in the world folder.

What it does not check:

- **Fly.** A Fly machine is not `docker run`. Fly's own init is PID 1 there; the stop signal and the time before the kill are Fly's (`kill_signal`, `kill_timeout`); a volume is mounted with the owner the platform gives it; and the health checks are Fly's, not the Dockerfile's `HEALTHCHECK`. A green job says the image stops cleanly under Docker with these two signals and timeouts, not that a deploy does.
- **Other architectures.** One build, for the runner's own (`linux/amd64`). `docker.yml` also builds `linux/arm64`; no job runs that image.
- **A world in use.** No client connects and nothing is changed in the world before the stops: they show that the signal reaches the server and that its final save runs and returns in time, not that a changed row is written (the persistence tests are for that). PostgreSQL and S3 are not used.
- **Other ways to start it.** Another `PORT` than 3000, another user than the image's, a host folder instead of a named volume.

## The workflow

`.github/workflows/docker.yml` runs only when it is started by hand (`workflow_dispatch`). It builds the image for `linux/amd64` and `linux/arm64` with `COMMIT_HASH` set to the commit, and pushes it to `ghcr.io/<owner>/<repository>` under the tags `docker/metadata-action` makes from that file's settings. Its comment says production deploys build from the Dockerfile through Fly; the Fly configuration is not part of this repository.
