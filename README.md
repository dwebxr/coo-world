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

- Node.js 22.23.4+ (via [nvm](https://github.com/nvm-sh/nvm) or direct install)

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
- Assets served by this server (`ASSETS=local`) carry `X-Content-Type-Options: nosniff` and an explicit content type. Scripts, HDRs and anything that is not plain image/video/audio/model media are delivered as sandboxed downloads, so a file served under these rules cannot run as a page on the world's origin.
- Limits: the response headers are not applied to S3-served assets (`ASSETS=s3`), which need an equivalent object or CDN policy. Files uploaded before these rules may still exist in the assets directory and in browser caches; before deploying, scan the existing assets for document-type files (`html`, `svg`, …) and review what references them.

### Connections and inbound packets

- Per client address, `/ws` admits `WS_CONNECT_BURST` new connections at once (default 20) and `WS_CONNECT_RATE_PER_MIN` sustained (10/min), with at most `WS_CONNECT_CONCURRENT_PER_IP` open at a time (8). IPv6 also has `WS_CONNECT_CONCURRENT_PER_56` (16) and `WS_CONNECT_CONCURRENT_PER_48` (32) concurrent limits. Its parent rate buckets use `WS_CONNECT_RATE_PER_MIN_56=20`, `WS_CONNECT_BURST_56=40`, `WS_CONNECT_RATE_PER_MIN_48=40` and `WS_CONNECT_BURST_48=80`. Setting either rate or burst to `0` disables that parent bucket. Every bucket and concurrency cap must pass before any tokens are charged. `WS_MAX_SOCKETS` (64) caps all admitted transports, including closing sockets, until TCP closes. `0` disables a limit; `WS_CONNECT_BURST=0` also requires `WS_CONNECT_RATE_PER_MIN=0`. Raising `WS_MAX_SOCKETS` raises the total write-backlog bound of 64 MiB at the default; setting it to `0` removes that bound. `WS_CONNECT_MAX_TRACKED` (40000) bounds the shared table of address and IPv6 parent buckets; newcomers are refused while the table has no idle entries. Refused upgrades receive HTTP 503 with `Retry-After: 10`, before any database lookup or snapshot. Ordinary HTTP GETs take no slot. Addresses use `UPLOAD_CLIENT_IP_HEADER`, `Fly-Client-IP` on Fly, or the socket address; IPv6 uses `/64`, and both IPv4-mapped spellings count as IPv4.
- A client message above 64 KiB closes the connection (1009). Below that, every packet is checked before its values are built: `entityEvent` (a script's `app.send`) up to 64 KiB; `blueprintAdded`, `blueprintModified` and `ai` up to 64 KiB and only from builders; everything else up to 32 KiB. Each connection has a token bucket of 2048 units refilled at 1024 a second; a packet costs one unit plus one per full 2 KiB and one per 32 decoded nodes, including failed scans. A refused packet is counted and logged once per connection and reason; the connection stays open. A blueprint, including its props, must fit in 64 KiB; an oversized change is refused in the client with a toast. On a world whose settings grant builder rank to everyone, every connection counts as a builder.
- All world blueprints together have a 512 KiB budget (`WORLD_BLUEPRINT_BYTES`), measured as the sum of their encoded server `blueprintAdded` packets. An add that exceeds it is refused and its optimistic entity removed; a modification that exceeds it is reverted. Existing worlds over budget still load with a warning and permit changes that do not grow the total. Builders should keep large text out of props: the whole world snapshot, including entities and other join data, must fit in about 1 MiB for joins.
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
