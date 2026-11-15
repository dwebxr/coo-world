This repository is for technical experimentation and access control testing. Not investment advice. No purchase instructions.

# Coo World 🌐

<div align="center">
  <img src="overview.png" alt="Coo World" width="100%" />
  <p>
    <strong>A customized 3D virtual world built on Hyperfy</strong>
  </p>
  <p>
    <a href="https://play.dwebxr.xyz">Live world</a> ·
    <a href="docs/README.md">Docs</a> ·
    <a href="docs/operations/README.md">Running a world</a> ·
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

## What is Coo World?

Coo World is a 3D virtual world you host yourself. It is a fork of [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) v0.16.0, an open-source engine for interactive, multiplayer 3D worlds in the browser, and it keeps the engine's building tools, app scripting and physics.

On top of the engine, this fork adds wallet sign-in (Solana and EVM), building rights for holders of a token, tips between visitors, NFT checks for app scripts, and limits on uploads, connections and packets for a world that is open to the public. Each of these is documented with what it does and what it does not do.

## 🧬 Key Features

From the engine:

- **Standalone persistent worlds** - Host on your own domain
- **Realtime content creation** - Build directly in-world
- **Interactive app system** - Create dynamic applications with JavaScript
- **Portable avatars** - VRM avatars; visitors can upload their own when the world's Custom Avatars setting is on
- **Physics-based interactions** - Built on PhysX
- **WebXR support** - Experience worlds in VR

Added by this fork:

- **[Solana token gating](#-solana-token-gating)** - A visitor whose verified wallet holds the required amount of a token is a builder for the session
- **[EVM wallet sign-in](#-evm-wallets-sign-in-with-ethereum)** - Sign-In with Ethereum for browser wallets, and WalletConnect for phones
- **[Tips](#tips-jpyc--usdc)** - Visitors send JPYC or USDC to each other, wallet to wallet (beta)
- **[NFT checks for apps](#nft-checks-for-apps)** - A server script can ask whether a visitor's verified wallet holds a token
- **[Operator settings](#-running-a-public-world)** - Upload rules and quotas, connection and packet limits, world size budgets, clean-up, backups and page security headers

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

Then open `http://localhost:3000` (the `PORT` in `.env`).

With `ADMIN_CODE` left blank, as in `.env.example`, every player is an admin outside production. Set it before the world is open to others: see [`/admin <code>`](docs/commands.md).

### Docker Deployment

For containerized deployment, check [DOCKER.md](DOCKER.md) for detailed instructions.

## 🔧 Configuration

Everything is set through environment variables. `.env.example` lists all of them with comments; these are the ones to look at first.

| Variable | What it is |
| --- | --- |
| `JWT_SECRET` | Signs session tokens. Required: the server refuses to start without one. Anyone who knows it can sign in as any user |
| `ADMIN_CODE` | The code for `/admin <code>` in chat. See [commands](docs/commands.md) for what a blank value means |
| `PUBLIC_WS_URL`, `PUBLIC_API_URL`, `ASSETS_BASE_URL` | The addresses browsers use. They point at `localhost:3000` in `.env.example`; change them to your domain when hosting |
| `ASSETS`, `DB_URI` | Where files (`local` or `s3`) and world data (`local` SQLite or PostgreSQL) are kept |
| `LIVEKIT_*` | Voice chat through LiveKit |
| `AI_*` | The provider, model and key for the in-world AI actions builders can start |
| `PUBLIC_TOKEN_MINT`, `SOLANA_RPC_URL`, … | [Solana token gating](#-solana-token-gating) |
| `PUBLIC_EVM_CHAIN_IDS`, `PUBLIC_WALLETCONNECT_PROJECT_ID`, `PUBLIC_EVM_TIP_TOKENS`, `EVM_RPC_URL_<chainId>`, `EVM_HOLDING_CONTRACTS` | [EVM wallets, tips and NFT checks](#-evm-wallets-sign-in-with-ethereum) |
| `UPLOAD_*`, `WS_*`, `CLEAN`, `CSP_MODE`, `HSTS_MAX_AGE` | [Running a public world](#-running-a-public-world) |

A variable whose name starts with `PUBLIC_` and that the page is handed is public: never put a secret under one. Which names are handed to the page is in [Solana token gating](docs/operations/solana-token-gating.md#notes).

## 🔐 Solana Token Gating

A visitor whose verified Solana wallet holds the required amount of a token is made a builder for the session.

**Try it live:** 🌐 **[https://play.dwebxr.xyz](https://play.dwebxr.xyz)**. Connect a Solana wallet holding **100,000 COO** (mint `8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump`) to receive builder permissions.

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

- The wallet is verified with a signature, not a transaction, and the server reads the balance: browsers never contact the RPC
- A grant lasts for the session only, and is decided from the balance read when it is made. So the gate shows that a wallet held the amount at one moment, not that it still holds it
- The RPC is believed: whoever answers at `SOLANA_RPC_URL` decides which wallets are builders

Details, including what ends a grant and what an empty or wrong setting does: [docs/operations/solana-token-gating.md](docs/operations/solana-token-gating.md).

## 🦊 EVM Wallets (Sign-In with Ethereum)

The wallet panel can also verify an EVM address (MetaMask, Rabby or any wallet that announces itself through EIP-6963). This proves ownership only: it moves no funds and grants no build access.

```bash
# Chain ids, comma separated (first one is used in the sign-in message). Empty disables EVM wallets.
PUBLIC_EVM_CHAIN_IDS=137

# Optional: a WalletConnect button, so a phone browser without a wallet can sign in with a wallet app
PUBLIC_WALLETCONNECT_PROJECT_ID=0123456789abcdef0123456789abcdef   # from dashboard.reown.com
```

- The server writes the sign-in message (EIP-4361) and checks the signature against it
- Smart-contract accounts (EIP-1271 and EIP-6492, such as Myna Wallet) need the server's `EVM_RPC_URL_<chainId>` for the sign-in chain
- Verification lasts for the connection and is never stored or shown to other players
- With WalletConnect, a desktop shows a QR code and a phone links to the wallet app. Its code loads only when the button is pressed

Details: [docs/operations/evm-wallets.md](docs/operations/evm-wallets.md).

### Tips (JPYC / USDC)

```bash
PUBLIC_EVM_TIP_TOKENS=JPYC,USDC   # Polygon (137) built-ins; or SYMBOL:0xaddress:decimals[:min[:max]]
```

- A verified player can switch on **Receive tips**; others then see a tip button next to that player in the Players list
- The sender's own wallet sends an ERC-20 transfer straight to the recipient. The world never holds funds, takes no fee and does not convert anything
- Tips are in beta, with a maximum per tip for the built-in tokens (1,000 JPYC, 10 USDC)
- With a server-side `EVM_RPC_URL_137` the server confirms a reported tip on chain; a confirmed tip can be announced in chat and raises the `tip` event for server scripts. A tip that is not confirmed is not announced, which says nothing about the transfer itself
- Not legal advice: check the rules that apply to you before enabling tips in production

Details, including what the form tells the payer and when a tip stays unconfirmed: [docs/operations/tips.md](docs/operations/tips.md).

### NFT checks for apps

```bash
EVM_RPC_URL_137=https://polygon-mainnet.example/your-key   # server only, never PUBLIC_
# The contracts scripts may ask about: chainId:0xaddress, comma separated. This line is the default when the variable is not set
EVM_HOLDING_CONTRACTS=137:0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc
```

Server scripts can ask `player.getEvmHolding({ chainId, contract, standard, tokenId })` whether a player's verified wallet holds an ERC-721 / ERC-1155 token, for example to open a door for holders of an OpenPay license NFT (`docs/scripting/examples/nft-door.js`).

- The server asks only about contracts in `EVM_HOLDING_CONTRACTS`. A list you set replaces the default; it does not add to it
- Listing a contract trusts its `balanceOf` / `ownerOf` not to encode the owner's address in what it returns

Details: [docs/operations/nft-checks.md](docs/operations/nft-checks.md).

## 🧭 Running a public world

The operator reference is in [docs/operations](docs/operations/README.md). Each page says what a setting does, what it does not do, and what it assumes.

- **[Uploads and served assets](docs/operations/uploads.md)** - Who may upload, the accepted file types, rate limits and quotas, the free-space floor, and how uploaded files are served
- **[Page headers and `CSP_MODE`](docs/operations/page-security.md)** - The headers the pages carry, and the world page's Content-Security-Policy. The default, `report`, protects nothing: it only logs what `enforce` would refuse
- **[Connections and inbound packets](docs/operations/connections.md)** - Connection limits per address and in total, the places kept for admins, packet size and rate budgets, and the world's size budgets
- **[Ranks, users and builders](docs/operations/ranks.md)** - A builder can change everything in the world: give the rank only to people you would let rebuild or empty it
- **[Clean-up](docs/operations/clean-up.md)** - With `CLEAN=true`, unused blueprints and unreferenced assets are removed when the server starts. Read what it cannot see before relying on it
- **[Backups](docs/operations/backups.md)** - `npm run world:backup`, what goes into the archive, and why it is not a backup until it is copied elsewhere

## 🧩 Use Cases

- **Virtual Events & Conferences** - Host live gatherings with spatial audio
- **Interactive Showrooms** - Create product displays and demos
- **Social Spaces** - Build community hubs for collaboration
- **Gaming Environments** - Design immersive game worlds
- **Educational Experiences** - Develop interactive learning spaces
- **Creative Showcases** - Display 3D art and interactive installations

## 🛠️ Development

```bash
# Development mode
npm run dev

# Production build
npm run build
npm start

# Archive the world's folder into <world>/backups (see docs/operations/backups.md)
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

There is no command that cleans a world: unused blueprints and assets are removed when the server starts, with `CLEAN=true` (`CLEAN=dryrun` only logs what would be removed; any other value, or none, does nothing). See [Clean-up](docs/operations/clean-up.md).

The browser suites and how to run them are described in [test/e2e/README.md](test/e2e/README.md).

### Project Structure

```
docs/              - Documentation and references
  operations/      - Operator reference: uploads, limits, wallets, tips, clean-up, backups
  scripting/       - The app scripting API and example apps
src/
  client/          - Client-side code and components
  core/            - Core systems (physics, networking, entities)
  server/          - Server implementation
test/              - Unit tests (test/*.test.js) and browser suites (test/e2e)
CHANGELOG.md       - Version history and changes
```

## 📚 Documentation & Resources

- **[Docs](docs/README.md)** - This repository's documentation: commands, supported files and the app scripting API
- **[Running a world](docs/operations/README.md)** - The operator reference
- **[Changelog](CHANGELOG.md)** - What this fork changed, under `[Unreleased]`
- **[Docker](DOCKER.md)**, **[Migration notes](MIGRATIONS.md)**, **[Contributing](CONTRIBUTING.md)**

Upstream Hyperfy, the engine this world is forked from. These pages are upstream's and describe upstream, not this fork:

- **[Hyperfy documentation](https://docs.hyperfy.xyz)**
- **[Hyperfy website](https://hyperfy.io/)**
- **[Hyperfy sandbox](https://play.hyperfy.xyz/)** - Try upstream Hyperfy in your browser

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

## 📄 License

GPL-3.0, unchanged from Hyperfy. See [LICENSE](LICENSE).
