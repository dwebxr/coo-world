This repository is for technical experimentation and access control testing. Not investment advice. No purchase instructions.

# Coo World 🌐

<div align="center">
  <img src="overview.png" alt="Coo World" width="100%" />
  <p>
    <strong>A customized 3D virtual world built on Hyperfy</strong>
  </p>
</div>

## What is Coo World?

Coo World is a customized 3D virtual world built by forking and extending [Hyperfy](https://github.com/hyperfy-xyz/hyperfy), an open-source framework for building interactive 3D virtual worlds. It combines Hyperfy's powerful physics engine, networked real-time collaboration, and component-based application system with custom features like Solana token gating for access control.

## 🧬 Key Features

- **Standalone persistent worlds** - Host on your own domain
- **Realtime content creation** - Build directly in-world
- **Interactive app system** - Create dynamic applications with JavaScript
- **Portable avatars** - VRM avatars; visitors can upload their own when the world's Custom Avatars setting is on
- **Physics-based interactions** - Built on PhysX for realistic simulation
- **WebXR support** - Experience worlds in VR
- **Extensible architecture** - Highly customizable for various use cases

Based on [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) v0.16.0

## 🚀 Quick Start

### Prerequisites

- Node.js 22.23.5, the version in `.nvmrc` and in `engines` of `package.json` (via [nvm](https://github.com/nvm-sh/nvm) or direct install)

### Installation

```bash
# Clone the repository
git clone https://github.com/dwebxr/coo-world.git my-world
cd my-world

# Copy example environment settings
cp .env.example .env

# Set your own JWT secret (the server refuses to start without one)
sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env && rm .env.bak

# Install dependencies
npm install

# Start the development server
npm run dev
```

### Docker Deployment

For containerized deployment, check [DOCKER.md](DOCKER.md) for detailed instructions.

### Uploads

Files enter a world through `/api/upload`. With `ASSETS=local` they are served back from `/assets/`; with `ASSETS=s3` browsers load them from `ASSETS_BASE_URL`:

- Uploading needs a live session. The client sends its session token as `Authorization: Bearer`, and the server accepts it only from a user currently connected to the world with builder rank or higher. While **Custom Avatars** is enabled in the world settings, any connected user may upload a `.vrm` avatar.
- Only `glb`, `vrm`, `js`, `jpg`, `jpeg`, `png`, `webp`, `mp4`, `mp3` and `hdr` files are accepted; binary types are checked for a file signature (a `jpg`, `jpeg`, `png` or `webp` file may carry the signature of any of those three image types; the check reads the start of the file and does not validate the rest), and `PUBLIC_MAX_UPLOAD_SIZE` (MB) is enforced server-side. A request must declare its `Content-Length` (411 otherwise) and must not be compressed (`Content-Encoding` other than identity is 415).
- Rate limits and quotas (`UPLOAD_*` in `.env.example`, `0` disables one): one upload in flight per user and a global cap of in-flight uploads; uploads per minute and new bytes per 24 h per user, with a builder tier and a visitor tier chosen by the effective rank; per-address limits at 4x the visitor values, a share of the in-flight slots and a shared daily budget for everyone without a builder rank stored on their user (an identity minted by a fresh connection never counts as a builder here, even in a world whose settings grant builder to everyone). An admitted upload must deliver its body within `UPLOAD_SLOT_TIMEOUT_S`. A refusal that concerns the user or their network is a `429`, one that concerns the whole server a `503`; both carry `Retry-After` and `retryAfter` (seconds) in the JSON body, and the client retries once when that is five seconds or less. Counters live in memory and reset when the server restarts; `UPLOAD_MAX_TRACKED` bounds how many untrusted identities and addresses are kept, and while that table is full of records with live windows, untrusted identities not yet in it are answered `503` until one expires (stored-rank builders and admins are never held to it). A builder rank granted for the session by a verified wallet token is trusted like a stored rank, with its rate and quota keyed to the wallet rather than the user: identities minted under one wallet share one builder bucket. A rank that comes only from the world setting stays untrusted. Because tokens can move between wallets, `UPLOAD_RESERVED_TRUSTED` slots of the total are kept for stored-rank builders and admins: untrusted and wallet-backed sessions together never hold more than the rest. `/api/upload-check` answers `429`/`503` with `retryAfter` when the upload that would follow it would be refused, so a refusal reaches the client on a request without a body; the upload itself still decides. The client sends uploads one at a time per tab.
- Free space (`ASSETS=local`): an upload that would leave less than `UPLOAD_MIN_FREE_MB` (or a fifth of the volume, whichever is smaller, so a host that grows volumes at 75% used still can) is refused with `507`. Each upload is checked against the free space at that moment and nothing is reserved, so uploads that arrive together, and anything else writing to the volume (the world database shares it), can still take it below the floor. If free space cannot be read, uploads are refused with `507` as well, and a warning is logged once per kind of failure.
- Behind a proxy, the per-address limits key on the header `UPLOAD_CLIENT_IP_HEADER` names. When that variable is not set at all and `FLY_APP_NAME` is (the server takes that to mean it runs on Fly), they key on `Fly-Client-IP`. Otherwise, and when the variable is set but empty as in `.env.example`, they key on the socket address. IPv6 addresses are grouped by `/64`.
- Assets served by this server (`ASSETS=local`) carry `X-Content-Type-Options: nosniff` and an explicit content type. Scripts, HDRs and anything that is not plain image/video/audio/model media are delivered as sandboxed downloads, so a file served under these rules cannot run as a page on the world's origin. Scripts are served as plain text: the loaders read their text, and with `nosniff` a browser refuses one as a `<script>`, a worker or a module.
- Pages: the world page and the static pages (on every answer, a 304 included) say who may frame them (nobody: `frame-ancestors 'none'` and `X-Frame-Options: DENY`), forbid `<base>`, plugins and forms posting to other sites, and say a `Permissions-Policy` that, in browsers that implement it (Firefox does not), keeps the camera, the location, the Payment Request API (not wallet requests, which do not use it) and USB devices from the page and its frames. Every reply a route of the server makes says `nosniff`; a WebSocket upgrade and the errors the HTTP layer writes itself before any route runs (a 400 for a URL it cannot decode, a 408, a 431) do not. This is not a policy on scripts or connections (see the changelog). `HSTS_MAX_AGE` (seconds) turns on `Strict-Transport-Security`.
- Pages, the full policy (`CSP_MODE`): the world page also carries a policy on scripts, styles, frames and workers. `CSP_MODE` says how it is sent; it is read at start-up, any other value stops the start-up, and the server says the mode in its log (`[envs] CSP_MODE=report: …` or `[envs] CSP_MODE=enforce: …`). The other pages get the four directives above alone, in either mode.
  - `report`, the default (also when unset or empty): as `Content-Security-Policy-Report-Only`, beside the four directives. **It protects nothing**: browsers load and run everything as before and post what the policy would have refused to `POST /csp-report`, and the server writes a line for each kind of report when an hour first sees it and again at 10, 100, 1000 of it (`[csp] report-only: <directive> would refuse <origin, scheme or word>, asked by <file>`) so an operator can see what enforcing it would break (wallet extensions, wallet in-app browsers) before it is enforced.
  - `enforce`: as the world page's one `Content-Security-Policy`: the same policy and nonce with `frame-ancestors 'none'` added (so it holds the four directives above), and no report-only header. Browsers refuse a script that is neither one of the page's own files, the script editor's from cdnjs nor an inline script with the response's nonce (inline handlers included), a stylesheet or font file from a host other than the page's or the script editor's folder, a frame other than WalletConnect's Verify, and a worker not from the page or `blob:`; they post what they refused to the same route, and the line says so (`[csp] enforced: <directive> refused <…>, asked by <file>`). What it does not stop: `'unsafe-eval'` stays (app scripts are evaluated with SES), so text that reaches an `eval` of the page's own code still runs; whoever controls the script editor's folder on cdnjs still runs code in a builder's page; `style-src` keeps `'unsafe-inline'`, so injected CSS is not stopped; images, media and connections may go to any host, so a page that was got into can still send data out. App scripts are not limited by it at all, and neither are a visitor's browser extensions (their own scripts run outside it). A script element an extension writes into the page is checked as any other: an inline one without the nonce, an inline handler or a script of another host is refused, which is why the check with real wallet extensions and wallet in-app browsers comes before enforcing; one whose `src` is on the page's own origin or in the script editor's cdnjs folder runs. Unsetting it, and a restart, goes back to `report`.
  - In either mode anyone can post to that route, so a line says what was posted, not what a browser did; the words of a line follow the server's mode, not what a post says of itself. An address gets 20 posts a minute and the server takes 600 a minute (counted before a body is read), a report is 8 KiB at most and may not be compressed, and an hour writes at most 100 kinds. Nothing of a report is kept but the directive's name, an origin or scheme, and the path of one of the page's own files.
- Limits: the response headers are not applied to S3-served assets (`ASSETS=s3`), which need an equivalent object or CDN policy. The content type is stored with each S3 object when it is written: the built-in assets are written again at every start, but a script uploaded before scripts were typed `text/plain` keeps `text/javascript` until its metadata is changed in the bucket (uploading the same file again writes nothing). Files uploaded before these rules may still exist in the assets directory and in browser caches; before deploying, scan the existing assets for document-type files (`html`, `svg`, …) and review what references them.
- Clean-up (`CLEAN=true`, or `dryrun` to only log what would happen): at start-up, blueprints no app uses are deleted, and so are the uploaded assets nothing names.
  - **What it keeps.** Every store file whose name appears as a literal in the persisted world data (apps, the blueprints that stay, collections, settings, user avatars, script storage) or in the source of a store script reachable from that data. The code it follows is exactly: the store file a blueprint's script names, whatever its extension, and any `.js` store file named as a literal in that data or in code it follows, listed or not (a `.js` name the store listing leaves out, which holds content-hash names only, is asked of the store, at most 4,096 of them, and names nothing when there is no such file). Names are matched in any case, percent-decoded, and with tabs and line breaks inside a URL dropped (in one loop with the decoding, so in any order), whatever URL they are part of.
  - **What it cannot see**, so that file is removed: a name computed at run time (`'abc' + 'def.glb'`, a computed hash) or written with JavaScript escapes (`'\x61bc.glb'`); code built at run time, that is code a script fetches or assembles and evaluates itself (`fetch` and `Function`), wherever it is hosted, the store included, and whatever that code names (no engine API runs another script: `world.load` takes models and avatars, and an app's script is its blueprint's); references inside binary assets (a model's external image or buffer URI, which the loaders do not follow either: models, avatars and emotes use their embedded data). A world that relies on any of these must run with `CLEAN=false`.
  - **When it removes nothing at all** (the reason is logged): a database row or `storage.json` does not parse as JSON, or a row has the wrong shape; a database value (a row's data, the settings, an avatar) is larger than the largest upload or storage file allowed; `storage.json`, a set-aside copy of it or a script it must read cannot be read, including a store script that is missing (a CDN or cache may still serve it), one that cannot be opened, a file larger than the largest upload or storage file allowed (`PUBLIC_MAX_UPLOAD_SIZE`, `STORAGE_MAX_BYTES`) and, with `ASSETS=s3`, a script stored with a content encoding other than gzip or deflate or one that expands past that size (the log names the blueprint); a text holds a percent-encoded run longer than 4,096 characters, or one still encoded after 8 decodings; more than 4,096 `.js` names are not in the store listing; `ASSETS_BASE_URL` is not clean: it must start with a lower-case `http://` or `https://` and have no query, fragment, userinfo, backslash, dot segment, empty path segment or trailing slash, in its normalised form (a relative, protocol-relative or `?rev=` base stops it); a kept blueprint or collection blueprint has a script that is not `asset://<name>` or a URL starting with a lower-case `http://` or `https://` that is directly under `ASSETS_BASE_URL` with no userinfo, `?`, `#`, `%`, backslash or `.`/`..` segment (a script hosted elsewhere, a page path such as `/assets/x.js`, a spelling the loaders rewrite such as `https:/host/x` or `HTTPS://`, a legacy encoded or query spelling: its source could be anything). In these configurations cleaning never runs and the store only grows.
  - **Assumptions.** The server process is the only writer of the store, the trash and the database while it starts (uploads are not accepted until cleaning has finished; other processes changing those files at the same moment are not supported). Database tables are read whole, as the world itself reads them when it starts; the read limit applies to each value, not to a table's total. The assets URL serves each store file's own bytes: a redirect, a rewrite or a cache in front of it that answers a file's URL with something else is not supported (the clean-up reads the store, the world loads what the URL serves). With the local store a removal is recoverable for CLEAN_TRASH_DAYS; with S3 it is not (turn on bucket versioning).
  - **Recovering a file.** With `ASSETS=local` nothing is unlinked: the files go to `<world>/assets-trash/<UTC date>/` beside the assets directory (never served or listed, on the same disk the free-space check measures) and are removed for good after `CLEAN_TRASH_DAYS` (30 by default; `0` deletes at once and empties the trash). Retention counts the UTC dates of the folders, so a file can go up to a day sooner than that after it was moved. A trashed file that is named again comes back at the next start-up, from its newest copy that is still there; if none is, that is logged and the trash is not purged that run. It does not come back while `ASSETS_BASE_URL` is not clean (the clean-up then stops before it looks). To bring one back by hand, move it into the assets directory. With `ASSETS=s3` the objects are deleted: turn on bucket versioning to be able to recover one.

### Connections and inbound packets

- Per client address, `/ws` admits `WS_CONNECT_BURST` new connections at once (default 20) and `WS_CONNECT_RATE_PER_MIN` sustained (10/min), with at most `WS_CONNECT_CONCURRENT_PER_IP` open at a time (8). IPv6 also has `WS_CONNECT_CONCURRENT_PER_56` (16) and `WS_CONNECT_CONCURRENT_PER_48` (32) concurrent limits. Its parent rate buckets use `WS_CONNECT_RATE_PER_MIN_56=20`, `WS_CONNECT_BURST_56=40`, `WS_CONNECT_RATE_PER_MIN_48=40` and `WS_CONNECT_BURST_48=80`. Setting either rate or burst to `0` disables that parent bucket. Every bucket and concurrency cap must pass before any tokens are charged. `WS_MAX_SOCKETS` (64) caps all admitted transports, including closing sockets, until TCP closes. `0` disables a limit; `WS_CONNECT_BURST=0` also requires `WS_CONNECT_RATE_PER_MIN=0`. Raising `WS_MAX_SOCKETS` raises the total write-backlog bound of 64 MiB at the default; setting it to `0` removes that bound. `WS_CONNECT_MAX_TRACKED` (40000) bounds the shared table of address and IPv6 parent buckets; newcomers are refused while the table has no idle entries. Refused upgrades receive HTTP 503 with `Retry-After: 10`, before any database lookup or snapshot. Ordinary HTTP GETs take no slot. Addresses are read as for uploads (`UPLOAD_CLIENT_IP_HEADER`, `Fly-Client-IP` where `FLY_APP_NAME` is set, or the socket address); IPv6 uses `/64`, and both IPv4-mapped spellings count as IPv4.
- A client message above 64 KiB closes the connection (1009). Below that, every packet is checked before its values are built: `entityEvent` (a script's `app.send`) up to 64 KiB; `blueprintAdded`, `blueprintModified` and `ai` up to 64 KiB and only from builders; everything else up to 32 KiB. Each connection has a token bucket of 2048 units refilled at 1024 a second; a packet costs one unit plus one per full 2 KiB and one per 32 decoded nodes, including failed scans. A refused packet is counted and logged once per connection and reason; the connection stays open. A blueprint, including its props, must fit in 64 KiB; an oversized change is refused in the client with a toast. On a world whose settings grant builder rank to everyone, every connection counts as a builder.
- All world blueprints together have a 512 KiB budget (`WORLD_BLUEPRINT_BYTES`), measured as the sum of their encoded server `blueprintAdded` packets. An add that exceeds it is refused and its optimistic entity removed; a modification that exceeds it is reverted. Existing worlds over budget still load with a warning and permit changes that do not grow the total. Blueprints, app entities, settings and collections together have a 768 KiB budget (`WORLD_JOIN_BYTES`, `src/core/extras/joinBudget.js`, with the same growth-only rule), so the join snapshot always fits its 1 MiB cap: what no budget tracks (chat history, players' effects and avatars, app state set by server scripts, voice state of players who left) is dropped from a snapshot that would not fit, step by step, and logged; what cannot be dropped is counted as 1 KiB per player plus the snapshot's fixed part, which the server measures at start-up for its configuration (about 9 KiB; it logs when that is over 24 KiB, which a very long `LIVEKIT_API_KEY` can cause). World growth leaves room for the players present (at least 64). A visitor (no rank of builder or above stored on the user) is refused with `player_limit` once their join would leave less room than 8 more players and 64 KiB of world growth need, so a crowd of visitors does not use up the room the join budget keeps for ranked users and for building: a full world takes about 174 visitors, an empty one about 940, whatever `WS_MAX_SOCKETS` allows. A user with a stored rank is admitted whenever the real snapshot fits, also in a world stored over its budget, so the join budget does not keep an admin out of a world that needs shrinking or moderating. The connection limits above are another matter: they are applied before the server knows who is connecting, so when the server is at `WS_MAX_SOCKETS`, or an address is at its own limits, an admin is refused like anyone else. Builders should keep large text out of props.
- The strict plain-msgpack decoder counts nodes at admission and builds values when the inbox is flushed. Fair per-socket scheduling spends at most 9,216 work units per tick (`work = nodes + floor(bytes / 128)`); under a full flood, a socket waits up to about 2 s for service at the default 64 slots. Each inbox has a guaranteed 160 KiB reserve and can grow to 1 MiB using a 16 MiB shared pool. Server-to-client output is capped at 512 KiB per packet and 1 MiB of backlog per client. The initial snapshot alone may use up to 1 MiB minus 1 KiB of write overhead (`SNAPSHOT_CAP`); crossing half that size logs a warning once per process. Scripts share 512 KiB of output per tick and skip recipients whose backlog would exceed 512 KiB. The protocol is now `v=2`; old tabs must reload. See [app.send](docs/scripting/app/App.md#sendname-data-skipnetworkid) for data types and return values.
- Ranks: in a `locked` world (production with neither `ADMIN_CODE` nor `ADMIN_OPEN=true`: nobody becomes admin by a code), an admin cannot lower their own rank, since the only way back would be an edit of the database. It is a guard against a slip, not a rule that an admin remains: an admin can still lower every other admin.
- Names, avatars and ranks of users: the server is the only writer of the `users` table and keeps what it has decided for a user until the database has taken it (`src/server/userRows.js`). A join puts those values over the row it read, as what the row holds, so a reload right after a change, or after an admin changed the rank, does not bring the old value back; a name the connection itself brings (the `name` query parameter of its WebSocket URL, which the browser client does not send) is applied after them, as before, and is that session's name. A write that fails is logged once for a run of failures of that user (`... not stored ...`) and written again only with that user's next change and at the final save at shutdown, which reports `users=N` and exits with 1 when the database still has not taken everything. Until then the session and every later join of that user have what the server decided: a rank an admin gave is the user's rank for as long as this server runs, written or not. This is not durability: a crash, a kill or a database that keeps refusing loses those changes, the server started next has what the database held (a rank that was never written is gone, a demotion that was never written is undone), and a value the database can never take fails each time it is tried. Edit the `users` table by hand only with the server stopped: while it runs, a value the server decided overwrites the edit at its next write of that column, and joins of a user with a change the database has not taken get the server's value.
- What builders can do: everything in the world. `pinned`, `scene`, `locked` and `frozen` are conveniences for builders (a pinned app is not moved by accident; a frozen app's model button is hidden in the app pane, and that is all `frozen` does so far), not permissions: any builder can change them, and the server does not enforce them. Give the builder rank only to people you would let rebuild or empty the world.

## 🧩 Use Cases

- **Virtual Events & Conferences** - Host live gatherings with spatial audio
- **Interactive Showrooms** - Create product displays and demos
- **Social Spaces** - Build community hubs for collaboration
- **Gaming Environments** - Design immersive game worlds
- **Educational Experiences** - Develop interactive learning spaces
- **Creative Showcases** - Display 3D art and interactive installations

## 📚 Documentation & Resources

- **[Docs](docs/README.md)** - This repository's documentation: commands, supported files and the app scripting API
- **[Changelog](CHANGELOG.md)** - What this fork changed, under `[Unreleased]`
- **[Docker](DOCKER.md)**, **[Migration notes](MIGRATIONS.md)**, **[Contributing](CONTRIBUTING.md)**

Upstream Hyperfy, the engine this world is forked from. These pages are upstream's and describe upstream, not this fork:

- **[Hyperfy documentation](https://docs.hyperfy.xyz)**
- **[Hyperfy website](https://hyperfy.io/)**
- **[Hyperfy sandbox](https://play.hyperfy.xyz/)** - Try upstream Hyperfy in your browser

## 📏 Project Structure

```
docs/              - Documentation and references
src/
  client/          - Client-side code and components
  core/            - Core systems (physics, networking, entities)
  server/          - Server implementation
CHANGELOG.md       - Version history and changes
```

## 🔐 Solana Token Gating

This world implements token gating via Solana wallet connection. A visitor whose verified wallet holds the required amount of a token is made a builder for the session.

### Try it Live (Coo World)

🌐 **[https://play.dwebxr.xyz](https://play.dwebxr.xyz)**

Connect a Solana wallet holding **100,000 COO** tokens to receive builder permissions.

- **Token Mint Address**: `8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump`
- **Required Amount**: 100,000 COO

### Configuration

Add the following environment variables to your `.env` file:

```bash
# Token mint address (SPL token address). Setting it turns token gating on
PUBLIC_TOKEN_MINT=8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump

# Solana RPC URL (Helius recommended). Server only: it is never sent to browsers
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Required token amount for builder permissions: a number above 0
PUBLIC_REQUIRED_TOKEN_AMOUNT=100000

# Token decimals
PUBLIC_TOKEN_DECIMALS=6
```

- **`PUBLIC_REQUIRED_TOKEN_AMOUNT`** is a number above 0. When the line is absent it is 10,000. When it is empty, `0`, negative or not a number (`100,000`), wallets are still verified and scripts can still read balances, but no wallet is granted builder access: the wallet panel and a chat line say so, and the server logs an error at start-up. (An empty value used to read as 0, which made every verified wallet a builder, also one that never held the token.)
- **`SOLANA_RPC_URL`** has no fallback. Without it (and without the deprecated `PUBLIC_RPC_URL`) no node is asked: every balance is unknown, nothing is granted, and the server logs an error at start-up. (It used to ask the public devnet node, which is another chain.)
- **The RPC is believed.** Whoever answers at that URL, or can change its answers on the way, decides which wallets are builders. Use `https` and a provider you trust.

### Features

- **Connect Wallet**: Connect Solana wallets like Phantom
- **Server-Side Balance Check**: The server reads the token balance; browsers never contact the RPC
- **Automatic Permission Grant**: Builder permissions are granted when the wallet is verified (a signature, no transaction) and its balance, read at that moment, is at least the required amount
- **Session-Only**: Permissions granted via token are valid only for the current session (reset on reload)

### What ends a grant, and what does not

- **Ends it**: the page reporting that the wallet was disconnected or its account changed; a new wallet sign-in on the same connection (the rank is gone when the server accepts the sign-in request, which it does not within 5 s of the one before, and comes back only if the new signature is verified and the balance read then is enough); a reload; the connection ending. A rank an admin gives or takes (or the admin code) ends it too, at that moment: the session then has the rank the admin decided, which a wallet disconnect does not take, and when that rank is below builder the token can grant again.
- **Does not end it**: the tokens leaving the wallet. A grant is decided from the balance read when it is made and is not looked at again when the balance changes (later balance requests may read the node again; they do not change a grant), so a wallet that sells or moves its tokens stays a builder until its session ends, and the same tokens moved to a second wallet can make that one a builder too. The disconnect report comes from the page: a visitor who changes the page does not send it.
- So the gate shows that a wallet held the amount at one moment, not that it holds it. What a builder made stays in the world when the grant ends.

### Notes

- Free public RPCs have rate limits; using an RPC provider like [Helius](https://helius.dev/) is recommended
- Token mint address should be a Solana SPL token address
- The page is handed a list of `PUBLIC_` variables, not every variable with that prefix: the names the client reads, plus `PUBLIC_API_URL`, `PUBLIC_MAX_UPLOAD_SIZE` and `PUBLIC_TOKEN_DECIMALS` (the list is in `src/core/extras/publicEnv.js`). No other `PUBLIC_` variable is sent. Those that are set are named together, by name and not by value, in one error line at start-up; the deprecated `PUBLIC_RPC_URL` is the exception: it is never sent and is not named there. Whatever is put under a listed name is public

## 🦊 EVM Wallets (Sign-In with Ethereum)

The wallet panel can also verify an EVM address (MetaMask, Rabby or any wallet that announces itself through EIP-6963). This proves ownership only: it moves no funds and grants no build access.

```bash
# Chain ids, comma separated (first one is used in the sign-in message). Empty disables EVM wallets.
PUBLIC_EVM_CHAIN_IDS=137
```

- The server writes the sign-in message (EIP-4361) and checks the signature against it; the browser cannot change what is signed
- The sign-in domain is the host of `PUBLIC_API_URL`, which must be the page's host (otherwise wallets warn about a mismatched site, and with no `PUBLIC_API_URL` EVM stays disabled)
- Smart-contract accounts (EIP-1271, and EIP-6492 for accounts not deployed yet, such as Myna Wallet) are checked on chain when the server has `EVM_RPC_URL_<chainId>` for the sign-in chain:
  - The check is one `eth_call`, with no contract deployed: of the account's own EIP-1271 function for a signature shorter than 32 bytes, otherwise of the ERC-6492 validator. It is bounded in gas, takes at most 8 s, and is limited to 4 at once and about 30 a minute for the whole server
  - Without that RPC, only ordinary (EOA) wallets can sign in, and a smart-contract wallet is told so
  - This assumes the wallet signs `personal_sign` as an EIP-1271 signature, which is what smart-account wallets normally do
- Verification lasts for the connection and is never stored or shown to other players
- When both Solana and EVM are enabled the panel shows a tab for each

### WalletConnect (phones and other devices)

```bash
PUBLIC_WALLETCONNECT_PROJECT_ID=0123456789abcdef0123456789abcdef   # from dashboard.reown.com
```

- Adds a **WalletConnect** button next to the browser wallets, so a phone browser without a wallet (Safari, Chrome, Brave) can sign in with a wallet app
  - On a desktop it shows a QR code to scan with the wallet app
  - On a phone it links to MetaMask, HashPort Wallet or Myna Wallet (both hold JPYC), and Android also offers any other wallet. MetaMask and Myna Wallet open through their universal links; HashPort Wallet opens through its app scheme, so Safari asks before opening it, and without the app installed Safari says it cannot open the page instead of going to the App Store. The app asks to connect, then to sign the same sign-in message. Other WalletConnect wallets can use the QR code or Copy link
- The WalletConnect code (about 410 KB) loads only when the button is pressed, and only then does the page talk to Reown's relay
- The project id is public by design (it is sent to browsers). In the Reown dashboard, allow only your page's domain
- Reown's own terms and plan limits apply; check them at reown.com before you rely on it. Telemetry to Reown is turned off
- Same rules as browser wallets. A smart-contract wallet such as Myna Wallet needs the server's `EVM_RPC_URL_<chainId>`
- Tips sent from a smart-contract wallet may stay unconfirmed: some of them return an ERC-4337 UserOperation hash instead of a transaction hash
- The sign-in network only: a wallet that connects without that network is disconnected again with a message

### Tips (JPYC / USDC)

```bash
PUBLIC_EVM_TIP_TOKENS=JPYC,USDC   # Polygon (137) built-ins; or SYMBOL:0xaddress:decimals[:min[:max]]
```

- A verified player can switch on **Receive tips** in the EVM tab. Others then see a tip button next to that player in the Players list; only a yes/no flag is shared, never the address
- Sending a tip asks the server for the recipient's verified address (rate limited, verified senders only), then the sender's own wallet sends an ERC-20 transfer straight to the recipient. The world never holds funds, takes no fee and does not convert anything
- Tips are in beta: the form says so and asks players to start small from a wallet holding only a little
- What the tip form tells the payer. It is information for the payer, not a control: anything running in the page can change both the form and the request the wallet gets. The form limits no amount either: the built-in tokens have a maximum per tip (1,000 JPYC, 10 USDC), a custom token has one only if its spec gives it, and none of this limits what code running in the page asks a wallet for
  - **Who is paid.** Once the server has answered, the sending step shows the recipient's name and short address (`0x1563…5508`); the same is in the "Sent" text. For an ERC-20 transfer a wallet shows the token contract as "to", and some mobile wallets do not decode the recipient at all, so the wallet's own prompt may not show that address. In these texts the name is shown without bidirectional control characters (U+202E and the like) and in an isolated element of its own (`<bdi>`), and the address in a left-to-right element of its own; elsewhere in the interface (the form's title and confirmation sentence, the Players list) the name is shown as before
  - **Same name.** Names are free text and not unique. When another connected player has the recipient's name after Unicode NFKC (full-width letters fold), reading any run of white space (tabs and line breaks included) as one space, removing characters that are not drawn, and lower-casing, the form says so. Look-alike letters of another script (Cyrillic) are not noticed
  - **Unknown outcome.** A wallet that was asked to send and answered with neither a transaction hash nor an explicit rejection (a session that dropped, a relay timeout): the form says the tip may have been sent and to check the wallet's activity before trying again, with the recipient and the amount, and offers only Close. A rejection is judged from the wallet's error: code 4001, which WalletConnect wallets' rejection codes and error texts are turned into
  - **After a reload.** Just before the wallet is asked to send, the browser notes the request in `localStorage` under a key of its own (`evmTipRequest:` and the note's id). A note holds the recipient's display name, the short address, the amount, the token symbol, the time of that moment and a random id: not the full address, not the payer's address, not a transaction hash. A page that finds notes (iOS often comes back from the wallet app as a reload; a lost connection) shows "A tip may have been sent" under the wallet button for each, newest first: the first four, and a line saying how many more there are, which come into view as those are dismissed. A note is removed when its request ends with a known outcome (the hash handed to the server, or the wallet's rejection), when it is dismissed, or when a page of this site next reads the notes ten minutes or more after its time. Nothing removes it while no such page is open, so a note can stay in the browser's storage until then, or until the browser clears the site's data. A read removes nothing else but notes that are not notes (malformed, too long, under a key that is not their own, or timed more than ten minutes ahead of the reader's clock); it reads the notes the storage lets it read, and again a moment after another tab changes this site's storage (a retry: a read that another tab's change cuts short can miss a note, and so can the retry). The count the notice gives is of the notes that were read, and says "at least" when a value could not be. Anything running on this origin in this browser profile can read the notes (other pages and worlds served from the same origin), and other sites cannot. A note is that browser's memory of a request, not a record of a payment
  - **Not confirming.** A world without `EVM_RPC_URL_137`, or whose RPC left the `finalized` tag unanswered, tells its clients (at sign-in and with each tip request). The form then says, before the wallet is asked, that this world is not confirming tips right now, and that the transfer still goes through the wallet and may not be confirmed or announced here (after a `no_finality` a later read of the tag can work, and a tip sent meanwhile can still be confirmed). When the answer to the tip request is the first to say so, the form stops on a step that says it, with nothing asked of the wallet, and goes on only after **Send anyway** (Cancel goes back to the amount). Send anyway acts on that request for 5 minutes of the page's time since it arrived (the server keeps it for 10): later, the wallet is asked nothing and the form says "This request expired before you answered. Nothing was sent. Start again.", back at the amount, where Next opens the confirmation and Send tip asks for a new request
- Amounts per tip: 1 to 1,000 JPYC, 0.01 to 10 USDC (the maximum is the beta limit). A custom token has a maximum only when its spec gives one (`:min:max`). The client checks before the confirmation step and the server refuses a larger intent (`above_maximum`); a transfer that does not match an accepted tip intent (same recipient and exact amount) is never counted as a tip, so nothing above the maximum is confirmed or announced
- With a server-side `EVM_RPC_URL_137`, the sender's client reports the transaction and the server confirms it on chain:
  - It looks for the token's `Transfer` log from the sender's verified address to the recipient's, with the exact amount.
  - It waits for the `finalized` block and checks that the transaction's block is not more than about 30 s older than the tip request (whole seconds are compared, so up to 31 s), and not older than the server process.
  - It then announces "Alice tipped Bob 100 JPYC" in chat and fires the `tip` event for server scripts.
  - Announcements are paced: at most 3 at once then one every 3 s, one per sender every 30 s. Otherwise only the recipient is told.
- How many reports the server watches, and in what order:
  - A connection has 2 transactions watched at a time; a third report is answered "busy" and can be made again. The table for the whole world holds 2 for every connection the server admits (`WS_MAX_SOCKETS`, 64 by default: 128 jobs, about 1.1 KB of memory each), so the connections of one address (8 by default) do not fill it. With `WS_MAX_SOCKETS=0` it holds 128 and can be full.
  - The chain calls are one budget for all reports of all senders: 4 calls started each second, with a second call for some, about 4 to 5 a second in the tests. A report waits its turn behind the ones that have waited longer, and a new report no longer goes ahead of them.
  - That is a larger table and an order, not a share for each sender. A junk hash takes calls from the same budget as a real one, so connections that report junk delay every confirmation: in a simulation with 63 of them an honest tip was confirmed after about a minute instead of 5 s (it used to end unconfirmed). More of them, a slow RPC or a late `finalized` block can still take a tip past the roughly 180 s after which the server stops watching it; the sender's page can then report it once more.
  - A tip that is not confirmed is not announced and scripts do not hear of it. That says nothing about the transfer itself: it may have gone through, be pending still, or never have been mined. Check the chain before making good a tip by hand.
- Without that RPC, tips are still sent but never confirmed or announced
- Not confirmed:
  - an RPC that does not answer the `finalized` tag
  - tokens that take a fee on transfer
  - a transfer the server has counted: the same transaction hash from the same sender is refused as a duplicate. Transfers of two different senders in one transaction (a bundler's) are both counted; a second transfer of the same sender in that transaction is not
- One transfer is one tip as far as one server process can tell:
  - What was counted is kept in that process's memory only: transaction hash and sender, 30 minutes each, cut to the newest 4096 before each new entry (so 4097 at most). Nothing is written to the database.
  - A restart empties it. So a transfer in a block stamped earlier than the start of the running process is refused as too old: a transfer counted before a restart is not matched by a new tip request after it, as long as the node's block times are not ahead of this machine's clock and that clock did not go back.
  - That is a rule on timestamps for one process at a time, not a record. Two processes serving the same world at once (a deploy that overlaps), a wrong clock, or an RPC node that answers wrongly are outside it, and a transfer can then be announced, and raise the `tip` event, twice.
  - A tip whose confirmation is under way when the server restarts or is deployed may never be counted by this world: the tip requests are in memory too, the new process knows nothing of them, and the page's second report of the hash is refused there (`unknown_ticket`). The form has no way to have such a tip counted afterwards. This was so before the rule above and is so with it. Whether the transfer itself went through is on the chain either way.
  - In the first 30 s after a start, a tip in a block stamped earlier than the start (this machine's clock ahead of the chain's) is refused as too old.
- Not legal advice: check the rules that apply to you before enabling tips in production. Using tips to unlock paid perks, prizes or rankings can make the world operator a seller

### NFT checks for apps

```bash
EVM_RPC_URL_137=https://polygon-mainnet.example/your-key   # server only, never PUBLIC_
# The contracts scripts may ask about: chainId:0xaddress, comma separated. This line is the default when the variable is not set
EVM_HOLDING_CONTRACTS=137:0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc
```

Server scripts can ask `player.getEvmHolding({ chainId, contract, standard, tokenId })` whether a player's verified wallet holds an ERC-721 / ERC-1155 token (including OpenPay license NFTs), and send the answer to that player only with `app.sendTo` (app settings and scripts are visible to every visitor, so anything secret must come from your own server). See `docs/scripting/world/Player.md` and the example apps `docs/scripting/examples/nft-gate.js` and `docs/scripting/examples/nft-door.js` (a door preset for an OpenPay license NFT; OpenPay's license contract on Polygon is `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc`).

- **Which contracts.** The server makes a read only for a contract in `EVM_HOLDING_CONTRACTS`. Addresses are compared without regard to case
  - Not set: the list is the OpenPay license contract on Polygon (the line above), so the shipped door works without it
  - Set: your list replaces the default; it does not add to it. A world that uses the OpenPay door and lists another contract has to list both
  - Set to nothing (`EVM_HOLDING_CONTRACTS=`): no contract, every check answers "unknown"
  - An entry that is not `chainId:0xaddress` stops the server at start-up with an `[envs]` error. The start-up log says which contracts are listed
  - For a contract that is not listed the script gets `known: false`, the chain is not asked, and the server log names the contract once (the first 16 of a server run)
- **Why there is a list.** The script is not given the player's address, but it is given what the contract answers about that address, and a contract's `balanceOf` is its own code. Before the list, a script author could deploy a contract whose `balanceOf(owner, id)` returned 40 bits of the owner's address and read the whole verified address of any visitor in four calls
- **What the list does not do.** Listing a contract trusts its `balanceOf` / `ownerOf` not to encode the owner
  - A listed contract that can be upgraded, or that its operator controls, can start doing that after you listed it
  - A listed ERC-721 answers `ownerOf` for every token id: a script that asks id by id learns which token a visitor holds, and with it the wallet, which is public on chain
  - A balance of a token with few holders can name one wallet
  - Every script in the world, by any builder, can ask about every listed contract

## 🛠️ Development

### Key Commands

```bash
# Development mode
npm run dev

# Production build
npm run build
npm start

# Archive the world's folder into <world>/backups (see "Backups" below)
npm run world:backup

# List the model, avatar and emote files the loaders' limits refuse (read-only; run before upgrading a world)
npm run models:check -- world/assets

# Viewer only (development)
npm run viewer:dev

# Client only (development)
npm run client:dev

# Linting
npm run lint
npm run lint:fix

# Unit tests, and the lint + format check CI runs
npm test
npm run check
```

There is no command that cleans a world: unused blueprints and assets are removed when the server starts, with `CLEAN=true` (`CLEAN=dryrun` only logs what would be removed; any other value, or none, does nothing). See Clean-up under [Uploads](#uploads).

### Backups

`npm run world:backup` writes one archive, `backup_<date>_<time>.tar.gz`, into `<world>/backups` and keeps the seven newest. The world is the folder `WORLD` names (`world` when it is not set), and it must exist. The server can be running, with the limit below.

- **What goes in.** The world's folder (assets, collections, `storage.json`, the clean-up's trash), without `backups/` itself. The SQLite database goes in as a copy made by SQLite's own backup, which is one consistent state of it; the live `db.sqlite` and the files SQLite keeps beside it are left out.
- **Not one moment.** The files are taken first and the database after them, so with the server running the two are not of the same moment: an asset uploaded in between can be named by the archived database and missing from the archived files. For a backup in which everything belongs together, stop the server first.
- **PostgreSQL is not included.** With `DB_URI` set to a PostgreSQL address the world's database is not in the folder and not in the archive (the script says so). Back it up by its own means.
- **It is not a backup until it is copied elsewhere.** The archive stays in the world's own folder, on the same disk as what it holds, and is lost with it.
- **Room it needs.** While it runs, a working folder in `<world>/backups` (`.staging-…`) holds the copy of the database, uncompressed; the other files are hard links, not second copies, except where hard links cannot be made: there they are copied and need their room too. The archive comes on top. A run that is killed leaves the working folder, to be removed by hand.
- Run one backup of a world at a time. It needs `tar`.

## 🖊️ Contributing

Contributions are welcome! Please check out our [contributing guidelines](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md) before getting started.

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a pull request

## 🌱 Project Status

Coo World is a fork of Hyperfy v0.16.0 (the version `package.json` still carries). Upstream's README at that version called the project alpha, with APIs likely to change.
What this fork changed since then is recorded in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`, and what is known to be unfinished is in its "Still open" section.
