# Hyperfy ⚡️

<div align="center">
  <img src="overview.png" alt="Hyperfy Ecosystem" width="100%" />
  <p>
    <strong>Build, deploy, and experience interactive 3D virtual worlds</strong>
  </p>
</div>

## What is Hyperfy?

Hyperfy is an open-source framework for building interactive 3D virtual worlds. It combines a powerful physics engine, networked real-time collaboration, and a component-based application system to create immersive experiences that can be self-hosted or connected to the wider Hyperfy ecosystem.

## 🧬 Key Features

- **Standalone persistent worlds** - Host on your own domain
- **Realtime content creation** - Build directly in-world
- **Interactive app system** - Create dynamic applications with JavaScript
- **Portable avatars** - Connect via Hyperfy for consistent identity
- **Physics-based interactions** - Built on PhysX for realistic simulation
- **WebXR support** - Experience worlds in VR
- **Extensible architecture** - Highly customizable for various use cases

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hyperfy-xyz/hyperfy)

## 🚀 Quick Start

### Prerequisites

- Node.js 22.11.0+ (via [nvm](https://github.com/nvm-sh/nvm) or direct install)

### Installation

```bash
# Clone the repository
git clone https://github.com/hyperfy-xyz/hyperfy.git my-world
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

このワールドはSolanaウォレット接続によるトークンゲーティング機能を実装しています。特定のトークンを一定量保有しているユーザーにビルダー権限を自動付与します。

### 設定方法

`.env`ファイルに以下の環境変数を設定してください：

```bash
# Solana RPC URL (Helius推奨)
PUBLIC_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# トークンミントアドレス (SPLトークンのアドレス)
PUBLIC_TOKEN_MINT=8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump

# ビルダー権限に必要なトークン量
PUBLIC_REQUIRED_TOKEN_AMOUNT=100000

# トークンのデシマル（小数点以下の桁数）
PUBLIC_TOKEN_DECIMALS=6
```

### 機能

- **Connect Wallet**: Phantom等のSolanaウォレットを接続
- **トークン残高表示**: 設定されたトークンの保有量を表示
- **自動権限付与**: 必要量以上のトークン保有でビルダー権限を自動付与
- **セッション限定**: トークンで付与された権限はセッション中のみ有効（リロードでリセット）
- **ウォレット切断時**: ビルダー権限が自動的に解除

### 注意事項

- 無料のPublic RPCは制限があるため、[Helius](https://helius.dev/)などのRPCプロバイダーを推奨
- トークンミントアドレスはSolanaのSPLトークンアドレスを指定
- `PUBLIC_`プレフィックスの環境変数はクライアントに公開されます

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
