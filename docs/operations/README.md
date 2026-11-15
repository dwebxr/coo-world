# Running a world

The operator reference for a Coo World server: what each setting does, what it does not do, and what it assumes. The variables themselves, with their defaults, are in `.env.example`.

To get a world running, start with the Quick Start in the [README](../../README.md), and [DOCKER.md](../../DOCKER.md) for the image.

## The server

- [Uploads and served assets](uploads.md) - who may upload, the accepted file types, rate limits and quotas, the free-space floor, and how uploaded files are served
- [Page headers and the Content-Security-Policy](page-security.md) - the headers the pages carry and `CSP_MODE`
- [Connections and inbound packets](connections.md) - connection limits, the places kept for ranked users, packet budgets and the world's size budgets
- [Ranks, users and builders](ranks.md) - the `locked` world rule, the `users` table, and what a builder can do
- [Clean-up](clean-up.md) - `CLEAN`: what is removed at start-up, what is kept, what it cannot see, and how to recover a file
- [Backups](backups.md) - `npm run world:backup`

## Wallets and tokens

- [Solana token gating](solana-token-gating.md) - builder rank for a session, for a verified wallet that holds a token
- [EVM wallets](evm-wallets.md) - Sign-In with Ethereum, smart-contract accounts and WalletConnect
- [Tips](tips.md) - JPYC / USDC tips between players, and when the server confirms one
- [NFT checks for apps](nft-checks.md) - `player.getEvmHolding` and `EVM_HOLDING_CONTRACTS`

## See also

- [Commands](../commands.md) - `/admin <code>` and the other chat commands
- [Migration notes](../../MIGRATIONS.md) and the [changelog](../../CHANGELOG.md)
