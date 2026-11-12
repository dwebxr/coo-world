# Contributing Guide

This repository is `dwebxr/coo-world`. Its code started as a fork of [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) and keeps that project's licence unchanged (GPL-3.0, see `LICENSE`). Pull requests for this fork go to this repository, not to upstream.

## Set up

- Node.js 22.23.5 (`.nvmrc`; `engines` in `package.json` names the same version).
- Install the dependencies with `npm ci` (what CI runs) or `npm install`.
- To run a world locally, follow the Quick Start in `README.md`.

## Before you open a pull request

```bash
npm run check   # eslint with a cap on warnings, then prettier --check; neither rewrites a file
npm test        # the unit tests: node --test "test/**/*.test.js"
```

- `npm run check` is `npm run lint && npm run format:check`. Lint errors fail it, and so do more warnings than the cap in the `lint` script (`--max-warnings` in `package.json`); the cap is meant only to go down.
- `npm run format` (prettier `--write`) and `npm run lint:fix` are the commands that rewrite files. Prettier does not format `*.md` files (`.prettierignore`).
- CI (`.github/workflows/ci.yml`, on every pull request and on pushes to `main`) runs `npm ci`, `npm run check`, the four builds and `npm test`.

## The four builds

```bash
npm run client:build && npm run viewer:build && npm run node-client:build && npm run build
```

That is the order CI uses. `client:build` and `viewer:build` each empty `build/` first, so `npm run build` (the world's page into `build/public` and the server into `build/index.js`, which `npm start` runs) and `node-client:build` have to come after those two.

## End-to-end suites

The suites in `test/e2e/` drive a built world in a browser. `test/e2e/README.md` describes them, their options and the prerequisites (a Playwright browser and the four builds). One suite on one engine:

```bash
node test/e2e/fullstack.mjs --engine=chromium   # or --engine=webkit, --engine=firefox
```

The workflow (`.github/workflows/e2e.yml`) runs every suite on Chromium, WebKit and Firefox. Chromium and WebKit decide the result. Firefox is advisory: a suite that fails there does not fail the job, except the WebSocket frame probe (`ws-frames.mjs`), which is required on all three. The workflow runs for pull requests that touch `src/`, `scripts/`, `test/e2e/`, `docs/scripting/examples/`, `package.json`, `package-lock.json` or the workflow itself, on pushes to `main`, weekly and when started by hand; a pull request that touches none of those paths skips it, so run the suites your change concerns locally, on Chromium and on WebKit.

## Dependencies

- `npm run audit:prod` runs `npm audit --omit=dev` and fails on a high or critical advisory in what a production install holds. A weekly workflow runs it, and so does a pull request that changes `package.json`, the lock file, the allowlist, the script or the workflow.
- `audit-allowlist.json` is for an advisory that is tolerated until a date: its id, the reason and the date. An entry past its date fails the job, and so does one that matches nothing any more. It is empty today.
- A package that only the builds or the tests need belongs in `devDependencies`. The last step of the `ci` job installs a production tree (`npm ci --omit=dev`) in a temporary folder and starts the built server from it (`scripts/prod-smoke.mjs`); a run-time import of a dev-only package fails there. It does not build or start the Docker image.

## Changelog

Record a change of behaviour in `CHANGELOG.md` under `## [Unreleased]`, in the section it belongs to (`Added`, `Changed`, `Fixed`, `Security`), as one entry that starts with the area (`server:`, `client:`, `docs:` ...). Upgrade notes go there too (see `MIGRATIONS.md`).

## Pull request

1. Create a branch from `main`.
2. Make the change, with tests where it changes behaviour.
3. Run `npm run check` and `npm test`.
4. Push the branch (to your own fork if you cannot push here) and open a pull request against `main` of `dwebxr/coo-world`.
