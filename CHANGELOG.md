# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- client: lip sync. A remote player's voice loudness opens their avatar's mouth (the first VRM mouth preset among aa/oh/ou/ih/ee), measured on a listen-only WebAudio branch beside playback and smoothed (60 ms attack, 120 ms release). Mouths close for moderator mute, a disabled voice, a suspended AudioContext or beyond 20 m. Each avatar instance writes its own clone's morphs, so players sharing an avatar never mirror each other. Settings › Audio › Lip Sync, on by default on desktop and off on touch devices. Nothing is sent over the network; protocol and server are unchanged.
- tests: token gate E2E uses signed mock wallets and SPL account RPC responses to check local door collisions, wallet/admin and builder flows, outage recovery, and RPC credential isolation in Chromium/WebKit (Firefox advisory).
- apps: client-local `player.getTokenBalance()` and the protected `wallet` event expose verified COO balances to world scripts; reads are cached and local gates affect only the player’s own screen.
- server: per-socket wallet verification, signature-free builder rechecks, and one shared balance service with fresh-only grants and bounded requests.
- tests: Phase 3b-1 real-PhysX availability regressions and server/browser E2E probes cover contact mutation, deferred removal and repeated static-body calls, with independent falling-body and tick checks.
- tests: Phase 3 physics boundary probes and a descriptor-preserving native sentinel run on the server and browser (Chromium/WebKit required; Firefox advisory). A base-compatible `--sentinel-only --expect-violations` control proves detection on `ea5e8f0`; see the e2e README.
- core: `MONITOR_TICK=1` logs a per-minute summary of server tick times (mean/median/p90/max) and exposes the last window on `/status`
- ci: an end-to-end Playwright job (`test/e2e/`, Chromium/WebKit/Firefox) runs on pull requests and on demand
- server: upload rate limits and quotas (`UPLOAD_*` envs): per-user and global concurrency, per-minute rates and daily byte quotas per user and per address, a shared daily budget for users without a stored or wallet-verified builder rank (wallet-granted builders are limited per wallet, and a slot of the total is kept for stored-rank users), a transfer deadline per admitted upload, and a free-space floor for local assets. Refusals answer `429`/`503`/`507` with `Retry-After`. Compressed upload bodies are refused (`415`); overlapping uploads of the same content are stored and charged once.
- client: uploads run one at a time per tab, retry once on a short `Retry-After`, time out, and a failed `.hyp` import cancels its remaining uploads.
- server: connection limits for `/ws`: per address, a burst of 20, a sustained rate of 10/min and 8 concurrent connections (`WS_CONNECT_*` envs); IPv6 parents have `WS_CONNECT_CONCURRENT_PER_56=16` and `WS_CONNECT_CONCURRENT_PER_48=32`, and `WS_MAX_SOCKETS=64` caps all transports until TCP closes, including closing sockets. Refused upgrades receive HTTP 503 with `Retry-After: 10` before any database lookup. Raising or disabling `WS_MAX_SOCKETS` raises or removes the default 64 MiB total write-backlog bound.

### Changed
- physics: values that PhysX treats as invalid never reach it (Phase 3b-2a). A builder script could hand PhysX a denormal mass, a far controller position, a zero kinematic quaternion or a mesh whose real vertices are far larger than its file claims, and the shared scene's other bodies turned NaN; an invalid cone or hinge limit, a zero joint frame, a far centre of mass or an extreme push turned the body itself or its jointed bodies NaN. Lengths (box half-extents, sphere radii, controller radius/height), mesh scale axes, mesh extents (from the scanned vertices, never the file's bounding box) and positions must be inside 1e-6…1e6; geometries must pass `PxGeometryQuery.isValid`; a node that fails skips its physics (the visual stays) with one warning per node and reason, and a skipped Collider no longer re-cooks on every move and mounts once a setter fixes the value. Setters reject NaN, ±Infinity and negative lengths, frictions and restitutions, and a positive mass below 1e-9 (0 stays PhysX's infinite mass); a zero radius or size is accepted and skipped at mount. `setQuaternion` and `setKinematicTarget` normalise their quaternion (a zero or denormal one is ignored); `addForce`, `addForceAtPos`, `addForceAtLocalPos` and `addTorque` ignore a push whose velocity change is not finite in float32; a controller ignores a teleport or move outside the window and gets no controller when mounted outside it. Joints normalise frame rotations (a zero one skips the joint), apply a cone only when PhysX accepts it, a hinge limit only when ordered and inside ±360°, each distance end only when set, a spring only when finite and ≥ 0, and treat a NaN or negative break force as unbreakable. Prim `layer` takes the same four names as Collider and Controller (and scripts cannot pick `player`), and the `Joint.type` setter compares and reports the value.
- deps: security refresh of the lockfile (`npm audit fix`, no `--force`) and `@fastify/static` 8 → 10. Notable: fastify 5.2.0 → 5.12.7, ses 1.10.0 → 1.15.0 (a Compartment can no longer read the host's top-level `const`/`let`/`class` bindings), @fastify/busboy 3.1.0 → 3.2.4 (multipart DoS fixes), jws 3.2.3, fast-uri 3.1.9, @fastify/proxy-addr in place of proxy-addr, and fast-xml-parser gone from the tree. The unused `@fastify/multipart` dependency is removed. `npm audit` drops from 56 advisories (2 critical, 22 high) to 10 (3 high), all in the Solana client libraries or the esbuild dev server and not reachable here. Static responses keep the same headers: `Cache-Control: public, max-age=0` as before, because send used to overwrite the values `setHeaders` set (static 10 lets them through, so those lines are removed).
- apps: reading a name that a script never defined now gives `undefined` instead of throwing a `ReferenceError` (ses 1.12 makes the scope proxy opaque). Assigning to one still throws. None of the production world's scripts reads an undefined name.
- server: non-canonical static paths (`//x`, `/./x`, `/a/../x`) are refused with 403, and `/%61ssets/…` is no longer served as `/assets/…`. The root error handler now keeps a 4xx status and the error's headers (for example 400 invalid JSON, 413, 415 for a Brotli body, 403, 416 with Content-Range) and logs one line without a stack or query string; other errors are still logged with their stack and answered 500. @fastify/static 10 also answers 403 when it cannot list a static directory (EIO, EMFILE), so a run of `[http] 403` lines on ordinary paths points to a storage fault. The server refuses to start when `ASSETS_BASE_URL` ends with `/`, since asset paths would become `//name`.
- server: server-side `fetch` never decodes Brotli. A wrapper around undici's global dispatcher (installed right after the SES lockdown, before any repo module runs) removes `br` and `*` from every request's Accept-Encoding and refuses any response whose Content-Encoding contains `br` before fetch creates a decoder, including redirect targets. This covers app scripts' `fetch`, remote models and scripts loaded by the server, GLTF subresources and the AI and RPC clients (CVE-2026-111497 defence in depth). A Brotli-only server now fails a server-side fetch; browsers are unaffected. An explicit `Content-Encoding: identity` request body is accepted again.
- server: request bodies are decompressed only from gzip and deflate; a `Content-Encoding: br` request is refused before any decoding. No client sends compressed bodies, and this keeps unauthenticated input away from the Brotli decoder (CVE-2026-111497 defence in depth; Node 22.23.4 already carries the fix). Responses are still Brotli-compressed. The Docker image upgrades the system `brotli-libs` (used by the healthcheck's curl) to 1.2.1.
- server: Node.js 22.11.0 → 22.23.4 (Docker image, `.nvmrc`, engines), picking up the October 2026 security release and the seven earlier 22.x security releases since 22.11.0. Relevant here: the Brotli decoder out-of-bounds write (CVE-2026-111497, reachable through server-side `app.fetch` of an attacker-controlled `br` response), the TLS hostname-verification bypasses for outbound HTTPS (CVE-2026-106069, CVE-2026-106072), keep-alive response confusion (CVE-2026-105481), and the undici, OpenSSL, c-ares and CA store updates. Same major and module ABI (127), so native modules are unchanged.
- network: wallet status and balance packets are appended to the packet table (`walletStatus`, `tokenBalanceRequest`, `tokenBalance`, `requestBuilderRecheck`); existing ids and the protocol version (`v=2`) are unchanged, so existing node agents keep working. Release B uses a Sign-In-With-Solana (SIWS) challenge with the configured domain/origin, a 64-character hex nonce, issued/60-second expiration timestamps and a 1024-byte cap; deploy the server and client wallet changes together. Tabs opened before the update cannot verify a wallet until they reload.
- client: the wallet panel separates verification, server-read COO balance and build permission, with a script-exposure notice. Connect signs the server message once; refresh needs no signature. Attempts cancel safely on disconnect and bound nonce/ack waits to 15 seconds. Browsers no longer receive `PUBLIC_RPC_URL`; operators should use server-only `SOLANA_RPC_URL` and rotate previously exposed keys.
- physics (Phase 3b-1): contact and trigger callbacks receive fresh event objects per recipient, including independent contact arrays and vectors; events are no longer shared or reused and remain valid when retained. Synthetic contact-end and trigger-leave events caused by removal run at the next physics step, before simulation; removed, remounted or rebuilt recipients are skipped. Native callbacks contain thrown values before returning to PhysX.
- physics (Phase 3b-1): a crash stops the owning app's script and timers immediately, with one deferred crash rebuild per run. Latched API calls report that the app has stopped; only a native trap uses the physics-failure message. During destroy dispatch, world/app reads, app.send/sendTo, world.off/app.off and world.remove of owned nodes remain available for cleanup; native queries, creation and other native-capable calls remain blocked. A separate, script-free simulation health probe checks PhysX after a trap. An unusable module or an interrupted main-scene step stops the world; the server refuses mutations, attempts a final save under one five-second deadline (including in-flight saves and pending changes to loaded settings/spawn), logs unsaved records and exits with code 1 for an on-failure process restart. Clients stop ticking and show a reload error. A successful probe does not certify geometry correctness.
- server: persisted blueprints use the network blueprint policy at startup, including stripping unknown fields. App transforms are repaired in memory where possible; unusable blueprint/app rows are skipped with a boot summary and remain untouched in the database. Repairs are saved only after an explicit edit. With `CLEAN=true`, all reference discovery (including persisted skipped rows, nested assets, settings and users) finishes before deletion; malformed discovery data skips all cleaning for that boot.
- physics (sandbox Phase 3): PhysX conversions are host-private and copy primitive numbers. Native wrappers no longer enter script-accessible THREE methods, and the late PhysX prototype installation is removed. Scripts that directly accessed `toPxVec3`, `toPxExtVec3`, `fromPxVec3` or `toPxTransform` (none known in production) now get `undefined`.
- apps: physics vector inputs and output targets accept both endowed and stock THREE instances; duck-typed lookalikes throw intrinsic errors. Non-finite/float32-overflow vectors and quaternions cause mutators to do nothing, raycasts to return `null`, overlaps to return `[]`, and velocity-at-position queries to return zero; each invalid-input case warns once. Native failures reached synchronously through node proxies are rethrown as intrinsic errors.
- apps: raycast distance accepts zero and Infinity; omitted/null distance means infinite. Query masks default to unfiltered `0` for omitted/null, otherwise accept integer signed/unsigned 32-bit masks. Overlap radii must remain finite and positive in float32. Scalar setters beyond these query arguments remain outside Phase 3.
- physics: captured Enhanced vector output setters notify dirty tracking once rather than the three callbacks from the old component-by-component helper. Node transforms still re-commit.
- network: shared player/app positions and spawn positions are bounded per component to `TRANSFORM_LIMIT = 1e6` metres (inclusive). Player movement axis/gaze components use the same bound. Quaternions with norm within 0.1 of 1 are normalised; other rotations are dropped. App scale components must remain finite and non-zero when converted to f32 (including `1e-9`; no `1e6` scale cap). Invalid stored spawn data falls back to the default; invalid spawn changes are refused. This transform hotfix makes no additional protocol change; out-of-range values from any client are dropped. Local movement can still leave the shared world extent, but observers retain the last in-range position.
- apps: teleport positions are limited to `1e6` per component and server-to-client push relays to `1e4` per component; non-finite/out-of-range packets are ignored. Local script teleport uses the same check; direct local script push bypasses the relay bound. Local effects consume only finite `snare` in `[0, 1]`, boolean `turn`, and a valid string emote URL; invalid values are ignored. Falsy `duration` values (`0`, `''`, `null`, `undefined`, `NaN` or `false`) mean no expiry; other values count down as `Number(duration) - delta`, storing positive remaining time or ending the effect otherwise. Negative or non-numeric truthy durations end on the next frame, numeric strings expire after that many seconds, and `Infinity` never expires. Network `anchorId` must be a string of at most 128 characters. Emote speed `s` must parse to a finite number in `[0.01, 100]`, otherwise it defaults to 1; `l`/`g` flags are unchanged.
- [BREAKING] network: the protocol is now `v=2`. Old tabs receive the `outdated` kick and must reload; node clients must be rebuilt (`npm run node-client:build`) and restarted.
- [BREAKING] apps: client `app.send` uses plain MessagePack: string-keyed Maps become objects, Sets become arrays, Errors become `[name, message, cause]`, RegExps become `[source, flags]`, functions become `undefined`, and numeric typed arrays other than `Uint8Array` lose their type and can change bytes. Dates and Maps with non-string keys are refused; Symbols, BigInts outside the signed/unsigned 64-bit range, BigInt typed arrays, cycles and objects with more than 65,535 keys throw in the sender. Repeated object references become independent copies and `-0` becomes `0`. See [app.send](docs/scripting/app/App.md#sendname-data-skipnetworkid) for the full behaviour table.
- apps: client `app.send` returns `false` when the packet does not fit its byte, node or format limits. Server `app.send` and `sendTo` return `false` when output exceeds the packet or script tick budget, or a recipient is too far behind; a broadcast can still reach other recipients. Script chat bodies must be text; numbers are converted and other values are refused. At high rates, send deltas rather than full state (about 32k decoded nodes/s per connection).
- client: a blueprint, including its props, must fit in a 64 KiB message. Oversized edits show a toast before local mutation or upload; client and server apply the same blueprint policy.
- server: IPv6 parent rate buckets now cap /56 churn at burst 40 and 20/min, and /48 churn at burst 80 and 40/min (`WS_CONNECT_RATE_PER_MIN_56`, `WS_CONNECT_BURST_56`, `WS_CONNECT_RATE_PER_MIN_48`, `WS_CONNECT_BURST_48`). Either value set to 0 disables that parent bucket. Refusals charge no buckets; addresses and parents share the bounded idle-purged table.
- server: world blueprints share a 512 KiB encoded budget (`WORLD_BLUEPRINT_BYTES`). Over-budget adds remove the optimistic entity; modifications receive a rate-limited revert. Existing worlds above budget load with a warning and can still shrink. Builders should keep large text out of props because the whole world must fit in about 1 MiB for joins.
- [BREAKING] apps: scripts now run under real SES hardening. The built-in prototypes (`Object.prototype`, `Array.prototype`, `Math`, ...) are frozen and every endowed global (`Vector3`, `console`, `num`, ...) is read-only: assigning to one throws a `TypeError` inside the offending script. Each script asset runs in its own compartment, so nothing a script puts on its `globalThis` is visible to another app.
- [BREAKING] apps: `fetch().blob()` returns a script-safe blob (`size`, `type`, `arrayBuffer()`, `text()`, `slice()`) instead of a DOM `Blob`: `stream()`/`bytes()` are gone and `instanceof Blob` is false. `URL.createObjectURL` accepts only these blobs and serves them with an allow-listed media type (images/audio/video/models) or `application/octet-stream`. `fetch()` options are limited to `method`, `headers`, `body`, `mode`, `credentials`, `cache` and `redirect`.
- [BREAKING] apps: `world.open()` opens `http(s)` URLs only, never `javascript:`/`data:`/`blob:` URLs or files from the world's `/assets/` store (percent-encoded spellings included); a scheme-less `host:port/path` is rejected as well (use `http://host:port/path`); new tabs are opened with `noopener,noreferrer`.
- apps: errors raised inside `world.*`/`app.*` methods, `world.load()` and response readers reach scripts as fresh built-in errors of the matching class (`instanceof TypeError` etc. still holds) carrying `name`, `message` and `stack` only: no `cause`, no extra properties, no custom-class identity.
- apps: `Math.random()` has always been available to scripts; the Utils docs now say so.
- core: a node whose transform update throws (eg a script put a non-number into its own transform) now crashes its app instead of stalling the whole world; non-app nodes are retried up to 10 times, then left alone until written again. Until the shared THREE prototypes are hardened (follow-up), a failure in one app may still be caused by another app's prototype patch.
- [BREAKING] apps: `player.teleport()`, `player.push()` and `player.setSessionAvatar()` act on another player from server scripts only. A client script calling one of them on a remote player does nothing (logged once per app, player and method), and the server no longer relays these packets between clients; a client that still sends one has it dropped (logged once per connection and packet). Calls on the local player keep working; they now go through the same payload checks as a server-sent packet (finite numbers; a `rotationY` that is not a number is ignored; an avatar URL that fails the policy is ignored; `null`, `undefined` or `''` clears a session avatar).
- apps/client: an avatar URL set by a client must be an `asset://<name>.vrm` or an `http(s)://` URL of up to 512 characters, whether it is a session avatar (`setSessionAvatar`, the `avatar` connection parameter) or the equipped avatar; other values (`data:`, `blob:`, `javascript:`, ...) are ignored. `null` still clears a session avatar. The client also checks the teleport, push and session-avatar packets it receives from the server before applying them (finite numbers; a `rotationY` that is not a number is ignored).
- server: a client message over 64 KiB closes the connection (1009). `entityEvent`, `blueprintAdded`, `blueprintModified` and `ai` are capped at 64 KiB; blueprint and AI packets are builder-only, and other packets are capped at 32 KiB. Each connection has a 2048-unit bucket refilled at 1024 units/s, charging one unit plus one per full 2 KiB and one per 32 scanned nodes, including failed scans. Admission refusals are counted and logged once per kind without closing the socket.
- server: a strict plain-msgpack decoder counts nodes at admission and builds values at flush; malformed packets, unsupported extensions and trailing bytes are refused without logging content. Fair per-socket scheduling spends at most 9,216 work units per tick (`nodes + floor(bytes / 128)`), with up to about 2 s until service under a full flood at the default 64 slots. Each inbox has a 160 KiB reserve and can grow to 1 MiB from a 16 MiB shared pool.
- server: output is capped at 512 KiB per packet and 1 MiB of accounted backlog per client. The initial snapshot has its own cap of 1 MiB minus 1 KiB write overhead, with a once-per-process warning above 50%. Scripts share 512 KiB of unique output bytes per tick and skip recipients whose backlog would exceed 512 KiB; a system write that would exceed the 1 MiB cap disconnects that client. An oversized packet is refused without disconnecting recipients.
- apps: rebuild queues keep at most 64 events, with server byte/node caps per app and a shared ledger. Only a builder's next-version events may wait for an unannounced blueprint, for up to 60 seconds and within per-socket and shared budgets; delivery requires the same socket to author that version. Budget pressure drops the app's own oldest events, disconnects release reservations, and listener errors are contained.
- apps/client: the emote other players load for a player (`applyEffect({ emote })`) must be an `asset://<name>.glb` (with an optional playback query) or an `http(s)://` url of up to 512 characters; any other value shows to other players as no emote. The local effect reader now checks the same URL policy before playback and locomotion selection.
- server: a chat message's id is always minted by the server (a client-chosen id is ignored), the 500-character cut no longer splits an emoji or another grapheme, the sender's own echo goes through the same trim and cut as everyone else's copy, and a malformed chat message is logged once per connection.
- server: `/server stats` answers builders only.

### Fixed
- physics: static rigidbodies return zero from velocity-at-position queries and ignore force-at-position calls without entering dynamic-body native functions. Invalid controller descriptors and failed controller allocation leave physics disabled with one warning; teleport still updates the node position. Query spheres reuse one native geometry; the material cache uses unambiguous keys and is capped at 4096 entries, falling back to the default material with a bounded warning at the cap or on allocation failure.
- server: `Server.tick` keeps running after ordinary exceptions, with bounded diagnostics, and never re-arms after shutdown. Fatal physics failures stop the current tick and later tick entry.
- server: revisioned, serialized saves fix a pre-existing lost-edit race when an edit or deletion arrives during an in-flight write. Saves retain the latest settled app record during moves/uploads, record deletions before teardown, and exclude script state before cloning or serialization. The fatal flush includes the latest settings and spawn values within its shared deadline.
- physics: joints work again with genuine rigidbody proxies; forged body references throw. Fixed/socket/hinge/distance joints are covered between two dynamic bodies.
- apps: `getAngularVelocity` returns its vector; `getQuaternion` without an actor returns `(0,0,0,1)`; velocity-at-position getters default their output target. `addForceAtPos`/`addForceAtLocalPos` now forward the requested force mode (scripts passing `impulse` now receive impulse behavior); mode lookup ignores inherited keys. Corrected the position/torque argument messages in `addForceAtPos`, `addForceAtLocalPos`, `addTorque` and `getLocalVelocityAtLocalPos`.
- apps: controller teleport before mount sets the future mount position without throwing; grounded/ceiling flags before the first move are false. Raycasts with a null max distance now reach distant objects. Invalid local player teleports are atomic; direct local pushes reject non-finite components while retaining the existing relay-bound distinction.
- physics: mesh cooking packs decoded XYZ attributes into correctly sized host buffers, handles normalized/interleaved attributes and index widths, refreshes heap views after allocation, and cleans up failed allocations/cooks. Failed native mesh/shape handles are neither cached nor dereferenced; failed shape creation releases newly acquired resources, including Prim's unregistered actor.
- network: a mover who has lost builder rank may only release its own move/upload; transforms, state and other non-release fields are dropped, retaining the last accepted app transform.
- core: scaled anchors yield finite, normalised player poses on both local and remote players; invalid/singular anchor matrices leave the previous pose unchanged. LooseOctree and SnapOctree park non-finite or out-of-budget items without growing the tree beyond its `1e8` root-size budget. Parked items still render, cannot be picked through the octree, and recover on a valid move. Image picking now follows transform changes, including recovery from parking.
- particles: distance emission is capped at 1000 attempts per update, with accumulated remainder cleared on a cap or non-finite arithmetic. Invalid/negative `rateOverDistance` assignments are ignored.
- server: aborted or failed connection setup cleans up its player and socket state; handler and refusal logs contain bounded metadata only.
- core: blueprint and app entity changes are announced before applying them, so events from a synchronous cached rebuild follow the announcement; optimistic upload rebuilds retain the bounded next-version window.
- core: event versions must be non-negative safe integers; fractional future versions cannot bypass builder-only event reservations. Blueprint arrays retain undefined slots as null, policy refusals show a toast, and script sends consistently return false on refusal. Engine player cleanup uses system output; late packets are logged as disconnected.
- apps: `player.setSessionAvatar()` called from a client script on a remote player cleared that player's avatar instead of changing it (the relayed packet had the wrong shape); the remote path is now server-only (see Changed).
- server: a chat message from a client is rebuilt from its text only (trimmed, up to 500 characters; sender and time stamped by the server). A message whose body was not text used to stay in the history and break the chat list of every client that joined afterwards; it is now refused. The client also skips a non-text body when rendering or showing a bubble.
- server: a flood of `entityEvent` packets could grow the heap without bound: every packet was decoded on arrival whatever its size, an app queued events without limit while it rebuilt, one event with a far-future blueprint version at the head of that queue held back every later event for ever, and a `NaN` or `Infinity` version passed the type check. All four are closed (see Changed).
- apps: `setSessionAvatar('')` on the local player clears the session avatar again, as it did before the avatar URL policy.

### Still open
- Phase 2: mutable THREE prototypes and method shadowing with host (non-native) arguments remain, including interpolation, query/player getters and transitive matrix decomposition. Shared query vectors and live temporary output vectors remain script-reachable. This is not class hardening or instance sealing; the sentinel must be revisited when prototypes are hardened.
- Phase 3b-2b (before Phase 2): native allocation/remount leaks (including per-frame same-value rebuilds), mesh index range/count/budget checks, exception-safe ownership/registration, failed-state retry on transform and scale edits, and the unbounded Prim geometry cache keyed by size ratios remain open. Healthy physics shapes still do not resize on later scale edits.
- Persisted app repair and finite float32 checks at converted PhysX pose boundaries do not validate arbitrary script-composed transforms or every geometry. Prim's client visual caches remain unbounded. The player-transform hotfix already closed the octree expansion hang.
- Pending asynchronous native continuations after fatal shutdown remain a Phase 3b-1 residual; stopping ticks is not a global cancellation of native work. Generation-bound physics capabilities and a full teardown transaction are deferred. Emscripten abort state requires a restart; the dormant `prim-physics-test` example's direct PHYSX usage remains a follow-up. XR physical movement requires code review/headset verification.
- Visitor-supplied avatar/emote assets can still contain invalid/extreme numeric data and corrupt that player's avatar, bones, nametag or bubble. Octree parking prevents those bounds from hanging the tree; it does not repair the asset. Asset numeric validation and an avatar fallback/cache lifecycle remain follow-ups. Voice positioning uses the validated player base transform rather than avatar bones.
- Shared positions beyond `1e6` per component are not broadcast; local movement is not constrained or corrected by this hotfix.

## [v0.16.0]

### Added
- core: support for AI and AI generated apps via ChatGPT, Grok, Gemini etc (see .env)
- core: env for cleaning up old blueprints and assets on launch (CLEAN=true)
- core: support for remote databases
- core: added safemode for rare case an app plays up
- core: XR/VR improvements to physical movement, snap turn etc
- core: XR/VR building basics
- apps: support for `prim` shapes and optimizations to support thousands of unique primitive shapes at once
- apps: support for applying physics force to push players (player.push(force))
- apps: event.isLocalPlayer added to physics events onTriggerEnter and onTriggerLeave
- apps: new `animate` event to help only animating apps nearby (distance based). 

### Changed
- core: more boot logs for brevity
- core: fix not being able to see chat text selection
- [BREAKING] core: apps now remain active while being moved in edit mode by default, disable with app.resetOnMove=true or check at runtime with app.isMoving. existing apps that use world space nodes will likely need to update their code.
- core: improved AO to look slightly more natural
- core: when creating nodes you can now also use Vector3 instances if needed, instead of requiring plain old arrays
- core: support alt key in numeric inputs for small steps
- core: support backquote (`) to toggle pointer lock


### Fixed
- core: safely capture errors during app update calls
- core: ensure code editor syncs correctly over multiplayer if both editors have the code window open and one hits save
- core: nested kinematic rigidbody physics not updating correctly outside fixedUpdate
- core: fix false disconnects that keep happening on some worlds (ping-pong related)

## [v0.15.0]

### Added
- core: improved chat UX on mobile
- core: new smooth movement animations and locomotion
- core: introduce gaze based head tracking
- core: add voice chat options to world menu (disabled, spatial, or global)
- core: player list menu + builder toggle, teleport, mute/unmute and kick moderation tools
- core: add option to allow visitors to equip custom avatars (vrm)
- core: new backup script for automated world backups
- apps: file field shortcuts (eg `type:image` instead of `type:file kind:image`)

### Changed
- core: touch and ui pointer handling improvements
- core: avatar distance based rate now amortized and faster
- core: script window now scales with UI scale setting
- core: show app name in script window for brevity
- core: buffered interpolation of networked players to reduce jitter
- apps: calling world.chat(msg) automatically assigns `id` and `createdAt` values if not provided
- docs: restructure and improvements

### Fixed
- core: nametag transparency ordering issues
- core: dont show free-build toggle 
- apps: UIImage explicit width and height
- apps: touch device pointer coordinates incorrect
- apps: fix particles orbital velocity in local space

## [v0.14.0]

### Added
- core: ambient occlusion
- core: new scene app format
- core: touch device joystick UI
- core: new camera-facing character controls
- core: first-person support
- apps: ability to read/write browser url params
- apps: ability to make avatar nodes invisible (.visible)

### Changed
- core: apps list updates when others add/remove apps
- core: reduced reticle size
- core: fog is now radial distance based
- core: don't preload apps that are disabled
- core: sleeker sidebar UI

### Fixed
- core: shift clicking file fields to download
- core: fix weird transparency ordering issues
- core: improve touch device chat UX

## [v0.13.0]

### Added
- core: new loading screen and world image settings
- core: open graph tag support + add to homescreen
- core: vr controller interaction button support
- core: experimental terrain (splatmaps) support
- core: show reconnect button when disconnected
- apps: support control.hideReticle() useful for vehicles etc

### Changed
- core: reduce default shadow quality on mobile/vr devices
- core: Z toggles all UI including apps
- core: reduced docker image size using multi-stage builds
- core: skysphere only move with player horizontally, not vertically
- core: increase mobile joystick threshold for running
- core: improved vr billboarding to look more natural
- core: update action button ui to match core ui
- core: only apply emote throttling to remote players, local players now 60fps
- core: set vr target framerate to 72Hz
- core: more accurately detect touch devices
- apps: mesh.visible disables render but maintains raycastability

### Fixed
- core: reduce minimum vrm height to support smaller avatars
- apps: skinnedmesh bone handle remounting

## [v0.12.0]

### Added
- core: add toggle to completely disable an app but keep it in the world
- core: add scale gizmo (3)
- core: add shift to scale in build mode
- core: add ui v3
- core: add initial app collection
- core: node-client support for running the client in a nodejs environment
- apps: experimental app.keepActive=true to keep apps executing while being moved
- apps: add audio.setPlaybackRate to control pitch
- apps: add image node
- apps: add `pivot` option to video node
- apps: add video.onLoad, video.loading, video.time, video.duration properties
- apps: inject `prng` utility
- apps: add material.fog option to allow meshes to opt-out of being effected by fog (eg skyboxes)
- apps: add skinnedmesh.getBone(name) with ability to read AND write bone transforms
- apps: add lod.scaleAware property (enabled by default)
- misc: simple blender addon

### Changed
- core: improve audio smoothing, less crackle
- core: cache and reuse physics materials, reduces memory usage
- core: reinstate production builds, shave off ~5MB of bundle size
- core: move stats to top right of screen
- apps: support bigStep option on number props (shift + up/down in input)

### Fixed
- core: correct video color space
- core: prevent chat opening up when hitting enter in an app prop input
- core: fix edge case where colliders cannot be generated for some meshes
- core: fix shift-click file props to download not working
- core: fix ctrl+R to reload the page duplicating objects when in build mode
- core: remove docker exit 0 hack and correctly exit during builds
- apps: fix initial lod not being set correctly when cloning

## [v0.11.0]

### Added
- core: add title and description fields to world menu to change tab title and shared links
- core: add fullscreen button for support devices
- core: add player limit option to world menu
- core: voice chat and speaking emotes while using voice chat
- core: improve mobile UI with jump and interact buttons
- core: improve billboarding for chat bubbles, nametags, particles etc across desktop, mobile and vr
- apps: support for skinned meshes and skinned mesh animations
- apps: support for listening to slash commands on server and client
- apps: add video node
- apps: add screensharing support to video node
- apps: add particles node
- apps: add ui scaler option to keep ui screen-sized while in world-space

### Changed
- core: limit camera zoom to 8m
- core: upgraded to latest react and added node polyfills
- core: when anchored, player capsule physics are now disabled
- core: fix audio not unlocks on meta quest 3
- core: decrease default shadow setting on mobile from high to medium

### Fixed
- core: fix environment model not loading/simulating on server
- core: fix rigidbody center of mass, linear velocity and angular velocity not working
- core: fix highspeed anchor jittering
- core: fix geometry used for both convex and non-convex not working
- apps: ui remount not triggering redraw
- apps: player enter event happened before you could access the player details

## [v0.10.0]

### Added
- core: new streamlined user interface
- core: grayscale overlay when disconnected
- core: new world menu for admins to change world environment, default avatar, spawns etc
- core: new gizmo for fine-grained builder controls
- apps: controller support for tag, contacts and layers
- apps: support for interleaved buffer geometry
- apps: geometry handles
- apps: Math globals
- apps: player.local boolean
- apps: ui margin and padding per side
- apps: apps can now redirect to a url or open in a new tab 
- apps: ability to load models from a url on the fly
- apps: node.get(id) to find matches inside any node hierarchy
- core: new mod/plugin hooks (experimental)
- core: added ping time to /stats

### Changed
- apps: uiimage node stability and docs
- apps: ui absolue positioning and flex additions

### Fixed
- apps: ui gap size not correct
- core: vr button not working
- core: octree issues with tiny objects, improves memory usage
- core: fix audio unmount issues
- core: equipping one vrm while one is already uploading (race condition)

## [v0.9.0]

### Added
- core: standalone viewer/clients
- apps: add world.getPlayers() to list all players in the world
- apps: screen-space UI 
- core: add player health
- apps: support world.overlapSphere queries
- core: player to player collision (optional, disabled by default)
- apps: player.push(force)
- core: support ctrl+z to undo added, moved and removed apps
- core: build mode right click with mouse to inspect
- apps: new "buttons" prop
- apps: app.sendTo(playerId, name, data) available on server
- apps: node.children array of all child nodes
- apps: uiimage.src support asset urls from props
- apps: emit an app.on('destroy', cb) event that is run right before an app is destroyed/restarted
- apps: add player.isAdmin for securely checking if a player is an admin

### Changed
- apps: support webp image props
- infra: pipe all client variables through initial server snapshot
- core: preload local avatar and movement emotes before entering the world
- apps: ui borderRadius use arcs instead of quadratic curves
- apps: player effects moved to player.applyEffect (BREAKING CHANGE)
- core: use more memory efficient app proxies
- core: support custom app runtime method injection
- core: show red reticle when in build mode for clarity
- apps: unify player.id/userId/networkId etc as player.id

### Fixed
- core: avatar feet too far above ground
- core: fix esm module bundling
- apps: anchors positions behind by one frame
- apps: ui canvas using incorrect color space
- apps: ensure control.camera initial values are accurate
- apps: exporting app with emojis in props broken
- apps: ui pointer events were not accurate
- apps: ensure player enter event is emitted after they receive snapshot
- apps: ui gap value not correctly multiplied by resolution

## [v0.8.1]

### Fixed
- apps: effects cancel bug

## [v0.8.0]

### Added
- apps: stable effects system via control

### Changed
- core: simplified build controls and actions displayed
- core: nametags and chat bubbles now track player head
- core: remove glb extension from app names (via drag-n-drop)

### Fixed
- core: fix scaling things to zero causing octree issues
- core: remove external cdn deps (they're unreliable)
- core: preload rubik font before nametags draw
- apps: release control when app unmounts
- apps: prevent app pointer event errors bubbling up to engine

## [0.7.1]

### Fixed
- core: fix worlds not launching on iOS/safari

## [0.7.0]

### Added
- core: epic new build-mode controls
- core: flying in build-mode
- core: double-jump in normal-mode
- core: initial WebXR support
- apps: dropdown prop
- apps: new "pin" option to prevent accidentally moving something
- apps: support for LODs
- apps: new "unique" toggle that creates unlinked duplicates by default
- apps: sky node sun color property
- core: new admin apps list to help find apps, improve performance, etc
- core: new device setting panel to change shadows, resolution, postprocessing, volume etc
- apps: add fog support to sky node
- apps: add delete button to app inspect window
- apps: world.raycast() support
- apps: support for borderWidth and borderColor on `ui` and `uiview` nodes
- apps: player effects (anchor, emote, snare, freeze, duration, cancellable)
- apps: support reading player bone transforms for attachments
- 

### Changed
- core: improved GUI, chat, actions and app inspector design
- core: reduce z-fighting at long distance
- core: apps drop rotated 180 degrees for consistency with 3D design tools
- apps: set metadata name to initial glb file name
- core: crosshair now changes color depending on its background for high visibility
- core: improve anisotropy for viewing textures at an angle

### Fixed
- apps: download not exporting metadata image
- docs: add missing `num` utility for generating random numbers
- core: code pane sometimes shrinks to 1px in size
- core: when dropping a glb, it will correctly snap to an initial 5deg rotation
- core: subsequent model button presses not working in app inspector
- core: fix DOM-related memory leak 
- core: fix artifial 2s delay on file uploads

## [0.6.0]

### Added
- apps: audio node and audio file prop
- core: camera adjusts to avatar height
- apps: support mesh.material.emissiveIntensity for bloom control
- apps: official custom props + configure and docs
- apps: support Date.now()
- core: support downloading apps as .hyp files
- core: support drag and drop .hyp files
- core: support app metadata (image, name, author, url, desc)
- apps: new number field
- apps: support snap points and embedded snap points in glbs
- core: support drag and drop urls from another website (glbs, hyps etc)

### Changed
- core: reduce docker image size + provide prebuilt images
- apps: props are now a global in scripts
- apps: support app.create(name, props) syntax
- core: unified node props 
- core: upgrade to three@0.173.0
- core: show chat message when dropping a file without permission
- core: lock pointer when raising/lowering apps while holding shift
- core: make default grass environment much much larger
- core: show grab cursor while moving apps

### Fixed
- core: fix crashes caused by undefined blueprint props
- apps: fix removing app configure not updating inspect window
- apps: ui not updated in octree after moving
- apps: fix crash due to props not being set up
- core: dont show context wheel when app has no visible actions
- core: support castShadow/receiveShadow props on imported glbs
- core: fix avatars not unmounting correctly causing memory leak
- core: fix big audio memory issue + firefox not working
- 

## [0.5.0]

### Added
- apps: world.getPlayer(id)
- apps: avatar.height property
- apps: new `nametag` node 
- core: player nametags
- core: app preload option + overlay
- apps: sky node for controlling skybox image, hdr, sunDirection and sunIntensity
- apps: rigidbody.sleeping property
- apps: all nodes including ui now suppot onPointerEnter, onPointerLeave, onPointerDown, onPointerUp events
- apps: player.teleport(position, rotationY)
- core: /status endpoint
- apps: uiimage node
- apps: uv scrolling via mesh.material.textureX|textureY values
- apps: emitting events to other apps via app.emit(name, data)
- core: `/spawn set` and `/spawn clear` commands for admins to change spawn
- core: generate player colliders on the server to track contacts/triggers
- apps: world.getTime() returns server time, even on client
- apps: support node.clone(recursive)
- core: display loading overlay while preloading apps when entering world

### Changed
- core: `vrm` node refactored to `avatar` node, to match types instead of files
- core: improved memory efficient for garbage collecting glbs

### Fixed
- core: fixed server tick rate
- core: cache bust env.js file so browsers don't fetch stale envs
- core: inspecting something while already inspecting properly updates pane
- core: general ui node improvements
- core: prevent setting player name to empty string
- core: physics kinematic movement
- core: trigger colliders crashing world
- core: trimesh colliders crashing world
- apps: scaling nodes not being tracked
- apps: uitext.value crash when not a string
- apps: uitext height layout incorrect for lineHeight
- core: shadow colors and weird artifacts

## [0.4.0]

### Added
- Expose fetch to app runtime
- Add UI, UIView and UIText nodes
- Add app.uuid() utility
- Add app.getTimestamp(format?) utility
- Add app.getTime() utility (uses performance.now)
- Allow apps to post to chat
- Support VRM drag and drop, to place or equip
- Add ability to run multiple worlds and switch using WORLD env

### Changed
- New pane improvements
- Update @pixiv/three-vrm to latest
- Support dynamic environment variables for containerized workflows

### Fixed
- Fix various edge cases where scripts can crash
- Fix node proxy mechanism not working
- Disabled VRM loading on server (affects vrm's renamed to glb)
- Properly abort all in-flight fetch requests an app is making when it rebuilds
- Prevent app async unhandled exceptions bubbling up to a full world crash (see lockdown)
- Fixed camera insanity when loading into the world

## [0.3.0]

### Added
- Environment variable to limit model upload size
- Node.traverse(callback)
- Ability to disable world saving completely
- Initial app networking
- Temporary skybox
- Re-enabled stats via /stats chat command
- Let players know when they are disconnected from the world
- Add /health endpoint
- Action node for interactive apps
- Script to clean up orphaned blueprints/files in a world (npm run world:clean) [experimental]
- Expose Collider.convex to script runtime
- Expose LOD.insert to script runtime
- Initial docs!

### Changed
- Use "geometry" type for Mesh and Collider nodes (instead of "custom")
- Enter and Leave world events are now a player object instead of just the networkId

### Fixed
- Production source-maps issue
- Errors using geometry with morph targets
- Server crash attempting to load an asset that does not exist
- World event unhandled errors

## [0.2.0] - 2025-01-14

### Added
- Docker support for local development and deployment
- ESLint and Prettier configuration
- Contribution guidelines and templates
- Sync with upstream documentation
- ESLint and Prettier configuration for component development
- Docker deployment documentation
- Upstream sync documentation and procedures
- Development environment standardization
- Docker configuration for production deployment
- Multi-stage build optimization
- Volume mounting for assets and source code

### Changed
- Updated development dependencies
- Improved code formatting rules
- Enhanced documentation structure
- Updated ESLint rules and ignored patterns
- Restructured development dependencies
- Enhanced Docker configuration
- Optimized Docker image size using Alpine base
- Enhanced container environment configuration

### Fixed
- ESLint configuration for ESM compatibility
- Build process for Docker environments
- ESLint compatibility with ESM modules
- Development environment setup process
- Docker build process for Node.js 22
- Volume permissions for assets directory

## [0.1.0] - 2025-01-14

### Added
- Initial fork from Hyperfy
- Basic project structure
- Core functionality from original project

[Unreleased]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hyperfy-xyz/hyperfy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hyperfy-xyz/hyperfy/releases/tag/v0.1.0
