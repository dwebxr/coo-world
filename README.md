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
- **Portable avatars** - Connect via Hyperfy for consistent identity
- **Physics-based interactions** - Built on PhysX for realistic simulation
- **WebXR support** - Experience worlds in VR
- **Extensible architecture** - Highly customizable for various use cases

Based on [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) v0.16.0

## 🚀 Quick Start

### Prerequisites

- Node.js 22.23.5+ (via [nvm](https://github.com/nvm-sh/nvm) or direct install)

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

Files enter a world through `/api/upload` and are served back from `/assets/`:

- Uploading needs a live session. The client sends its session token as `Authorization: Bearer`, and the server accepts it only from a user currently connected to the world with builder rank or higher. While **Custom Avatars** is enabled in the world settings, any connected user may upload a `.vrm` avatar.
- Only `glb`, `vrm`, `js`, `jpg`, `jpeg`, `png`, `webp`, `mp4`, `mp3` and `hdr` files are accepted; binary types must carry the matching file signature, and `PUBLIC_MAX_UPLOAD_SIZE` (MB) is enforced server-side. A request must declare its `Content-Length` (411 otherwise) and must not be compressed (`Content-Encoding` other than identity is 415).
- Rate limits and quotas (`UPLOAD_*` in `.env.example`, `0` disables one): one upload in flight per user and a global cap of in-flight uploads; uploads per minute and new bytes per 24 h per user, with a builder tier and a visitor tier chosen by the effective rank; per-address limits at 4x the visitor values, a share of the in-flight slots and a shared daily budget for everyone without a builder rank stored on their user (an identity minted by a fresh connection never counts as a builder here, even in a world whose settings grant builder to everyone). An admitted upload must deliver its body within `UPLOAD_SLOT_TIMEOUT_S`. A refusal that concerns the user or their network is a `429`, one that concerns the whole server a `503`; both carry `Retry-After` and `retryAfter` (seconds) in the JSON body, and the client retries once when that is five seconds or less. Counters live in memory and reset when the server restarts; `UPLOAD_MAX_TRACKED` bounds how many untrusted identities and addresses are kept, and while that table is full of records with live windows, untrusted identities not yet in it are answered `503` until one expires (stored-rank builders and admins are never held to it). A builder rank granted for the session by a verified wallet token is trusted like a stored rank, with its rate and quota keyed to the wallet rather than the user: identities minted under one wallet share one builder bucket. A rank that comes only from the world setting stays untrusted. Because tokens can move between wallets, `UPLOAD_RESERVED_TRUSTED` slots of the total are kept for stored-rank builders and admins: untrusted and wallet-backed sessions together never hold more than the rest. `/api/upload-check` answers `429`/`503` with `retryAfter` when the upload that would follow it would be refused, so a refusal reaches the client on a request without a body; the upload itself still decides. The client sends uploads one at a time per tab.
- Free space (`ASSETS=local`): an upload that would leave less than `UPLOAD_MIN_FREE_MB` (or a fifth of the volume, whichever is smaller, so a host that grows volumes at 75% used still can) is refused with `507`, keeping the volume writable for the world database that shares it. If free space cannot be read, uploads are refused with `507` as well, and a warning is logged once per kind of failure.
- Behind a proxy, the per-address limits key on `UPLOAD_CLIENT_IP_HEADER` when it is set, or on `Fly-Client-IP` when the server runs on Fly; otherwise on the socket address. IPv6 addresses are grouped by `/64`.
- Assets served by this server (`ASSETS=local`) carry `X-Content-Type-Options: nosniff` and an explicit content type. Scripts, HDRs and anything that is not plain image/video/audio/model media are delivered as sandboxed downloads, so a file served under these rules cannot run as a page on the world's origin. Scripts are served as plain text: the loaders read their text, and with `nosniff` a browser refuses one as a `<script>`, a worker or a module.
- Pages: the world page and the static pages (on every answer, a 304 included) say who may frame them (nobody: `frame-ancestors 'none'` and `X-Frame-Options: DENY`), forbid `<base>`, plugins and forms posting to other sites, and say a `Permissions-Policy` that, in browsers that implement it (Firefox does not), keeps the camera, the location, the Payment Request API (not wallet requests, which do not use it) and USB devices from the page and its frames. Every reply a route of the server makes says `nosniff`; a WebSocket upgrade and the errors the HTTP layer writes itself before any route runs (a 400 for a URL it cannot decode, a 408, a 431) do not. This is not a policy on scripts or connections (see the changelog). `HSTS_MAX_AGE` (seconds) turns on `Strict-Transport-Security`.
- Limits: the response headers are not applied to S3-served assets (`ASSETS=s3`), which need an equivalent object or CDN policy. The content type is stored with each S3 object when it is written: the built-in assets are written again at every start, but a script uploaded before scripts were typed `text/plain` keeps `text/javascript` until its metadata is changed in the bucket (uploading the same file again writes nothing). Files uploaded before these rules may still exist in the assets directory and in browser caches; before deploying, scan the existing assets for document-type files (`html`, `svg`, …) and review what references them.
- Clean-up (`CLEAN=true`, or `dryrun` to only log what would happen): at start-up, blueprints no app uses are deleted, and so are the uploaded assets nothing names.
  - **What it keeps.** Every store file whose name appears as a literal in the persisted world data (apps, the blueprints that stay, collections, settings, user avatars, script storage) or in the source of a store script reachable from that data. The code it follows is exactly: the store file a blueprint's script names, whatever its extension, and any `.js` store file named as a literal in that data or in code it follows, listed or not (a `.js` name the store listing leaves out, which holds content-hash names only, is asked of the store, at most 4,096 of them, and names nothing when there is no such file). Names are matched in any case, percent-decoded, and with tabs and line breaks inside a URL dropped (in one loop with the decoding, so in any order), whatever URL they are part of.
  - **What it cannot see**, so that file is removed: a name computed at run time (`'abc' + 'def.glb'`, a computed hash) or written with JavaScript escapes (`'\x61bc.glb'`); code built at run time, that is code a script fetches or assembles and evaluates itself (`fetch` and `Function`), wherever it is hosted, the store included, and whatever that code names (no engine API runs another script: `world.load` takes models and avatars, and an app's script is its blueprint's); references inside binary assets (a model's external image or buffer URI, which the loaders do not follow either: models, avatars and emotes use their embedded data). A world that relies on any of these must run with `CLEAN=false`.
  - **When it removes nothing at all** (the reason is logged): a database row or `storage.json` does not parse as JSON, or a row has the wrong shape; a database value (a row's data, the settings, an avatar) is larger than the largest upload or storage file allowed; `storage.json`, a set-aside copy of it or a script it must read cannot be read, including a store script that is missing (a CDN or cache may still serve it), one that cannot be opened, a file larger than the largest upload or storage file allowed (`PUBLIC_MAX_UPLOAD_SIZE`, `STORAGE_MAX_BYTES`) and, with `ASSETS=s3`, a script stored with a content encoding other than gzip or deflate or one that expands past that size (the log names the blueprint); a text holds a percent-encoded run longer than 4,096 characters, or one still encoded after 8 decodings; more than 4,096 `.js` names are not in the store listing; `ASSETS_BASE_URL` is not clean: it must start with a lower-case `http://` or `https://` and have no query, fragment, userinfo, backslash, dot segment, empty path segment or trailing slash, in its normalised form (a relative, protocol-relative or `?rev=` base stops it); a kept blueprint or collection blueprint has a script that is not `asset://<name>` or a URL starting with a lower-case `http://` or `https://` that is directly under `ASSETS_BASE_URL` with no userinfo, `?`, `#`, `%`, backslash or `.`/`..` segment (a script hosted elsewhere, a page path such as `/assets/x.js`, a spelling the loaders rewrite such as `https:/host/x` or `HTTPS://`, a legacy encoded or query spelling: its source could be anything). In these configurations cleaning never runs and the store only grows.
  - **Assumptions.** The server process is the only writer of the store, the trash and the database while it starts (uploads are not accepted until cleaning has finished; other processes changing those files at the same moment are not supported). Database tables are read whole, as the world itself reads them when it starts; the read limit applies to each value, not to a table's total. The assets URL serves each store file's own bytes: a redirect, a rewrite or a cache in front of it that answers a file's URL with something else is not supported (the clean-up reads the store, the world loads what the URL serves). With the local store a removal is recoverable for CLEAN_TRASH_DAYS; with S3 it is not (turn on bucket versioning).
  - **Recovering a file.** With `ASSETS=local` nothing is unlinked: the files go to `<world>/assets-trash/<UTC date>/` beside the assets directory (never served or listed, on the same disk the free-space check measures) and are removed for good after `CLEAN_TRASH_DAYS` (30 by default; `0` deletes at once and empties the trash). Retention counts the UTC dates of the folders, so a file can go up to a day sooner than that after it was moved. A trashed file that is named again comes back at the next start-up, from its newest copy that is still there; if none is, that is logged and the trash is not purged that run. It does not come back while `ASSETS_BASE_URL` is not clean (the clean-up then stops before it looks). To bring one back by hand, move it into the assets directory. With `ASSETS=s3` the objects are deleted: turn on bucket versioning to be able to recover one.

### Connections and inbound packets

- Per client address, `/ws` admits `WS_CONNECT_BURST` new connections at once (default 20) and `WS_CONNECT_RATE_PER_MIN` sustained (10/min), with at most `WS_CONNECT_CONCURRENT_PER_IP` open at a time (8). IPv6 also has `WS_CONNECT_CONCURRENT_PER_56` (16) and `WS_CONNECT_CONCURRENT_PER_48` (32) concurrent limits. Its parent rate buckets use `WS_CONNECT_RATE_PER_MIN_56=20`, `WS_CONNECT_BURST_56=40`, `WS_CONNECT_RATE_PER_MIN_48=40` and `WS_CONNECT_BURST_48=80`. Setting either rate or burst to `0` disables that parent bucket. Every bucket and concurrency cap must pass before any tokens are charged. `WS_MAX_SOCKETS` (64) caps all admitted transports, including closing sockets, until TCP closes. `0` disables a limit; `WS_CONNECT_BURST=0` also requires `WS_CONNECT_RATE_PER_MIN=0`. Raising `WS_MAX_SOCKETS` raises the total write-backlog bound of 64 MiB at the default; setting it to `0` removes that bound. `WS_CONNECT_MAX_TRACKED` (40000) bounds the shared table of address and IPv6 parent buckets; newcomers are refused while the table has no idle entries. Refused upgrades receive HTTP 503 with `Retry-After: 10`, before any database lookup or snapshot. Ordinary HTTP GETs take no slot. Addresses use `UPLOAD_CLIENT_IP_HEADER`, `Fly-Client-IP` on Fly, or the socket address; IPv6 uses `/64`, and both IPv4-mapped spellings count as IPv4.
- A client message above 64 KiB closes the connection (1009). Below that, every packet is checked before its values are built: `entityEvent` (a script's `app.send`) up to 64 KiB; `blueprintAdded`, `blueprintModified` and `ai` up to 64 KiB and only from builders; everything else up to 32 KiB. Each connection has a token bucket of 2048 units refilled at 1024 a second; a packet costs one unit plus one per full 2 KiB and one per 32 decoded nodes, including failed scans. A refused packet is counted and logged once per connection and reason; the connection stays open. A blueprint, including its props, must fit in 64 KiB; an oversized change is refused in the client with a toast. On a world whose settings grant builder rank to everyone, every connection counts as a builder.
- All world blueprints together have a 512 KiB budget (`WORLD_BLUEPRINT_BYTES`), measured as the sum of their encoded server `blueprintAdded` packets. An add that exceeds it is refused and its optimistic entity removed; a modification that exceeds it is reverted. Existing worlds over budget still load with a warning and permit changes that do not grow the total. Blueprints, app entities, settings and collections together have a 768 KiB budget (`WORLD_JOIN_BYTES`, `src/core/extras/joinBudget.js`, with the same growth-only rule), so the join snapshot always fits its 1 MiB cap: what no budget tracks (chat history, players' effects and avatars, app state set by server scripts, voice state of players who left) is dropped from a snapshot that would not fit, step by step, and logged; what cannot be dropped is counted as 1 KiB per player plus the snapshot's fixed part, which the server measures at start-up for its configuration (about 9 KiB; it logs when that is over 24 KiB, which a very long `LIVEKIT_API_KEY` can cause). World growth leaves room for the players present (at least 64). A visitor (no rank of builder or above stored on the user) is refused with `player_limit` once their join would leave less room than 8 more players and 64 KiB of world growth need, so a crowd of visitors cannot keep ranked users out or stop building: a full world takes about 174 visitors, an empty one about 940, whatever `WS_MAX_SOCKETS` allows. A user with a stored rank is admitted whenever the real snapshot fits, also in a world stored over its budget, so an admin can always come in to shrink or moderate it. Builders should keep large text out of props.
- The strict plain-msgpack decoder counts nodes at admission and builds values when the inbox is flushed. Fair per-socket scheduling spends at most 9,216 work units per tick (`work = nodes + floor(bytes / 128)`); under a full flood, a socket waits up to about 2 s for service at the default 64 slots. Each inbox has a guaranteed 160 KiB reserve and can grow to 1 MiB using a 16 MiB shared pool. Server-to-client output is capped at 512 KiB per packet and 1 MiB of backlog per client. The initial snapshot alone may use up to 1 MiB minus 1 KiB of write overhead (`SNAPSHOT_CAP`); crossing half that size logs a warning once per process. Scripts share 512 KiB of output per tick and skip recipients whose backlog would exceed 512 KiB. The protocol is now `v=2`; old tabs must reload. See [app.send](docs/scripting/app/App.md#sendname-data-skipnetworkid) for data types and return values.

## 🧩 Use Cases

- **Virtual Events & Conferences** - Host live gatherings with spatial audio
- **Interactive Showrooms** - Create product displays and demos
- **Social Spaces** - Build community hubs for collaboration
- **Gaming Environments** - Design immersive game worlds
- **Educational Experiences** - Develop interactive learning spaces
- **Creative Showcases** - Display 3D art and interactive installations

## 📚 Documentation & Resources

- **[Community Documentation](https://docs.hyperfy.xyz)** - Comprehensive guides and reference
- **[Website](https://hyperfy.io/)** - Official Hyperfy website
- **[Sandbox](https://play.hyperfy.xyz/)** - Try Hyperfy in your browser
- **[Twitter/X](https://x.com/hyperfy_io)** - Latest updates and announcements

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

This world implements token gating via Solana wallet connection. Users holding a specified amount of a particular token are automatically granted builder permissions.

### Try it Live (Coo World)

🌐 **[https://play.dwebxr.xyz](https://play.dwebxr.xyz)**

Connect a Solana wallet holding **100,000 COO** tokens to receive builder permissions.

- **Token Mint Address**: `8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump`
- **Required Amount**: 100,000 COO

### Configuration

Add the following environment variables to your `.env` file:

```bash
# Solana RPC URL (Helius recommended). Server only: it is never sent to browsers
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Token mint address (SPL token address)
PUBLIC_TOKEN_MINT=8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump

# Required token amount for builder permissions
PUBLIC_REQUIRED_TOKEN_AMOUNT=100000

# Token decimals
PUBLIC_TOKEN_DECIMALS=6
```

### Features

- **Connect Wallet**: Connect Solana wallets like Phantom
- **Server-Side Balance Check**: The server reads the token balance; browsers never contact the RPC
- **Automatic Permission Grant**: Builder permissions are automatically granted when holding the required token amount
- **Session-Only**: Permissions granted via token are valid only for the current session (reset on reload)
- **Wallet Disconnect**: Builder permissions are automatically revoked when wallet is disconnected

### Notes

- Free public RPCs have rate limits; using an RPC provider like [Helius](https://helius.dev/) is recommended
- Token mint address should be a Solana SPL token address
- Environment variables with `PUBLIC_` prefix are exposed to the client

## 🦊 EVM Wallets (Sign-In with Ethereum)

The wallet panel can also verify an EVM address (MetaMask, Rabby or any wallet that announces itself through EIP-6963). This proves ownership only: it moves no funds and grants no build access.

```bash
# Chain ids, comma separated (first one is used in the sign-in message). Empty disables EVM wallets.
PUBLIC_EVM_CHAIN_IDS=137
```

- The server writes the sign-in message (EIP-4361) and checks the signature against it; the browser cannot change what is signed
- The sign-in domain is the host of `PUBLIC_API_URL`, which must be the page's host (otherwise wallets warn about a mismatched site, and with no `PUBLIC_API_URL` EVM stays disabled)
- Smart-contract accounts (EIP-1271, and EIP-6492 for accounts not deployed yet, such as Myna Wallet) are checked on chain when the server has `EVM_RPC_URL_<chainId>` for the sign-in chain:
  - The check is one `eth_call` of the ERC-6492 validator, with no contract deployed. It is bounded in gas, takes at most 8 s, and is limited to 4 at once and about 30 a minute for the whole server
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
- Amounts per tip: 1 to 1,000 JPYC, 0.01 to 10 USDC (the maximum is the beta limit). A custom token has a maximum only when its spec gives one (`:min:max`). The client checks before the confirmation step and the server refuses a larger intent (`above_maximum`); a transfer that does not match an accepted tip intent (same recipient and exact amount) is never counted as a tip, so nothing above the maximum is confirmed or announced
- With a server-side `EVM_RPC_URL_137`, the sender's client reports the transaction and the server confirms it on chain:
  - It looks for the token's `Transfer` log from the sender's verified address to the recipient's, with the exact amount.
  - It waits for the `finalized` block and checks that the transaction is not older than the tip request.
  - It then announces "Alice tipped Bob 100 JPYC" in chat and fires the `tip` event for server scripts.
  - Announcements are paced: at most 3 at once then one every 3 s, one per sender every 30 s. Otherwise only the recipient is told.
- Without that RPC, tips are still sent but never confirmed or announced
- Not confirmed:
  - an RPC that does not answer the `finalized` tag
  - tokens that take a fee on transfer
  - a second announcement of the same transaction
- After a server restart, a transaction confirmed in the last ~30 s before the restart could be announced again
- Not legal advice: check the rules that apply to you before enabling tips in production. Using tips to unlock paid perks, prizes or rankings can make the world operator a seller

### NFT checks for apps

```bash
EVM_RPC_URL_137=https://polygon-mainnet.example/your-key   # server only, never PUBLIC_
```

Server scripts can ask `player.getEvmHolding({ chainId, contract, standard, tokenId })` whether a player's verified wallet holds an ERC-721 / ERC-1155 token (including OpenPay license NFTs), and send the answer to that player only with `app.sendTo` (app settings and scripts are visible to every visitor, so anything secret must come from your own server). See `docs/scripting/world/Player.md` and the example apps `docs/scripting/examples/nft-gate.js` and `docs/scripting/examples/nft-door.js` (a door preset for an OpenPay license NFT; OpenPay's license contract on Polygon is `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc`).

## 🛠️ Development

### Key Commands

```bash
# Development mode
npm run dev

# Production build
npm run build
npm start

# Clean orphaned assets (experimental)
npm run world:clean

# List the model, avatar and emote files the loaders' limits refuse (read-only; run before upgrading a world)
npm run models:check -- world/assets

# Viewer only (development)
npm run viewer:dev

# Client only (development)
npm run client:dev

# Linting
npm run lint
npm run lint:fix
```

## 🖊️ Contributing

Contributions are welcome! Please check out our [contributing guidelines](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md) before getting started.

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a pull request

## 🌱 Project Status

This project is still in alpha as we transition all of our [reference platform](https://github.com/hyperfy-xyz/hyperfy-ref) code into fully self hostable worlds.
Most features are already here in this repo but still need to be connected up to work with self hosting in mind.
Note that APIs are highly likely to change during this time.
