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
- server: remote models, emotes and scripts named by a blueprint are fetched through one outbound request policy (`src/core/extras/outboundFetch.js`). App scripts' `fetch` will be routed through it as well; it still uses the global fetch for now. Avatars are stubs on the server and are not fetched.
  - **Where it may connect.** `http` and `https` only, no credentials in the URL, and only public addresses. IPv4: loopback, private, link-local (cloud metadata), carrier-NAT and the other special ranges are refused. IPv6: an address is refused when it is not global unicast (`2000::/3`), so loopback, link-local, unique-local, multicast, NAT64 and the IPv4-compatible and IPv4-translated forms are refused, or when it is in a special-purpose range inside it (the `2001::/23` protocol assignments such as Teredo and ORCHID, documentation, 6to4) or in the returned 6bone space `3ffe::/16`. An IPv4-mapped address follows the IPv4 rules. No allocation table is kept: an unallocated block inside `2000::/3` is admitted (it has no route on the public internet), so new address space works once it is allocated. The host is resolved once through DNS (A and AAAA; the hosts file is not consulted), every address must be public, and the connection is made to a checked address, so a second DNS answer cannot change the destination. The first IPv4 answer is used, or the first IPv6 one; if connecting to it fails (refused or unreachable) or has not connected within a third of the time left, but at least 250 ms, one more checked answer is tried, of the other family when there is one. That attempt is still within the one deadline: a deadline shorter than the first attempt's 250 ms ends the request before it. The connected address is checked again before anything is sent, and TLS is verified for the URL's name. Redirects (at most 3) pass the same checks, and the body of a redirect that is followed is not read.
  - **Limits.** One deadline covers the whole request: resolving, connecting, redirects and the body. A remote load may take 30 s and 32 MiB of decoded body. At most 16 requests run at once and more are refused rather than queued; a request keeps its slot until its DNS queries have ended. The slots cover the exchanges only, not what a caller does with a response afterwards (the loader's parsing has its own bound, below). Responses being received share a 64 MiB budget, which covers a request until its response is handed over (the body is held once, as received); what the caller then reads or keeps is the caller's memory. The handed-over body still follows the caller's `signal`, as fetch's does: an abort before it is read to the end (an empty body included) makes reading it reject with the signal's reason, an `AbortError` for a plain `abort()`. A response without a body (HEAD, 204, 205, 304) has nothing to abort: reading it after an abort gives `''`, as native fetch does on Node 24 (on Node 22 native fetch rejects). Bodies are decoded from gzip and deflate only, and a response without a body (HEAD, 204, 205, 304) is not decoded.
  - **Requests.** The options are fetch's: `method` (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS), `headers` (repeated names are combined as fetch combines them, Cookie with `; `; every header sent, the ones the policy adds included (Host, Accept-Encoding, `Connection: close`, Content-Length, which is also `0` for a POST, PUT or PATCH without a body, and an inferred Content-Type), is set explicitly, so Node adds none, and is validated and counted before anything is resolved or sent: at most 64 and 16 KiB of names and values in all, so a GET, HEAD, DELETE or OPTIONS without a body leaves 61 to the caller and a POST of a string 59; a Blob's type must be a string), `body` (a string, an ArrayBuffer, a typed array or DataView, or a Blob, at most 1 MiB, with the Content-Type fetch infers), `signal` and `redirect` (`follow`, `manual` returns the redirect, `error` rejects; an empty `Location` is the same URL again). A request that a redirect turns into a GET loses its body and fetch's request-body headers (Content-Encoding, Content-Language, Content-Location, Content-Type). `mode`, `credentials` and `cache` mean nothing on the server and are ignored; any other option, and a GET or HEAD with a body, is refused.
  - **Trusted origins.** The world's own assets URL is exempt from the address check (it is local in development and may be a private object store). `OUTBOUND_TRUSTED_ORIGINS` lists further origins, comma separated. Upgrade note: a world whose blueprints load from a host on a private network must list that origin.
  - **Models.** On the server a model or emote may only use what is inside its file (`data:` and `blob:` URIs): nothing outside the file is ever requested. An external buffer fails the load; an external image is not fetched, and the model loads without it (the server draws nothing).
  - **Cache.** The server loader keeps at most 512 finished loads of every kind and location (the world's store and remote URLs alike), the least recently used leaving first. A load in progress is never dropped, so while more than 512 are in progress the cache holds them all. What loads in progress hold is bounded per kind: models and emotes, local and remote alike, are read and parsed in 4 turns (a turn covers the read and the parse, and the others wait in order without having read anything). A deadline frees a turn whose read (30 s) or parse (60 s) does not settle: that load fails and the turn goes to the next. A read given up is cancelled (its outbound request is aborted, a local read stops); a parse cannot be, so a parse whose turn expired may still be running, and holding its memory, until it settles, outside the 4 turns. A deadline cannot interrupt a parse that blocks the event loop, and a phase that completes before its timer has run is accepted however long it took, so a large but valid model still loads on a slow host. A destroyed loader fails the loads waiting and those in a turn, and starts nothing for them, a remote script takes one of the 16 outbound slots while it downloads, and a local script read has no bound of its own. A load that finishes after it was replaced or after the loader was destroyed writes nothing. One resource has one entry whatever its spelling (surrounding spaces, a fragment, a default port); an `asset://` name and the assets URL it maps to share one where assets are read over HTTP, while with a local assets directory the file and the URL are separate resources and keep separate entries. A query names another resource. Failed loads are not kept, so a URL that starts working is loaded on the next request. Every avatar shares one entry.
- scripts: `world.set` has limits, and `world.get` returns a copy. A key is a string of 1 to 128 characters, a value at most 64 KiB as JSON, at most 1,024 keys and 4 MiB in total (`STORAGE_MAX_KEYS`, `STORAGE_MAX_VALUE_BYTES`, `STORAGE_MAX_BYTES`). A `set` past a limit throws and leaves the store as it was; it used to grow without bound, and each write rewrote the whole file. A store that is already larger loads as it is and may shrink; a key stored before the key rule (longer than 128 characters, or empty) can still be overwritten without growing and deleted. `world.set(key, undefined)` deletes a key (it used to log an error and change nothing), and a value that cannot be turned into JSON throws (it used to be logged and dropped). `world.get` used to return the stored object itself, so one app could change what another read without calling `set`. Both are now documented in `docs/scripting/world/World.md`.
- scripts: `world.set` throws ("the server is stopping") once the final save on shutdown has started, so the server never acknowledges a value it will not write. When the stop begins, app timers are cleared and no app starts its script again: a build still waiting for its assets, a crash rebuild or a blueprint change does nothing from then on.
- server: an upload is refused (`507`) when free space cannot be read, instead of being let through.
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
- nodes: an in-place edit of a UI node's `offset` (`ui.offset.x = 5`) now rebuilds the UI. The node used to overwrite the vector's `_onChange` method instead of registering a callback. A cloned UI node gets its own offset vector instead of sharing the source's.
- server: stopping the server saves the world first. SIGINT and SIGTERM used to close the listener and exit, so every stop (a deploy, an auto-stopped machine) lost up to `SAVE_INTERVAL` seconds of blueprint and app edits and the pending script-storage write.
  - **The stop.** The first signal stops the world (ticks and app timers), stops accepting connections and runs the final save under a 3.5 s deadline (inside Fly's default 5 s), then exits 0, or 1 with a list of what was not saved. A second signal exits at once.
  - **The deadline holds.** Database rows and queued config writes are written one at a time with a turn of the event loop between them and the clock checked before each, so a slow disk (better-sqlite3 writes synchronously) cannot run the save past its deadline or keep a second signal from being handled. Rows are not grouped in transactions: on Postgres one failing statement would fail the rest of its transaction. On Postgres the queries are asynchronous anyway.
  - **During start-up.** The handlers are installed before anything is loaded. A signal before the world exists exits 0 (there is nothing to save, and the log says so); from the moment the world is created, before its scripts start and before the server listens, a signal runs the final save.
  - **Listening.** The server listens only once the network has loaded the world, the user ids and the join-state accounting and has measured the join snapshot's fixed part (start-up used not to wait for that), and it refuses a connection or packet that comes earlier.
- server: `storage.json` (script storage) and uploaded assets are written to a temporary file, flushed, and renamed into place, so a stop or a full disk mid-write no longer leaves a cut-off file under the final name. The directory is flushed after the rename too; only where the filesystem cannot do that (`EINVAL`, `ENOTSUP`, `EOPNOTSUPP`, `EPERM`, `EISDIR`) is that step skipped, and any other failure counts as a failed write, which is retried. Storage writes no longer overlap.
  - **Unreadable storage.** A `storage.json` whose content is not a JSON object is moved to `storage.json.corrupt-<time>` and reported; it used to be replaced by an empty store without a word. A file that cannot be read at all (`EIO`, `EACCES`, `EMFILE`, …) is read again for about a second; if that still fails, it is left exactly as it is and the store is off for that run (`world.set` throws, `world.get` returns `undefined`), with one log line.
  - **Assets.** An asset whose stored size differs from an upload of the same content hash (a cut-off write from before) is replaced; unfinished uploads are removed at start-up and are never served. An upload whose directory flush failed (the file is complete but not known to be durable) is flushed again by the next upload of the same content before it is answered "already stored". The upload check (`/api/upload-check`) does the same: it waits for a write of that name in flight, flushes a name whose flush failed before it says the file exists, and says it does not when that fails again, so the client uploads and the upload tries once more.
- server: with `ASSETS=s3` the clean-up deleted nothing and logged success (`delete` was given a Set and read `.length`). The S3 content types now cover every uploadable extension. A key S3 answers with an error (`AccessDenied`, …) is reported as not deleted instead of being counted.
- core: `World.resolveURL` put `ASSETS_BASE_URL` into an `asset://` URL as a replacement string, so `$&`, `$'`, `` $` `` or `$$` in it changed the URL every loader requested (`https://host/$&/assets` made `asset://x.js` a request for `https://host/asset://assets/x.js`). The base is now put in literally.
- server: the clean-up (`CLEAN`) has a stated contract, keeps what the world names by its file name whatever URL it is written in, deletes nothing when it cannot read what it must, and, with `ASSETS=local`, moves what it removes to a trash instead of unlinking it.
  - **The contract.** It keeps every store file whose name appears as a literal in the persisted world data or in the source of a store script reachable from that data, and deletes nothing when it cannot read something it must read. The code it follows is exactly: the store file a blueprint's script names, whatever its extension, and any `.js` store file named as a literal in that data or in code it follows. It cannot see, so such a file is removed: a name computed at run time (`'abc' + 'def.glb'`, a template, a hash) or written with JavaScript escapes (`'\x61bc.glb'`); code built at run time, that is code a script fetches or assembles and evaluates itself (`fetch` and `Function`), wherever it is hosted, the store included, and whatever that code names (no engine API runs another script: `world.load` takes models and avatars only, and an app's script is its blueprint's); references inside binary assets (a model's external image or buffer URI, which the loaders do not follow: models, avatars and emotes use their embedded data). Worlds that rely on any of these must run with `CLEAN=false`.
  - **What keeps a file.** Its name, found anywhere in apps, the blueprints that stay and collection blueprints (both as stored and as hydration loads them, with model and script cut at 2,048 characters), settings, user avatars, script storage (parsed, so JSON escapes are decoded; a copy set aside as unreadable is read as text), and the source of the code it follows, to a fixed point (a `.js` name the store listing leaves out, which holds content-hash names only, is asked of the store, at most 4,096 of them, and names nothing when there is no such file; one that is there but cannot be read stops the clean-up). The text is cut at every character a store name cannot hold, and a file is kept when a piece equals its name in any case, also percent-decoded (a run of up to 4,096 characters, at most 8 times), without dots, `_` or `-` at its ends, and with tabs, CR and LF inside it dropped (as the URL parser drops them), in one loop with the decoding (each pass drops them, then decodes once), so escapes and dropped controls in any order and position are undone, and what decoding brings in (`%09`, `%0D`, `%0A`) is dropped too. No URL is resolved for this, so a host, port, path prefix, `..`, query or CDN spelling cannot hide a name; ignoring case keeps what a case-insensitive file system loads from `asset://<NAME>`. A file named like a common word is kept whenever that word appears.
  - **When nothing is removed** (logged once; in these configurations cleaning never runs and the store only grows): a database row or `storage.json` does not parse as JSON, or a row has the wrong shape; `storage.json`, a set-aside copy or a script it must read cannot be read, including a store script that is missing, in every configuration (a CDN or cache in front of the store may still serve it), one that cannot be opened (the log names the blueprint), a file larger than the larger of `PUBLIC_MAX_UPLOAD_SIZE` and `STORAGE_MAX_BYTES` (read before, whole, up to Node's own limits), and an S3 script object stored with a content encoding other than gzip or deflate, with more than two codings or expanding past that size (gzip and deflate are decoded as the server's fetch decodes them, each stage held to it); a text holds a percent-encoded run longer than 4,096 characters or still encoded after 8 decodings (a store URL encoded once as a whole fits; deeper nesting used to be decoded at a cost that grew with the square of its length); `ASSETS_BASE_URL` is not clean: it must start with a lower-case `http://` or `https://` and have no query, fragment, userinfo, backslash, dot segment, empty path segment or trailing slash, in its normalised form (a relative, protocol-relative, `https:/host` or `?rev=` base stops it; start-up validation of the variable is unchanged); a database value (a row's data, the settings, an avatar) is larger than the read limit; more than 4,096 `.js` names are not in the store listing; a kept blueprint or collection blueprint has a script that is not a store file for certain. Only `asset://<name>` is one, or a URL that starts with a lower-case `http://` or `https://` (what both the runtime mapping and the server's loader take as remote), that the runtime leaves unchanged, with no userinfo and no `?`, `#`, `%`, backslash or `.`/`..` segment in its text, and whose normalised form is directly under `ASSETS_BASE_URL`. A script hosted elsewhere, a page path such as `/assets/x.js` or `blob/../assets/x.js` (a proxy may serve another application there), a spelling the runtime rewrites (`https:/host/x` becomes `https://https/host/x`, a tab in the scheme, `HTTPS://`, which the server's loader refuses) or a legacy encoded or query spelling all stop it. Only a value starting with a lower-case `blob:` (what `URL.createObjectURL` returns, and what the runtime leaves alone) is no script; `Blob:443/app.js` is fetched from a host named blob, so it stops the clean-up too.
  - **Assumptions.** The server process is the only writer of the store, the trash and the database while it starts (uploads are not accepted until cleaning has finished; other processes changing those files at the same moment are not supported). Database tables are read whole, as the world itself reads them when it starts; the read limit applies to each value, not to a table's total. With the local store a removal is recoverable for CLEAN_TRASH_DAYS; with S3 it is not (turn on bucket versioning).
  - **The trash.** With `ASSETS=local`, removed files go to `<world>/assets-trash/<UTC date>/<name>` beside the assets directory (the same file system, so a rename; never served, never listed, on the disk the free-space check measures), one log line with the count and the folder. Folders at least `CLEAN_TRASH_DAYS` old by their UTC date (30 by default, so a file can go up to a day sooner than that after it was moved; `0` deletes at once and empties the trash, folders dated in the future included) are removed once discovery is complete, after anything trashed that is named again has come back from its newest copy that is still there (logged). If none of a named file's copies is there any more, that is logged and the trash is not purged that run. Nothing comes back while `ASSETS_BASE_URL` is not clean: the clean-up then stops before it looks. Before the purge, a kept file that is also trashed must still be in the store; if another process removed it, its trashed copy comes back, and if that fails the trash is not purged. With `ASSETS=s3` objects are deleted: turn on bucket versioning to keep a way back.
  - **Dry run.** `CLEAN=dryrun` changes nothing and names what would be removed (up to 50), what would come back from the trash, and which trash folders would be removed.
  - **No longer a stop.** A prop holding a non-string `url` (props accept any JSON) used to disable cleaning for the whole world; it is now just text.
  - **Cost.** Linear in the text: two walks over it without copying it, a percent-encoded run decoded at most 8 times and only up to 4,096 characters, every file read through one handle and counted up to the limit above, each place that holds an undecidable run recorded once (the log names the first 20). A world of 5,000 files and a 50 MB corpus is cleaned in under a second; 256 KB of nested encoding, or 40,000 places with such runs, stop it in a fraction of a second. The database tables are read whole (see Assumptions).
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
- server: a builder could make the world impossible to join, and keep it that way across restarts. App entity ids had no length limit and nothing bounded how much the apps add to the join snapshot, so 36 `entityAdded` packets with 30,000-character ids (or about 7,300 ordinary ones) pushed the snapshot over its 1 MiB cap; every later join then failed, admins included, until the database was edited by hand.
  - **Ids.** A new app's id is 1 to 64 characters of `A-Z a-z 0-9 _ -` (what the client generates fits) and cannot be the id of any user this world knows, present or away (players and apps share one id space, and an app holding an absent user's id would have collided with that user's next join). The server keeps the user ids in memory for that (about 60 bytes each: 6 MB for 100,000 users). It refuses a second entity with an id that already exists, and a `blueprintAdded` for an id that already exists (changing a blueprint takes `blueprintModified` and its version rule).
  - **An app that already holds a user's id** (stored before this rule) moves to a new id when that user joins: it is removed and added again under the new id with its blueprint, transform, pinned flag and state (state a script made unreadable becomes `{}`), broadcast, and logged once with both ids. The player joins as usual. The move cannot lose the app: the new row and the old row's removal are written in one transaction, so a stop leaves the app under one id; a failing app teardown does not stop it. (The server's database is always knex on SQLite or Postgres, which has transactions. Only a stand-in database without them, in tests, writes the new row first and can be left with the app under both ids, which nothing merges at start-up.)
  - **World budget.** Blueprints, app entities, settings and collections together may take 768 KiB of the join snapshot. A change that would go past that is refused the way an over-budget blueprint already was (the sender's copy is reverted, one log line per connection), whether it comes from a client, a server script or the AI, and a settings change too. A blueprint change that rebuilds its apps counts the client-set app state it empties. The 512 KiB blueprint budget still applies.
  - **The rest fits by construction.** What no budget tracks is dropped from a snapshot that does not fit, one step at a time and only as far as needed: the voice state of players who left, the chat history, players' effects, app state a server script assigned, and last other players' avatars and emotes (the joiner sees the default avatar until their next change). What cannot be dropped is counted as at most 1 KiB per player (measured worst case 695 bytes) plus the snapshot's fixed part: the joiner's own record, the URLs, the upload size, the AI names and the session and voice tokens. The fixed part is measured, not assumed: the server measures it at start-up for the largest joiner its configuration can have (8,811 bytes for `.env.example`, 9,378 with LiveKit, 18,903 with a 4,096-character `LIVEKIT_API_KEY`) and logs when it is over the 24 KiB expected, and each join measures its own. The snapshot carries the upload size as the number the server parsed (a `PUBLIC_MAX_UPLOAD_SIZE` padded with zeros used to be sent as written). The steps taken are logged once per combination.
  - **Joining.** A join is admitted when the real snapshot, after its steps, fits the cap; that is the only hard condition, and a snapshot that cannot fit is refused with the `player_limit` kick before any player is added (it used to close with 1011). The counted world state is an upper bound: a world stored over its budget (for example 5,100 apps: 1,035,412 bytes counted, a 592,143-byte snapshot) still takes a user with a stored rank, so an admin can come in to shrink or moderate it.
  - **Visitors.** A joiner without a stored rank of builder or above (the rank on the user's row; a free-build world rank, admin for everyone without `ADMIN_CODE`, and a session-only token grant do not count) must also leave room: with them here, the bound W + fixed part + P × 1 KiB ≤ 1,047,552 must still hold for 8 more players and 64 KiB more world state. Otherwise they get the `player_limit` kick (logged once per reason), before `WS_MAX_SOCKETS` or `playerLimit` would refuse them. A full 768 KiB world takes 174 visitors and an empty one 940 (159 and 925 with a 24 KiB fixed part); after them, 73 ranked users fit the bound at the full world, and 64 KiB of growth and 8 ranked users at the empty one. So 231 visitors can no longer keep an admin out, and 998 can no longer stop a 1 KiB addition. `connectionLimits` has no rank reservation of its own: `WS_MAX_SOCKETS` still counts every socket.
  - **Growth.** World growth is admitted against the players present (at least 64) with the measured fixed part, so 64 players always fit a world at its budget. To keep the counted parts bounded, the server refuses to start with `ASSETS_BASE_URL`, `PUBLIC_API_URL` or `LIVEKIT_WS_URL` longer than 1,024 characters or `AI_PROVIDER`, `AI_MODEL` or `AI_EFFORT` longer than 128, and a joiner's own stored avatar longer than 2,048 characters (only legacy data can be) falls back to the default.
  - **Existing worlds.** A world that is already over the budget loads whole, reports its totals and five largest items at start-up, and may shrink but not grow. When the counted total is over the snapshot cap too, the report says so as a count: visitors are refused, and a user with a stored rank joins while the real snapshot fits. Nothing stored is dropped or rewritten.
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
