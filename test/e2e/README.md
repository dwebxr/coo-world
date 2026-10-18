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
| `token-gate.mjs --engine=<e>` | (a) unverified and (b) signed low balance blocked by panel colliders; (c) raised balance opens locally and crosses; (d) concurrent second context stays blocked; (e) no browser RPC requests or sentinel in served JS/maps; (f) outage fails closed while ticking; (g) admin wallet verification; (h) fresh builder grant, revoke/recheck refusal and signature-free refresh grant |
| `physics-boundary.mjs --engine=<e>` | server/browser physics input probes and native sentinel; contacts, controllers, joints, queries, interpolation, movement, zero-scale survival, contact mutation, deferred removal and static-body availability; `--sentinel-only` runs a base-compatible detection control |
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

## Token gate (local only)

Run `node test/e2e/token-gate.mjs --engine=chromium` (or `webkit` / `firefox`) after the four builds.
Set `PUBLIC_RPC_URL=https://sentinel.invalid/?api-key=E2E_SENTINEL` on the build commands to exercise
the build-time filter, as CI does. The harness sets that sentinel again at runtime, boots a fresh
world on port 3127 (`--port=<n>` overrides), and runs its own loopback JSON-RPC mock. No wallet,
RPC service, production world or real tokens are used. Two isolated browser contexts each get a
seeded tweetnacl wallet before navigation; the real server verifies their signatures.

The fixture creates a static lintel and two kinematic panel rigidbodies. Its gate/animation body
matches the owner-pasted door script; the harness invokes the actual Open action and reads its
sign nodes. Movement uses W for 1.5 simulated seconds and records the position every update:
blocked means z never goes below 0 while reaching within 0.65m of the plane; crossing requires
z < -0.4 while open. Both walks overlap for (c)/(d). The starting point is [30, 2.05, 2], on a
separate fixture floor. The test also checks return to authored panel transforms after auto-close.

Balance changes and outage checks wait 6.5 wall seconds (server TTL 1s + client TTL 5s + margin).
Simulation waits allow 30s plus 30s per simulated second, scaled by `E2E_TIMEOUT_SCALE`; the
whole-suite watchdog is 480s, also scaled. Evaluates/captures default to 5s, cleanup to 10s.
All requests from both contexts are observed throughout; the privacy check runs last and fetches
`/env.js` plus every JS/map in the public and world asset directories, decoding inline maps too.
Console, page errors, server logs, request/RPC counts and movement evidence go to
`token-gate-<engine>-*` in the output directory. Final screenshots are captured only on failure.
Chromium/WebKit are required in CI; Firefox is advisory.

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

## Physics boundary and native sentinel (local only)

After the four builds, with Node **22.11.0**:

```bash
export PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"
node test/e2e/physics-boundary.mjs --engine=chromium
node test/e2e/physics-boundary.mjs --engine=webkit
node test/e2e/physics-boundary.mjs --engine=chromium --sentinel-only
```

The full suite and the candidate subset require **zero violations in each realm**. For the positive
control, build `ea5e8f0` in a separate checkout and point this candidate harness at its build:

```bash
E2E_BUILD_ROOT=/absolute/path/to/ea5e8f0-checkout E2E_OUT_DIR=/tmp/physx-base-e2e node test/e2e/physics-boundary.mjs --engine=chromium --sentinel-only --expect-violations
```

`--expect-violations` is allowed only with `--sentinel-only`; it requires **more than zero violations
on both server and browser**, and still requires all scenario outcomes and clean logs. The subset
uses walking, a falling dynamic prim with contacts/interpolation, and a server raycast with an
explicit distance (base-compatible APIs). Record the actual per-realm counts from the JSON evidence;
never count the synthetic self-test as a native leak. The base run is a reviewer gate, not a CI run
against the candidate with relaxed expectations.

This always boots a new default world on port 3126 (`--port=<n>` overrides). It has no remote URL or
`--world` option and never reads or writes the developer's `world/`. Chromium/WebKit are required in
CI; Firefox is advisory. A parent watchdog tracks/kills the full process tree on completion or a
600-second deadline (360 seconds for `--sentinel-only`). Evaluates, commands, health checks, screenshots and cleanup have bounded waits
(5 seconds per evaluate/capture); all deadlines use `E2E_TIMEOUT_SCALE`. Screenshots are saved only
on failure. Console, page errors, server logs and `physics-boundary-<engine>-results.json` (with a
`-sentinel-only` suffix for the subset) retain counts, poses and scenario evidence.

`native-sentinel.js` enumerates `Reflect.ownKeys` on endowed Enhanced Vector3, stock Vector3
(`Object.getPrototypeOf(new Object3D().position)`), Quaternion, Euler and Matrix4 prototypes. It
preserves descriptors while wrapping string/Symbol data functions and accessor setters (getters are left unwrapped: they return numbers from the THREE instance itself, and wrapping every component read made software-rendered CI browsers too slow),
skips constructors, and checks receiver, arguments and return values for presence of `ptr` inside
`try`. Wrappers store only method/counter metadata and never read components. Before scenarios,
copying a fake native records exactly one violation; chaining, components, iteration and change
callbacks match the unarmed behavior. Disarm restores and checks every original descriptor, also
on failed scenarios. **Revisit this probe for Phase 2 hardening**, when these prototypes become
immutable. Armed runs are excluded from performance comparisons.

The full suite checks:

- Server and client input boundaries: removed helpers; every rigidbody API using Enhanced/stock
  vectors, including own shadowed methods that must never run or receive a native; spoof rejection
  and exact intrinsic Error prototypes/messages inside SES; NaN, ±Infinity and `1e39` no-ops,
  null/empty queries, zero velocity-at-position results; query scalar validation and null infinite
  raycast. Getters return vectors/identity, targets default correctly, controller flags are false
  before moving, and pre-mount teleport works. Impulses are asserted **after a simulation step**.
- Dynamic prim and rigidbody falls, finite contact position/normal/impulse values and at least two
  begin/end cycles with fresh events in both realms. The client node position must follow interpolation.
- Phase 3b-1 `physics-availability.js`, using `probe:command` in both realms: 128 contact begin/end
  cycles replace `event.contacts[0].position` with `{}`; the other recipient's vectors stay finite
  and both retained events remain unchanged. Contact-end and trigger-leave handlers remove body A
  again after its removal, for RigidBody, Prim and Controller: dispatch must be deferred, happen
  exactly once and preserve siblings and parent links, with no stale callbacks after B is removed.
- A static rigidbody gets 2,000 calls **per method** to `getVelocityAtPos`,
  `getLocalVelocityAtLocalPos`, `addForceAtPos` and `addForceAtLocalPos`, each inside try/catch.
  Queries must return zero into the supplied target, forces must leave the static pose unchanged,
  and no call may throw. A positive-but-invalid controller descriptor (`0.01` radius/height)
  must warn exactly once, ignore moves, retain teleport position and unmount safely.
- After **each** availability scenario, a body in the separate `physics-probe` app is lifted,
  observed falling onto its floor and checked again after 0.5 simulated seconds. Both realms must
  advance script updates and physics steps. No `RuntimeError` may appear in either log, and no
  unexpected `scriptError` is allowed. Per-scenario waits include 30 seconds of wall time per
  requested simulated second, additionally scaled by `E2E_TIMEOUT_SCALE`.
- Trigger enter/leave; client/server controller teleport/move; fixed/socket/hinge/distance joints
  between two dynamic bodies, forged-body rejection and constrained separation under opposing
  velocities; server/client raycast and overlapSphere find the far tagged fixture.
- Walk distance > 0.5m and jump rise > 0.3m. Server/local player teleports and pushes work with both
  vector brands and shadowed methods; passing a Quaternion as rotationY still teleports.
- A kinematic prim moves by node transform every frame while the local player stands on it for
  three simulated seconds: position follows the translating/rotating platform and yaw changes.
- A server seat-style anchor effect snaps the local player to the seat; expiry restores native
  simulation and falling. Tab enters build mode, then two separately sampled Space presses attempt
  flight within 0.4 seconds of `world.time`. If rendering misses that window, the player's own
  `toggleFlying(true)` is the R3.3 fallback. Flight and movement remain mandatory; evidence records
  both press samples, their time gap and the method used.
- A geometry collider with constructor `scale: [0, 1, 1]` in both realms: true zero is retained and
  each world keeps ticking. This is a compatibility check, not geometry validity (Phase 3b).

Expected warnOnce messages are matched exactly, including
`[controller] invalid descriptor or failed to create controller` once per realm in the full suite.
The contact mutation, repeated removal and valid static-body calls must emit no warnings.
Intentional brand errors are caught and reported
as structured evidence, not logged as unhandled errors. Unexpected script/physics errors, page
errors, event drops and nonzero candidate sentinel counts fail the run. XR is **review-only**:
inspect PlayerLocal's physical movement conversion and skip behavior with a headset follow-up.

Review coverage: contacts exercise Physics contact copies; falls exercise active-actor pose copies,
interpolation and Prim/RigidBody updates; transforms/platforms exercise actor `move`, platform pose
reads and PlayerLocal sweeps; controllers exercise foot-position conversions; joint mounting covers
all frame conversions; queries cover Physics and Apps boundaries; walking/jumping/flying cover
PlayerLocal velocity/force conversions, and seat/teleport cover anchor/snap conversions. Retain
`fullstack`, `gate-extras`, `ws-frames`, `hostile-transforms` and stress smoke. The orchestrator also
runs the existing copied-world Mob/Skelly, Vanguard, Prism and HoverBoard boot/movement checks and
the five-pair severe physics microbenchmark against `ea5e8f0` (median delta <= 5% or <= 2ms/120 steps).
Do not use sentinel timings for that gate.

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
