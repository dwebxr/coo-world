# End-to-end harness

Browser-driven checks of a built world: the script sandbox, the script editor, movement, uploads,
the AI path, the node-client agent and a performance stress world. They run in CI
(`.github/workflows/e2e.yml`, Chromium/WebKit/Firefox) and locally.

Everything here is `.mjs`, so the unit test glob (`test/**/*.test.js`) never picks it up. Paths are
relative to the repo; nothing reads the developer's `.env`.

## Prerequisites

```bash
export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"
npm ci
npx playwright install --with-deps chromium   # or webkit / firefox
npm run client:build && npm run viewer:build && npm run node-client:build && npm run build
```

The server build must come last: each build empties `build/`.

## Scripts

| script | what it checks |
| --- | --- |
| `fullstack.mjs --engine=<e>` | boots a server on a throwaway `world-e2e-*` directory, runs the sandbox probes over the wire protocol (intrinsic/endowment/stash writes, blob facade, object URL types, error shapes, Stage/Physics containment, the retry cap) and the player-relay checks (a client-sent `playerTeleport`/`playerPush`/`playerSessionAvatar` is dropped and logged once per socket; a server script's calls still reach the target with well-formed payloads) and the chat check (a malformed chat message from a ws client is refused, a valid one is rebuilt server-side, and the history a later browser receives renders as text), then loads the world in the browser: frozen intrinsics, the same probes, `world.open` policy, an image from `createObjectURL`, a throwing script, a client script acting on a remote player (no packet, one log per method) and on its local player (teleport, push, session avatar through the URL policy), and the Monaco editor (colouring, widgets, edit + save, server confirmation) |
| `gate-extras.mjs --engine=<e>` | walk, jump, VRM session avatar, builder uploads (glb/vrm/png), AI create through a mock Anthropic base URL, `agent.mjs` for 60 s |
| `hostile-transforms.mjs --engine=<e>` | loaded remote avatar + hostile self transforms, benign quaternion normalisation, scaled anchors on remote and local players, demoted-mover release, native physics recovery, finite late-join snapshots; parent watchdog kills frozen processes |
| `stress.mjs --engine=<e> [--apps=20 --prims=50 --frames=600] [--monitor]` | 1000 moving nodes; prints per-frame JS mean/median/p90, render commit time and server CPU as JSON and fails on crashes, errors or fewer frames than requested; `--monitor` adds the server tick sampler (`MONITOR_TICK=1`). CI runs it with `--frames=200` as a smoke; the budgets use 600 |

Options: `--port=<n>` picks the server port, `--world=<dir>` copies an existing world (eg the local
multi-app `world/`) instead of the default world that the server bootstraps from `src/world`;
`fullstack.mjs --load-only` boots, loads the world in the browser and runs only the load checks (a
diagnostic mode for an engine that fails to load). Harness waits are multiplied by `E2E_TIMEOUT_SCALE`
(default 3 when `CI` is set, else 1) so slow software-rendered runners do not turn a late event into a
failure. Every run saves `<name>-<engine>-console.log`,
`-page-errors.log` (when any), `-final.png` and the server log under the output directory, also when it
aborts; the console log ends with a `[harness] page state at exit` line (sidebar, world active, WebGL
renderer, harden state).
`E2E_BUILD_ROOT=<dir>` runs another checkout's `build/` (A/B comparisons), `E2E_OUT_DIR=<dir>` moves
the logs and screenshots away from `test/e2e/out/`, and `E2E_<ENGINE>_EXECUTABLE=<path>` pairs the
harness with a specific browser build.

## Hostile transforms (local only)

After the four builds, run with Node **22.11.0**:

```bash
export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"
node test/e2e/hostile-transforms.mjs --engine=chromium
node test/e2e/hostile-transforms.mjs --engine=webkit
```

This suite always boots a fresh default world on port 3125 (`--port=<n>` overrides it). It has no
remote-server URL or `--world` option. Chromium and WebKit are required in CI; Firefox is advisory,
matching the other world suites.

- Waits for the visitor's remote avatar instance, records a valid baseline, then sends each of
  `q: [1e200, 0, 0, 1]`, `q: [0, 0, 0, 0]`, `p: [1e300, 0, 0]`, `p: [1e308, 0, 0]`, with `t: true`.
  Checks the received marker, preserved stored/rendered transforms and finite matrices across
  advancing frames for at least three seconds per payload, plus `/status`, pongs and server update
  progress. A valid modify from the same visitor must work after each rejection.
- A second WireClient must receive `q: [0, 0, 0, 1.0000001]` as exactly `[0, 0, 0, 1]`.
- A builder installs `transform-probe.js` with a 2x anchor rotated 90 degrees about Y. A visitor
  selects/clears it; browser/server poses remain finite and unit length. The browser's remote
  collider remounts at unit scale and the server capsule is raycastable at its original radius.
  A server-script `applyEffect` also anchors the browser's local player; its quaternion stays unit
  length, the effect expires, and its native capsule resumes falling under gravity.
- An admin grants/revokes a mover's builder rank through `modifyRank`. A demoted mover's release
  drops a zero scale and changed position, retains the previous transform and rebuilds a finite
  native rigidbody. Re-granting builder rank permits a subsequent valid move/release.
- A late joiner's snapshot must include the probe apps and visitor, with finite positions,
  unit quaternions and valid app scales for every player/app.

The parent watchdog runs outside the test worker, checks its process tree (POSIX `ps`, macOS/Linux),
and kills the worker, server, browser and renderer descendants on deadline or completion. The total
deadline is 240 seconds; each `page.evaluate`, screenshot and cleanup operation has a separate
deadline (5 seconds for evaluate/capture, 10 for cleanup). These deadlines use `E2E_TIMEOUT_SCALE`.
A timeout fails the suite even if a screenshot cannot be taken. Browser/server logs and
`hostile-transforms-<engine>-results.json` contain the pose/frame evidence; deadline failures also
write `-watchdog.log`. The exact LooseOctree/SnapOctree parking warnings are expected diagnostics;
script/physics failures and uncaught page errors are failures. Review the 11 passing checks in each
required engine and verify there are no surviving harness processes after a forced timeout.

Do **not** replay hostile payloads in production. Production smoke is ordinary anonymous join,
movement observed by a second socket, late join, disconnect, and only the benign normalisation probe.

## Budgets (performance, enforced on a designated machine, not in CI)

Alternating head/candidate pairs of `stress.mjs` (5 pairs, >= 600 frames each; headless Chromium
clamps `performance.now()` to 0.1 ms, so compare the means as well as the medians):

- client: JS mean/median <= head x 1.15 and <= head + 0.3 ms; JS p90 <= head x 1.20; commit <= head + 0.2 ms
- server (`--monitor`): tick median <= head + 1.0 ms (absolute bound only, no ratio); CPU <= head + 1 pp
- cumulative against the pre-sandbox baseline: JS mean <= x 1.25 and <= +0.5 ms, p90 <= x 1.30, commit <= +0.3 ms, tick median <= +1.5 ms (absolute only), CPU <= +2 pp

## Probe apps (`apps/`)

Small scripts installed as app blueprints during a run. `crasher.js`, `stage-crash.js`,
`physics-crash.js` and `throwing.js` are meant to crash (alone); `retry-probe.js` patches a shared
prototype on purpose to exercise the host-node retry cap; `relay-probe.js` teleports, pushes and re-skins a
player from the server and, on a client, from a script acting on a remote and on its local player. None of
them touches the network except `sandbox-probe.js` / `open-probe.js`, which fetch from the server under
test.
