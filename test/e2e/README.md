# End-to-end harness

Browser-driven checks of a built world: the script sandbox, the script editor, movement, uploads,
the AI path, the node-client agent and a performance stress world. They run in CI
(`.github/workflows/e2e.yml`, Chromium/WebKit/Firefox) and locally.

Everything here is `.mjs`, so the unit test glob (`test/**/*.test.js`) never picks it up. Paths are
relative to the repo; nothing reads the developer's `.env`.

## Prerequisites

```bash
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
