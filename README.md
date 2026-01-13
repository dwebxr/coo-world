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

- Node.js 22.11.0+ (via [nvm](https://github.com/nvm-sh/nvm) or direct install)

### Installation

```bash
# Clone the repository
git clone https://github.com/dwebxr/coo-world.git my-world
cd my-world

# Copy example environment settings
cp .env.example .env

# Install dependencies
npm install

# Start the development server
npm run dev
```

### Docker Deployment

For containerized deployment, check [DOCKER.md](DOCKER.md) for detailed instructions.

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

### Configuration

Add the following environment variables to your `.env` file:

```bash
# Solana RPC URL (Helius recommended)
PUBLIC_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Token mint address (SPL token address)
PUBLIC_TOKEN_MINT=8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump

# Required token amount for builder permissions
PUBLIC_REQUIRED_TOKEN_AMOUNT=100000

# Token decimals
PUBLIC_TOKEN_DECIMALS=6
```

### Features

- **Connect Wallet**: Connect Solana wallets like Phantom
- **Token Balance Display**: Shows the balance of the configured token
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
