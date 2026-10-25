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
- Free space (`ASSETS=local`): an upload that would leave less than `UPLOAD_MIN_FREE_MB` (or a fifth of the volume, whichever is smaller, so a host that grows volumes at 75% used still can) is refused with `507`, keeping the volume writable for the world database that shares it. If free space cannot be read the check is skipped and a warning is logged once.
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
