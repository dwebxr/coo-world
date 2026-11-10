# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Tips (beta): a maximum per tip, 1,000 JPYC and 10 USDC for the built-in tokens. A custom token spec can give one, `SYMBOL:0xaddress:decimals[:min[:max]]`.
  - **Where it is checked.** The client checks the minimum and the maximum when Next is pressed, before the confirmation step. The server refuses a larger intent with `above_maximum`.
  - **The form.** It shows the range in the amount field and a beta notice: start small, from a wallet holding only a little.
  - **Design.** goals/phase8-tip-beta-limits-design.md.
- docs: the terms of service, dated 2026-11-10 (still before launch, with no users, so updated in place):
  - tips are called 投げ銭;
  - Article 3 says tips are a beta feature developed with the help of AI. The per-tip maximum is shown in the tip form (currently 1,000 JPYC). A transfer whose recipient and amount do not match a tip the Service accepted is not a tip;
  - Article 8 limits liability concerning tips, except for intent or gross negligence, to the greater of the amount the tips causing the damage were meant to send and the amount actually sent (their total, if several).
  The English translation follows. The EVM wallet panel also tells users that tips are in beta and to connect a wallet holding only a small amount.
- docs: `docs/scripting/examples/nft-door.js`, a door that opens for holders of an OpenPay license NFT (ERC-1155 `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` on Polygon). It is preset for the "Coo-World NFT Gate" product. It is a separate door built from the "TOKEN GATE COO" door's model and animation; TOKEN GATE COO and its Solana COO check stay as they are.
  - **The check.** It runs in the server script with `player.getEvmHolding()` and answers only the asking player. Each answer carries the request's build id, number and Open flag, so only the answer to that exact Open press opens the door. Answers to an earlier build, or after a wallet change, are status only.
  - **Without a pass.** The pass panel links to the product's OpenPay page in a new tab, and the sign shows the store's address.
  - **Design.** goals/phase7-openpay-nft-door-design.md.
- docs: terms of service at `/terms.html` (operator dWebXR Lab, contact @coo_aiagent on X), modeled on OpenPay's terms. The Japanese text governs; an English translation follows on the same page, and the in-world Terms links open it (`#en`).
  - **What they say.** The world is non-custodial and takes no part in transfers between players. Minors need a guardian's consent.
  - **Tips.**
    - **The address.** The opt-in is visible to the players in the world. The recipient's address goes to a sender when they start a tip, even one they never send, and it cannot be taken back.
    - **Sending.** Transfers go wallet to wallet on Polygon with no fee; the sender pays gas. There are per-token minimums and rate limits, and transfers cannot be undone.
    - **Confirmation.** "Could not confirm" does not mean the tip was not sent.
    - **Announcements.** Confirmed tips are announced in chat with display names, amount and token, sometimes to the recipient only. World apps are told the same with player ids. Neither gets addresses or hashes.
    - **No goods.** Tips buy nothing; an app's own perks are its author's responsibility. Recipients handle their own taxes.
  - **Data.** Wallet address, verified state and the tips setting are kept only in server memory, for the checks (sign-in, tip confirmation, token and NFT holdings). They are never stored in the database and are gone when the server restarts. RPC and WalletConnect get what they need to check.
  - **The rest.** Third-party services, suspension for violations, a liability limit for ordinary negligence, changes under Civil Code art. 548-4, Japanese law with the Tokyo District Court.
  - **Links.** The Receive tips switch and the tip confirmation link the terms. Both now say the world takes no fee, and the confirmation also says it is not a party to the transfer. Keys in the tips block stay out of the world's controls, so Tab reaches the link and Enter opens it without the chat; Escape still folds the panel.
- wallet: smart-contract wallets (EIP-1271, and EIP-6492 for accounts not deployed yet, such as Myna Wallet) can sign in with EVM when the server has `EVM_RPC_URL_<chainId>` for the sign-in chain.
  - **Check.** EOA signatures are still checked locally. Any other signature gets one deployless `eth_call` of the ERC-6492 universal validator at `latest`. The bytecode is copied from viem 2.57.8 and pinned in tests. The call is limited to 10M gas and 8 s, at most 4 at once and about 30 a minute per server.
  - **Results.** A revert means a wrong signature. A rate limit, timeout or unexpected answer means the check is unavailable, logged once per kind.
  - **Reasons.** `evmWalletStatus.reason` can now also be `contract_unsupported` (no RPC for the chain) or `unavailable`, each with its own message. The packet table and `PROTOCOL_VERSION` are unchanged.
  - **Signatures.** A sign-in signature may be 1 to 4096 bytes; the `requestEvmVerify` inbound cap rises from 512 to 8704 bytes.
- wallet: the WalletConnect phone links are MetaMask, HashPort Wallet and Myna Wallet (JPYC wallets), with the links from Reown's wallet registry. Trust Wallet and Rainbow are no longer listed.
- wallet: WalletConnect (Reown) sign-in for EVM wallets on phones and other devices, behind `PUBLIC_WALLETCONNECT_PROJECT_ID` (32 hex characters; empty keeps it off).
  - **Panel.** A WalletConnect button joins the announced wallets. Desktops get a QR code; phones get MetaMask / Trust Wallet / Rainbow links (plus the plain `wc:` link on Android), a QR toggle and Copy link. While a signature or tip waits, the panel says "Approve in your wallet app" with an Open wallet link on phones.
  - **Loading.** `@walletconnect/sign-client` 2.26.0 and `uqr` 0.1.3 load in their own chunk only when WalletConnect is picked (the client build now splits code; the particles worker stays one file).
  - **Behaviour.** An adapter on SignClient makes the session look like an injected wallet to the existing SIWE and tip code: accounts on the sign-in chain only (following the wallet's account switches), the network switch answered locally, rejections as 4001, and a session ended in the wallet seen as a disconnect. Each pairing has its own link; the relay gets 20 s to answer; Cancel (also while the sign-in waits in the wallet) ends the pending pairing and closes a session that arrives late. Sessions are ended by topic, waiting at most 10 s for the relay before they are dropped locally. A wallet's link back is used only when it is an https link or an app scheme.
  - Telemetry is off; the verification flow and server are unchanged.
- wallet: tips are confirmed on chain and announced (P2b) when the server has `EVM_RPC_URL_<chainId>` for the sign-in chain.
  - **Reporting.** Each tip intent now carries a server ticket. After the wallet returns the transaction hash, the client reports `{ ticket, txHash }` (new packets `evmTip` / `evmTipStatus`, appended; protocol version unchanged).
  - **Checking.** The server polls a shared, budgeted watcher. It matches only the token's `Transfer` log (sender, recipient, exact amount), not `receipt.from` or `receipt.to`, so EIP-7702 and sponsored transactions work. It waits for the `finalized` block, checks the block hash, and refuses transactions older than the ticket.
  - **Results.** Only the sender gets `watching`, then `confirmed`, `failed` or `unverified`. An unconfirmed tip can be reported again once.
  - **Duplicates.** A transaction is counted once, and is only marked seen when confirmed, so another player's report of the same hash cannot block it.
  - **Announcement.** A confirmed tip is announced as a system chat message, paced to 3 at once then one per 3 s, and one per sender per 30 s; otherwise only the recipient is told.
  - **Script event.** Server scripts get the protected `tip` event, with no addresses or transaction hash.
  - **RPC errors.** `RpcError` now separates JSON-RPC error answers from transport failures.
- wallet: tips between players (JPYC / USDC on Polygon) behind `PUBLIC_EVM_TIP_TOKENS`. A verified player opts in with **Receive tips**; other players see only an `evmTips` flag and a tip button in the Players list. Sending asks the server for a tip intent (verified senders only, 3 per socket then 1 per 10 s, never to the same wallet, per-token minimum) that returns the recipient's verified address and the exact amount; the sender's wallet then sends one ERC-20 `transfer` straight to that address after checking its account and chain (switching to, or adding, Polygon). The server never holds funds or builds transactions, and tips are not yet verified on-chain or announced.
- apps: `player.getEvmHolding(spec)` for server scripts checks whether a player's verified EVM wallet holds an ERC-721 / ERC-1155 token through a server-only `EVM_RPC_URL_<chainId>` (cached 30 s, shared budget, fail-closed `known: false`), and the protected server event `evmWallet` reports verification changes. Example app: `docs/scripting/examples/nft-gate.js` (works with OpenPay license NFT ids).
- wallet: EVM wallets (MetaMask, Rabby, any EIP-6963 or injected `window.ethereum` wallet) can prove address ownership next to Solana, behind `PUBLIC_EVM_CHAIN_IDS` (for example `137`; empty keeps EVM off and the world behaves as before). The server builds a Sign-In with Ethereum (EIP-4361) message bound to the page host, URI, the first configured chain, a 64-character hex nonce and a 60-second expiry, and verifies the signature against the message it stored (EOA only; smart-account EIP-1271/6492 signatures are refused for now). Verification is per connection, is not stored, is not sent to other players and does not change rank: builder access is still granted by the Solana token only. Solana and EVM keep separate sessions, cooldowns and attempt counters, so neither cancels the other. The wallet panel gets Solana / EVM tabs when both are enabled (the choice is remembered with the open/closed state); the EVM tab lists the announced wallets and shows the verified address. `viem` 2.57.8 is a server-only dependency (the browser bundle does not include it).
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
- client: a model, avatar or emote may only use what is inside its file. A `.gltf` or `.glb` that names an external buffer (a `.bin` by URL or relative path) fails its load; one that names an external image loads without that texture. Embedded buffers and images, and `data:` URIs, load as before. Until now a file's absolute dependency URLs (`https://…`) were fetched, for an uploaded `.glb` or `.vrm` as for a remote file, outside the loader's size limits and deadlines; only relative ones never resolved (files are parsed without a base path). A file that relied on absolute URLs now fails (buffers) or loads without those textures (images). The server cannot load external files either.
- client: an image a model, avatar or emote decodes must be a PNG, JPEG or WebP, by its bytes whatever `mimeType` it declares; a file with any other image it decodes (GIF, BMP) fails its load with a reason. An image used only through `KHR_texture_basisu` is never decoded (this client has no KTX2 decoder and uses the fallback image). AVIF textures inside models are not decoded either, in any browser: the parser takes `EXT_texture_avif` as unsupported and uses the fallback image (an AVIF image cannot be sized before its decode; a file that requires the extension fails its load with a reason). Stand-alone AVIF images still go to the browser as before. An image named by URL is not fetched, as before. The bundled models and avatar decode PNG and WebP only. Stand-alone images keep every format the browser decodes.
- client: an asset in the world's own store is loaded and kept once whatever its query or hash: `asset://x.glb?s=2` and `asset://x.glb` are one download and one result, and `loader.get`/`has` answer for either. Playback options in an emote's query (`?s=`, `?l=`, `?g=`) still apply, since the avatar reads them from the URL it was given. A URL from another host keeps its query, which can name a different resource.
- ci: the end-to-end job also runs on every push to `main` and weekly (Mondays 04:23 UTC), so `main` is checked even when a pull request skipped the suites through its paths filter.
- chat: a user's message always shows a name (`Anonymous` when empty), and names made only of spaces or invisible characters are refused on the server and the client, so a user message can no longer look like a system message.
- wallet: a Solana verification that times out after the verify request was sent is withdrawn on the server (`revokeBuilderByToken`), so a late success cannot leave the server verified (and a builder) behind an unverified panel.
- network: tip packets are appended (`setEvmTipReceive`, `requestEvmTipIntent`, `evmTipIntent`, ids 35-37) with inbound caps of 32 and 192 bytes.
- network: EVM wallet packets are appended to the packet table (`requestEvmNonce`, `evmNonce`, `requestEvmVerify`, `evmWalletStatus`, `revokeEvmWallet`, ids 30-34) with inbound caps of 128, 512 and 16 bytes for the client-sent ones. Existing ids and the protocol version (`v=2`) are unchanged, so existing node agents keep working.
- stage, prims: memory for prims and linked meshes stays bounded (Phase 3b-2b-2). A Model with no instances is released after 10 s of world time (its instanced mesh, geometry clone and BVH); the material it rendered with is kept per Model id, so scripts' material proxies and their edits survive visible toggles, LOD switches and rebuilds, and the uber-shader hook is installed once per material. An unlinked mesh disposes the material and textures it cloned. Prim geometry keys are finite and the same in every process: tapered cylinder radii snap to a 1/64 grid and torus tube ratios to a log2 grid of 1/8 octave (computed from the float bits, since Math.log2/Math.pow may differ by engine), and a ratio outside 2^-10..2^10 is invalid (no visual, no physics). Prim materials round metalness and roughness to 0.05, so untextured materials form a fixed palette (at most 21 × 21 × 21 × 2) that every process builds the same way; textures are first come, with at most 256 texture strings and 1024 textured materials per process, beyond which a prim renders untextured with one warning. Kept linked materials are capped at 8192 or the live Models, whichever is larger (oldest released first), and Stage.destroy disposes Models and materials. Mesh box and sphere geometries are shared by size and held while a mesh is mounted with them; at most 1024 unused ones per shape stay cached (least recently released first out, disposed when evicted), so the cache holds the sizes that mounted meshes use plus 1024 per shape (how many meshes an app mounts is not limited here). A geometry's id is its shape and size, so a linked mesh that was inactive while its geometry was evicted comes back to its Model and material edits, as long as the stage still keeps them (the Model for 10 s without instances, the material within the kept-material limit). An exception while a mesh is inserted into the stage takes the mesh or its instance back out instead of leaving it rendering (a non-finite matrix is parked by the octree, not refused, and still renders as before). Linked render flags count only when they are `true`. Values that reach a cache key must be primitives (a `Number`, `Boolean` or `String` object, whose own `toString` could mint keys, is refused): Mesh `width`, `height`, `depth` and `radius` (which also refuse `NaN` and ±Infinity now), Prim `metalness`, `roughness` and `opacity`, Prim `texture`, and Prim `doubleside`, `castShadow` and `receiveShadow`. A Prim keeps a plain copy of the size it is given (at most 16 values) and hands scripts a copy back, so a custom iterator, index getter or later edit cannot change the size after it was checked.
- physics: a Collider skipped for its scale, extent or pose, a Prim skipped for its size, scale, extent, position or mirror, and a RigidBody skipped for its position mount again once that transform changes (an extent skip keeps its cooked mesh, so the retry does not cook again; moves that leave the checked transform unchanged do not retry).
- physics: no native allocation outlives its node, and unchanged values do not rebuild (Phase 3b-2b-1). Per mount, RigidBody leaked one or two PhysX objects, Controller four, and every RigidBody and Joint node kept scratch objects forever; a visible Controller leaked its capsule geometry, BVH and material on clients. Assigning the same mass, damping, centre of mass, Collider size/material/flags, Controller size or Joint limit every frame rebuilt the node every frame, and a RigidBody rebuild silently dropped its joints for good. Joints now detach before their body's actor is released and mount again on the new one, wait (instead of pinning the other body to the world) while a body has no actor, and a joint's failure stays in its own app. A native throw mid-mount no longer leaks temporaries or publishes a stale physics handle. Meshes: the vertex count and every index are checked before anything is allocated (whole triangles, indices inside the vertices); each mesh may have 200 000 vertices and 200 000 triangles (convex hulls 50 000 points), each app 400 000 and the process 2 000 000 vertices plus triangles of live cooked meshes (the production world's largest mesh has about 10 000 triangles), so one app cannot exhaust the wasm heap, which only grows and aborts at 2 GB.
- server: refuses to start when `JWT_SECRET` is still the public template value `hyper` (the value `.env.example` shipped and upstream hyperfy ships): a session token only carries a userId, so anyone who knows the secret can sign in as any user, admins included. A secret shorter than 32 characters logs a warning. `.env.example` no longer ships a value and says how to generate one. Upgrade note: set your own `JWT_SECRET` (`openssl rand -hex 32`) before deploying; every existing session token then becomes invalid, so admins sign in again with `/admin <ADMIN_CODE>`.
- physics: values that PhysX treats as invalid never reach it (Phase 3b-2a). A builder script could hand PhysX a denormal mass, a far controller position, a zero kinematic quaternion or a mesh whose real vertices are far larger than its file claims, and the shared scene's other bodies turned NaN; an invalid cone or hinge limit, a zero joint frame, a far centre of mass or an extreme push turned the body itself or its jointed bodies NaN. Lengths (box half-extents, sphere radii, controller radius/height), mesh scale axes, mesh extents (from the scanned vertices, never the file's bounding box) and positions must be inside 1e-6…1e6; geometries must pass `PxGeometryQuery.isValid`; a node that fails skips its physics (the visual stays) with one warning per node and reason, and a skipped Collider no longer re-cooks on every move and mounts once a setter fixes the value. Setters reject NaN, ±Infinity and negative lengths, frictions and restitutions, and a positive mass below 1e-9 (0 stays PhysX's infinite mass); a zero radius or size is accepted and skipped at mount. `setQuaternion` and `setKinematicTarget` normalise their quaternion (a zero or denormal one is ignored). Pushes (`addForce`, `addForceAtPos`, `addForceAtLocalPos`, `addTorque`) share a budget per body and physics step: their summed velocity change, from float32-rounded operands and with the lever measured from the centre of mass, stays within 1e6 m/s and rad/s, and an application point outside the window is ignored. Every actor pose write stays inside the window (RigidBody mount, `setPosition`, `setKinematicTarget`, node moves, Prim mount, joint anchors); a controller ignores a teleport or move outside it and gets no controller when mounted outside it. A Collider's local pose is checked and normalised; a mirrored Prim keeps static physics only, since a moving one would flip its visual away from its collider. Joints normalise frame rotations (a zero one skips the joint), apply a cone only when PhysX accepts it, a hinge limit only when ordered and inside ±360°, each distance end only when set (PhysX's default max-distance flag at 0 is cleared first), a spring only when finite and ≥ 0, and treat a NaN or negative break force as unbreakable. Prim `layer` takes the same four names as Collider and Controller (and scripts cannot pick `player`), and the `Joint.type` setter compares and reports the value.
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
- client, server: a model's `data:` URI can no longer block the thread that parses it. The vendored GLTFLoader handed every buffer and image URI to three.js's `LoaderUtils.resolveURL`, whose `/^data:.*,.*$/i` backtracks over every comma before a line break, quadratically: a 98 KB file (`data:application/octet-stream,`, 100,000 commas, a line break and one character) blocked the main thread for 5 s, a 1 MB one for minutes, and the parse's time limit cannot interrupt it. The server parses models with the same parser, without the check before it. The parser now uses a `data:` or `blob:` URI as it is (what `resolveURL` returns for one), found by a five-character prefix test; on the client the check also refuses a URI with a line break (see Security).
- client: a load that failed is tried again the next time the asset is asked for. The failure used to be kept for the session, so an asset whose upload finished a moment later could not be shown without a reload. An image that cannot be decoded now fails its load instead of leaving it pending for ever.
- client: a sky whose background or HDR cannot be loaded still applies its sun, fog and rotation; the asset that failed is treated as not set: no background (the previous sky's texture is let go of) and no environment map (the previous sky's HDR used to stay). The failure used to stop the whole update, as an unhandled rejection. It is reported once per URL (the last 64 failing URLs are remembered). Background and HDR now load side by side.
- client: a model whose primitives share an optional Draco extension but not their fallback data shows each primitive's own geometry; all of them showed the first one's (the parser's geometry cache keyed them by the Draco data, which this client does not decode).
- client: an image inside a model, avatar or emote whose decode fails releases its blob URL and the bytes it holds; only a decode that succeeded did. A decode still running when the file is refused releases it when it ends.
- client: a shift-click download from a file field or the app model button works for a file the loader no longer keeps (one from another host, past the loader's bound): it is downloaded again. The file field used to report "could not load file" and the model button did nothing.
- nodes: an in-place edit of a UI node's `offset` (`ui.offset.x = 5`) now rebuilds the UI. The node used to overwrite the vector's `_onChange` method instead of registering a callback. A cloned UI node gets its own offset vector instead of sharing the source's.
- wallet: the WalletConnect "Open HashPort Wallet" link opens the app with the connection request.
  - **Before.** HashPort's universal link (https://link.wallet.hashport.com) did not reach the app on an iPhone. Its page sent the player to the App Store, and the pairing link was lost.
  - **Pairing.** HashPort Wallet now pairs through its app scheme, `expo2025-wallet://wc?uri=…`, which is the link Reown's AppKit uses on phones. Safari asks before opening it. Without the app installed, Safari says it cannot open the page.
  - **Unchanged.** MetaMask and Myna Wallet keep their universal links.
- wallet: "Open wallet" (while a signature or tip waits) opens the connected app through an app scheme whenever one is known. It used to try universal links first, which can end on the App Store; Myna Wallet's bare `…/deeplink` base is not one of its app links.
  - **Link order.** The wallet's own app scheme comes first. Next is the scheme of the listed wallet the player tapped, used only when the connected wallet sent no link or one on that wallet's host. Last is the wallet's own universal link, so a stored session whose wallet sends only a universal link still uses it.
  - **Same tab.** A listed wallet's scheme opens in place, where a new tab would stay behind empty. Any other link the wallet sent opens in a new tab.
  - **Refused links.** Android `intent:` and `android-app:` links from a wallet are refused, since their fallback can be any web page.
  - **Forgetting the tapped wallet.** Copy link and Show QR forget the wallet the player tapped, since another wallet may take the link.
- client: on iPhone and iPad, model images load as `<img>` elements in every browser, as iPhone Chrome already did. Safari and Brave got ImageBitmaps from three's GLTFLoader, which WebKit cannot release when memory runs low. With a world's textures, iOS then closed the page ("A problem repeatedly occurred"), most often while the player was in a wallet app. In WebKit under simulated memory pressure, the production world kept about 2.5 GB with ImageBitmaps and about 1.6 GB with `<img>` elements. Desktop browsers and Android keep three's own choice.
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

### Security
- client: an avatar, emote or model that another user supplies can no longer stop rendering for the people who see it.
  - **Avatars.** A VRM without a neck bone (optional in VRM 1.0) made `aimBone` throw on every frame for every client within 40 m, and the frame loop has no way to skip one avatar. The bones the engine needs (hips, head, upper arms) are now checked while the file loads, and so is the skeleton it drives (the first skinned mesh's: it must have bones, all of them in the scene, a root bone with a parent, and the hips and head). An unusable avatar fails its load with a reason, which is reported; the player keeps the avatar it had, or none (a fallback to the default avatar is not part of this change). Optional bones are skipped where they are used.
  - **Emotes.** Each avatar keeps at most 16 emote clips mixed (a remote player picks the URLs, and each new query string used to add a clip for good); a dropped clip leaves the mixer with its action, bindings and fade. A failed emote is reported and forgotten instead of leaving an unhandled rejection. An emote file without an animation fails its load with a reason. An avatar that is destroyed while its emote or locomotion clips are still loading no longer mixes or plays them when they arrive, and its mixer lets go of its actions and clips.
  - **Models.** A wind material on a model whose file gives no position bounds threw inside the shader hook on every frame; the height is now measured once when the model loads.
- client: the loader checks what it downloads.
  - **Status.** A 404 or 5xx page is a failed load. It used to be parsed as the model, image or script.
  - **Size.** A download from outside the world's store stops at a limit for its kind (2 MiB scripts, 32 MiB images and emotes, 64 MiB models, avatars, audio and HDRs), whether the size is declared, real or endless. In the world's own store the limit is the upload limit (`PUBLIC_MAX_UPLOAD_SIZE`), or the kind's limit where that is larger, so a 3 MiB script accepted at upload also loads after a reload. The same limit applies to a file the loader already holds and to a file just picked for upload.
  - **Transfers.** Every refused transfer (an error status, a size over the limit) is aborted. A download that receives nothing for 30 s, or is still running after 120 s, is abandoned. A response without a readable stream is read only when it states a length within the limit.
  - **Pixels.** Images, textures and HDRs above 36 megapixels are refused. An HDR is refused from its header, before the parser allocates its pixels (a file of a few bytes could declare a billion rows). The textures inside a model, avatar or emote are held to the same budget; a file with a larger one fails its load and what was decoded from it is released.
  - **Embedded files only.** A model, avatar or emote may only use what is inside its file (see Changed).
  - **Limits inside the parser.** What they bound: what the vendored parser itself allocates, creates and decodes, and the work it and the check before it do, each charged before it happens; and the time they take. The limits are set from VRoid's sample avatars (VRoid Studio's AvatarSample_A and B, five more VRM 0 and VRM 1 samples, 6 to 20 MB): each meter has at least three times what the largest of them needs. Models, avatars and emotes are parsed by the vendored GLTFLoader (`src/core/libs/gltfloader/GLTFLoader.js`, its `COO_BUDGET` and `COO_WORK` sites), which charges a per-file budget from the real objects at that moment rather than from what the file declares. Bytes: every array it creates or copies (the GLB's binary chunk, each bufferView, accessors without data, sparse accessors, which copy the whole array, strip and fan conversions, which copy the geometry, instancing matrices, converted animation values, `extras` and each clone's copy of them, each object's name and each track's, the morph-target texture the renderer will build), up to 320 MiB beyond twice the file's own size. The morph-target texture is three.js's own allocation: one per geometry, so a VRoid face of ten primitives sharing their vertices and 56 targets is ten textures, padded to rows of the renderer's maximum texture size (the largest any size would take while that is not known). That is most of an avatar's cost: AvatarSample_A is charged 110.8 MB for its 15.1 MB, 73.4 MB of it morph textures (36.8 MB where the maximum is 16384); the bundled avatar 17.8 MB. Objects, per file and counting every clone: 64 scenes, 1024 cameras, lights and animations, 65,536 nodes, primitives, mesh instances, channels and tracks, 16,384 meshes, materials and textures, 262,144 joints and morph influences. Work, up to 2^26 steps plus one per byte of the file, charged by reference: each use of an accessor at its declared size (elements x components) wherever the parser resolves it, for each mesh made of a primitive (50 skinned primitives on one shared 2000-vertex geometry had their weights normalised 100,000 times for 270 steps), each animation track and each instanced mesh; each object placed under a parent at what three.js goes through to take it from its old one (a scene listing 1000 roots twice shifted 999,000 entries for one step a root), emptying a group at its splices; each clone at what it copies (its userData, its morph influences; a material's variant also each texture in a ShaderMaterial's uniforms, which three.js clones with it); and each loop or walk the document sizes (sparse entries, the subtree each morph-weight channel walks, the scene walks, the entries of each list it goes through). The check before parsing is charged to the same budget (a step per entry it goes through) and looks at the same clock; it is linear in the document. AvatarSample_B takes 20.1 million steps, the bundled avatar 1,035,591, an emote 58,170 to 122,087 (the check and the parse as the client runs them, charged to one budget, with the VRM plugin registered as for every file; the check alone is 53,516 of the avatar's and 53,750 to 66,470 of an emote's). A copy of userData (three.js makes one, as JSON, with every clone of an object, a material or a texture) is charged at an estimate of what it holds, not its text: 2 bytes a character, 24 more per value in a list, 56 more per property and 96 more per list or object, outside strings. Measured, not proven: on V8 (Node 24), over 52 shapes of up to 64 KiB, the largest held ÷ charged was 1.01 (a long string of two-byte characters), objects of many short keys at most 0.95 (one with 5,560 two-character keys held 1.40 times its charge at 24 bytes a property), a list of empty objects 0.51 (11.7 times the two bytes a character charged before: a reviewer's 68 clones within the work limit held 1.6 GB, 135 MB charged). A texture whose image is a data: URI is cached by the image, not by the URI (the parser built and looked up a key of the whole URI for every texture: 2000 textures on one 8 MB URI took 2.4 s, and now 0.7 s, the image's one decode). A data: URI image that does not decode is refused like any image that is not one, so the parse fails (it had loaded, without the texture); the empty placeholder a refused texture gets in its material (three-vrm's MToon plugin never awaits the promise it wraps the texture in) is put in only once the parse has failed, and any other texture error goes on as it did. Time: the check and the parse are refused at the first charge after 10 s on a monotonic clock (the bundled avatar's take about 3 ms in Node on a desktop, the VRoid samples 8 to 44 ms). A file of a few hundred bytes that declares a billion vertices is refused at its mesh's charge, before anything is allocated. The parser asserts on the real arrays what three.js relies on: an animation track's times one per keyframe and a whole number of values per keyframe from arrays of just the accessors' own elements, as many as the document declares (a sparse accessor on an interleaved view copies all of them), a skinned primitive's joints and weights one per vertex, a skin's inverse bind matrices one per joint, sparse indices strictly increasing inside their accessor (the specification's rules; on the server too). Loops whose length comes from the document go over real lists only, and morph weights no further than the targets. A test reads the vendored file's syntax and fails on any `new` (but a thrown one), spread, loop or call without a marker of its own, a comment starting with the marker word, and on a function calling itself without one for its depth; the calls it lets through are this file's own functions and an allow-list of cheap callees, each with its reason. The allow-list is by name, not by binding: a library function assigned to an allowed name (`const resolve = structuredClone`) or handed to an allowed method as its callback (`.then(structuredClone)`) passes, as does an allowed method name on another kind of object (`text.normalize()`); and the test does not see recursion through two functions, through a callback or through another name for the parser, tagged templates, copies by rest destructuring, or the join of a list converted to a string (`'' + list`, a template). None of these is in the vendored file (a reviewer's probe inserted each one); they are found by reading it. A marker on a call into three.js or three-vrm is a claim about that library's cost, which the test cannot see. What the limits do not cover: cost inside three.js and three-vrm that is proportional to what is charged is covered by those charges; cost there that multiplies in ways the charges do not capture is not proven absent. The time limit turns it into a refusal at the next charge, but cannot interrupt one long loop inside a library (see Still open).
  - **Before the parser.** The container and the structure are checked first (`src/core/extras/gltfLimits.js`): GLB chunk lengths, a JSON chunk of at most 16 MiB that nests at most 64 deep (a .gltf's JSON too, counted without the payloads of its buffers' and images' `data:` URIs, which are data: it was held to nothing, and a 20 MB one passed; a `uri` anywhere else is a string like any other, capped as one), every index a non-negative whole number in range (a string index is refused; UniVRM's -1 for "none" is accepted in the VRM 0 fields three-vrm reads as absent, such as a spring bone group's center, but not as a human bone's node, which three-vrm looked up: a TypeError), every list a real list of at most 2^20 entries (and at most 1024 morph targets a primitive), a node hierarchy that is a tree at most 256 deep (a chain of thousands overflowed the parser's stack), no glTF 1.0 `animation.parameters` or `buffer.type` (the parser still honours both), required extensions this client can load, each extension named once, and a scene's roots each listed once and a child of no node (the parser re-parented a root it met again, a search and a splice of its old parent's children each time; such a scene never loaded as written). Strings are short by rule, because the parser and three-vrm keep, compare, concatenate, sanitise or key on them once per object: every string and every key they read (a name, a kind, an extension's, an attribute's, a bone's or an expression's name) is at most 1024 characters, a URI that is not a data: URI at most 2048, and the asset's and the VRM meta's text, read once, at most 16,384 (the longest in the bundled files and VRoid's seven samples: 59, a key 31, the text 51). A mesh name of a million characters was sanitised and kept for each of 1000 primitives, stopped only by the clock. A data: URI is the data, its bytes charged where they are decoded, by one decoder, once: the bytes sized and charged are the bytes the parser uses. A `data:` image is decoded by the budget, its first 256 KiB first (an image refused from its header costs only them), then, accepted, whole, straight into an array of its size, each array charged before it is made, its header read from those very bytes; the parser hands that array to the image decoder in a Blob, through the same object URL (revoked however the load ends) as an image inside the file, and never fetches the URL. A fetch's URL parser makes other bytes of the same text (it drops tabs, UTF-8-encodes characters past ASCII and ends at a `#`): a 192 KB percent-encoded JPEG was sized 16 x 16 by the budget and decoded as 20000 x 20000. The decode went through an `atob` string and a list of numbers, about 20 times the URI, and charged nothing (300 to 380 MB for a 15 MB URI). A `data:` buffer is decoded by the same decoder, charged at its size, its data at least the buffer's byteLength (checked before parsing, with that decoder: a shorter one threw inside the parser), and not fetched either: its old charge, three quarters of the URI, was below what a fetch made of a payload that is not base64 (1,000 bytes from 1,006 characters, 3,000 from 1,000 characters past ASCII). Without a budget (the server) both are fetched as upstream. The `data:` scheme is recognised in any case, as RFC 3986 says, by one test that the check, the parser, the budget and the client's URL filter share (an upper-case `DATA:` was a relative URI to the check, data to the parser and the budget, and refused by the filter). A value they treat as a string must be one (a material's name given as a list was joined into a string for every outline three-vrm cloned from it), a sampler's filters and wrapping and an accessor's component type are numbers, and an image's `mimeType` is one of a fixed list, image/png, image/jpeg, image/webp, image/ktx2 or image/avif (the last two the types of the images KHR_texture_basisu and EXT_texture_avif name; an optional KTX2 or AVIF image is skipped for its fallback): each texture's userData keeps it, and three-vrm copied a 100,000-character one into nine slots of every outline (180 MB from a 0.11 MB file, 0.88 MB counted). Extras are small by rule: an object's extras and extensions (node, mesh, primitive, material, image, scene, camera, light; the parser copies them into its userData), at most 64 KiB of JSON (the most in those files: 1,957), and all the userData the parsed scene holds (a mesh's for each of its primitives and each node using it), which every clone of the scene copies, an avatar's for each player, at most 8 MiB (the most in those files: 22,501; an instanced Blender export with custom properties, one mesh of 5 materials with a 200-character property on 1000 nodes, holds 1,055,000, and was refused at the 1 MiB first set). Strings inside extras, and inside extensions nothing here reads, are not names: they are within those sizes. A URI has no line break (`\n`, `\r`, U+2028, U+2029), and a `data:` URI has the shape `data:[<type>/<subtype>][;<name>=<value>]...[;base64],<payload>`, the part before the comma a name (at most 1024 characters): base64 broken into lines, a space before `base64` (`data:image/png; base64,…`, which some fetches accept) and base64 with %-escapes (which browsers decode first) are refused, and so is a payload that is not base64 with a raw control character, a space, a character past ASCII or a `#` (the forms on which a URL parser and a decoder disagree). A texture has an image this client decodes, its source or a WebP one: an optional KTX2 or AVIF texture without a fallback source failed in the parser with a TypeError. A root shared by several scenes is valid glTF and loads: it ends in the last, each move charged. Draco and meshopt compression are accepted when optional (the parser reads the fallback data; an optional Draco extension without a decoder used to fail the load). Accessors must be what the parser and three.js assume of them: an animation sampler's times one float a keyframe and its values one per keyframe (three for CUBICSPLINE, one per morph target for weights) of the path's type, neither interleaved, so a track's value size is a whole number (7 values for 2 CUBICSPLINE keyframes, a value size of 3.5, made three's interpolant loop forever, and so did times at a byteStride of 8, which reached the track as twice the floats); a skin's inverse bind matrices a float 4x4 matrix per joint, not interleaved; a primitive's attributes, and its morph targets, of one count, its indices unsigned and not interleaved, and every primitive of a mesh with as many targets; instancing attributes of one count, at most 16 on a node (the parser goes through each for every primitive); every accessor at least one element, within its bufferView, strides and offsets by the specification's rules, and sparse entries no more than its elements. three-vrm, which is not vendored, is bounded by its work counted in the units its plugins iterate. Most of them walk the parsed scene graph, so the units are its objects, not the document's nodes: a mesh of several primitives is a Group and a mesh per primitive, spring colliders are added below their nodes, expressions and the humanoid rig to the scene (a bone listed once on a node whose mesh has 21 primitives made 23 joints, counted as one). Counted: expressions, bind objects, the primitives they refer to, the steps they take (each morph bind walks its node's subtree, each VRM 0 material value the scene), spring joints and colliders, joints x the colliders of their groups, sorting the joints, first person (every node, the subtree of each with a mesh, the annotations), node constraints, the draws MToon outlines add (two per outlined mesh on a geometry the parser shares between meshes with the same primitive: 300 such meshes drew 180,000 groups), and what the outline material three-vrm clones for each outlined primitive copies, up to 16 MiB: the material's userData (its extras and the extensions the parser does not handle), and for each of MToon's 10 texture slots the largest texture userData in the file, an image's extras and its mimeType (which image a slot holds is not modelled: an extension's source, the parser's texture cache and VRM 0's slots can each resolve it to another), each copy at that estimate (50 outlined primitives on one material with 1000 small objects in its extras made 50 copies of them, about 1 MB, while nothing was charged); and what an expression's texture-transform binds copy, up to 16 MiB: each clones every texture slot of each material it binds (up to 8, a MeshStandardMaterial's), once per mesh the material is on (VRM 1) or per material named and its outline copy (VRM 0). These counts are computed from the document before three-vrm runs, and three-vrm is not metered as it runs: springColliders, constraints and the VRM 1 spring joints and morph binds are exact; the others are bounds, each at least what it stands for (`gltfLimits.js` says why for each).
  - **Transfers at once.** At most 8 downloads from the world's store and 4 from other hosts run at once (each pool on its own, so slow hosts cannot hold up the world's assets); the others wait without a connection, and their deadlines start when they do. That is the bound on bytes in flight: each transfer stays within its kind's limit (a stated length over it is refused before reading, a body that grows past it is cut off), so downloads from other hosts hold at most 4 x 64 MiB = 256 MiB at the very worst, and the world's own at most 8 times the upload limit (or the kind's limit, if larger). At most 256 loads from other hosts may wait or run; past that a new one fails at once and is not kept. The world's own loads are not capped in number.
  - **Late downloads.** A transfer is filed from the moment it is asked for: a file picked or set for its URL while it waits for a slot or downloads is the one kept (and, once the slot is granted, the one used), and a download that finishes after `destroy()` writes nothing. `destroy()` aborts the downloads in progress and fails the waiting ones; a request asked for just before it fails without taking a slot in the next lifecycle.
  - **Avatar skeleton.** The bone taken out of the scene as the skeleton's root is the one above the hips, not the first joint the file lists. With the joints listed head first, the head was taken out and the hips were moved twice (a probe placed at X = 10 reported the hips at X = 20). An avatar whose head is not below that root is refused; stray bones outside it are accepted.
  - **Images without a size.** An image or texture whose intrinsic width or height is zero fails its load.
  - **Image sizes from headers.** The size of a PNG, JPEG or WebP is read from its header before anything decodes it, so a header of a few dozen bytes declaring 100000 x 100000 no longer reaches the decoder. The reader walks the PNG chunks to the image data, the JPEG markers to the first scan and the WebP chunks; a file that is inconsistent (a second IHDR, an APNG frame outside the image, a second JPEG frame header in front of the real one, which decoders read differently, a WebP image or frame that does not match its canvas) is refused everywhere as malformed. Stand-alone images and textures (the world's store and other hosts, loaded or just picked) are refused there when over 36 megapixels, without a size or malformed. Other formats (GIF, AVIF, SVG, BMP) go to the browser's decoder as before and are checked once decoded. Inside a model, avatar or emote the parser sizes each image at the place it is about to decode it, so what is charged is what is decoded: images the parser shares (textures on one bufferView with one sampler) are one decode, and an image only a KTX2 texture would use is not decoded at all. A file's decodes together may have at most 256 Mi pixels (sixteen 4096 x 4096 textures, about 1 GiB decoded); the bundled avatar decodes 4 Mi. An embedded image named by a `blob:` URL is refused. The decoded size is still checked afterwards, on both paths.
  - **Memory.** Files and results for URLs outside the world's store are kept up to a bound, least recently used first out; a load still in progress is not dropped, and a dropped or replaced one no longer writes its result back. Video loads are kept under the same bound. A decoded image releases its object URL, which used to keep the downloaded bytes alive for the life of the page. Bytes that do not decode are not kept, so the next load downloads them again.
  - **Files just picked.** A file inserted before its upload (the file fields, a dropped model or avatar, `.hyp` import) is checked and decoded as a download is: a broken image fails instead of staying pending, and a failure is not kept.
- server: a blueprint's `script` or `model` could name any file the server can read. Builder rank (which holding the token can give) was enough to set `script` to `/proc/self/environ` or `asset://../../x`. The server then read the file on every rebuild, and the AI `edit` and `fix` actions sent its text to the AI provider and saved the reply as an asset, so the server's secrets could leave through the AI. `model: '/dev/zero'` could exhaust the server's memory, and node agents read such paths on their own machine.
  - **Loading.** The server and the node agent read a local file only for `asset://<name>` (letters, digits, `.`, `_` and `-`, up to 128 characters), and only from directly inside the assets directory. No other value is ever read from disk. A path (`/…`), `blob:` and an invalid `asset://` name are refused with the reason and a short prefix of the value. With `ASSETS=s3`, and on the node agent, `asset://<name>` still loads from the assets URL. Remote loads are unchanged: an http(s) URL is fetched, and so is what the loader has always turned into one (`//host/x` and a bare `host/x` become `https://…`, which includes spellings such as `file:///x`); limiting where the server may fetch from is a separate change.
  - **Blueprints.** A new blueprint, or a change that sets `model`, `script` or `image.url`, must give `asset://<name>` or an http(s) URL with a lower-case `http://`/`https://` prefix. The client refuses anything else with a toast, the server with a revert. A stored blueprint that already holds another value still loads as it is, and changes to its other fields are accepted.
  - **AI.** `edit` and `fix` read only an `asset://<name>` script. For any other value nothing is read or sent to the provider, and the refusal is logged as the action's failure.
  - **Start-up.** Each stored blueprint whose `model` or `script` the server now refuses is logged once (`[network] blueprint "<id>" keeps a source the server no longer loads; …`) and kept unchanged. On the server that app shows the crash block until a builder replaces the value.
- scripts: the classes app scripts can reach are frozen. Before this, a script could replace a method on a shared class (`Vector3.prototype.add = …`), and the engine and every other app then ran the replacement, on the server and in every visitor's browser, until the process restarted.
  - **What is frozen.** `Vector3`, `Quaternion`, `Euler`, `Matrix4`, the interpolation classes and `Curve`, and the classes their instances lead to (THREE's own `Vector3`, `Matrix3`, `Keyframe`, and `Color`, which a material proxy returns): constructors, statics, prototypes and the methods themselves. Any write throws a `TypeError` in the script.
  - **Pointer callbacks.** `onPointerEnter/Leave/Down/Up` receive a new frozen `{ type, stopPropagation }` object for each call. The engine used to pass one shared, mutable event object to every app.
  - **XR poses.** Controller poses are copied into the pose objects as numbers. The browser's `DOMPointReadOnly` used to be passed to `copy()` of an object a script holds, whose `copy` the script can replace.
  - **`Object3D` is no longer given to scripts.** THREE's `Object3D` hands every listener the same event objects, through which a script could receive each object the engine later adds to its scene (and from a texture, the page's `document`). It was not documented; scripts use nodes for hierarchies.
  - **How.** Each prototype property is first turned into an accessor that still lets an instance take its own value (`src/core/extras/scriptClassPrep.js`), because THREE and the engine assign over prototype properties on instances (`_onChange`) and in constructors (`isVector3`). A plain freeze makes `new Object3D()` throw.
  - **Tests.** `test/scriptClassHardening.test.js` runs 24 attacks in real compartments under the real lockdown, checks that the engine and every node type still work, and walks everything reachable from a script's globals, instances and node proxies. The old test passed over an empty class list.
  - **Not covered.** A script can still obtain one of the math classes' internal temporary objects (for example through `Matrix4.decompose` with a made-up quaternion) and change that one object. That can disturb math for others; it gives the script nothing it could not already do to availability.
- server: the unused `Comput3Client` in `src/core/systems/ServerAI.js` is removed, together with the Comput3 API key written into it.
  - **Origin.** The class and key came from upstream Hyperfy (commit `57ee205`, 2025-08-20). The key was not issued for this project, so rotating it is up to whoever holds that Comput3 account.
  - **Not used.** The class was never constructed; the AI providers are still chosen by `AI_PROVIDER`, with `AI_API_KEY`.
  - **Still visible.** The key remains in this repository's history and in upstream.

### Still open
- Phase 2: method shadowing with host (non-native) arguments remains (the THREE prototypes themselves are now frozen, see Security), including interpolation, query/player getters and transitive matrix decomposition. Shared query vectors and live temporary output vectors remain script-reachable. This is not class hardening or instance sealing; the sentinel must be revisited when prototypes are hardened.
- Healthy physics shapes still do not resize on later scale edits (a skipped one mounts again once its transform changes).
- Persisted app repair and finite float32 checks at converted PhysX pose boundaries do not validate arbitrary script-composed transforms or every geometry. The player-transform hotfix already closed the octree expansion hang.
- Pending asynchronous native continuations after fatal shutdown remain a Phase 3b-1 residual; stopping ticks is not a global cancellation of native work. Generation-bound physics capabilities and a full teardown transaction are deferred. Emscripten abort state requires a restart; the dormant `prim-physics-test` example's direct PHYSX usage remains a follow-up. XR physical movement requires code review/headset verification.
- Model, avatar and emote limits: cost inside three.js and three-vrm that multiplies in ways the parser's charges do not capture is not proven absent; each review so far found another such place. Strings and extras are now small at the door, so what is copied, scanned or keyed once per object is at most 1024 characters a string and 64 KiB an object; what that still multiplies is bounded, not charged: three-vrm compares each VRM 0 material value's name, with " (Outline)" appended, against every material in the scene (at most 1024 characters a comparison, the walk counted); and each clone of a parsed scene after the parse (an avatar for each player) copies its userData, up to 8 MiB of JSON: about 180 MB held for the worst shape (lists of empty objects, 64 KiB an object), for each clone; an instanced export with small custom properties holds a few MB. The time limit refuses at the next charge after 10 s, but one long loop inside a library runs to its end, on the main thread. Up to 2^26 steps of work plus one per byte, and up to 10 s, may run on the main thread before a refusal (a file built to reach the work limit through one walk is refused after about 1.4 s on a desktop; a phone is slower). The server parses models and emotes with the same vendored parser without the check before it, a budget or a time limit (wiring them in belongs to another change set). The limits are per file and sized for VRoid avatars, 320 MiB of allocations beyond twice the file: with up to 12 files parsing at once inside the transfer slots (and files a user just picked taking none), a world of hostile files can hold several gigabytes at once before each is refused. Most of a VRoid avatar's cost is the morph textures three.js builds for each face geometry over all of the face's vertices; three-vrm's `VRMUtils.removeUnnecessaryVertices` would cut that, and the client does not call it. An avatar with far more blend shapes than VRoid's 56 (a "perfect sync" face of over 100, on as many primitives) may need more than the byte limit; none was measured. VRoid can export 4096 x 4096 textures, which have about twice their size to spare under the 36-megapixel limit per image (the samples' largest is 2048 x 2048). The time counts waiting too (an image decode, other parses interleaved), so a slow device loading many files at once could refuse a large honest one. Values inside the binary data are not read before parsing: index values beyond the vertex count, joint indices beyond the skin (a TypeError when the avatar is measured, so it fails to build), NaN or huge floats. three-vrm is bounded by counts computed before it runs; it is not metered while it runs. After parsing, turning a model into world nodes, cooking physics meshes and uploading to the GPU are bounded only by what was charged (sizes), not in time.
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
