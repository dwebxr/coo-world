# goals

Design and planning documents of this fork. They are written in Japanese.

## Design documents (current location, referenced from the source and the docs)

Each one records a design as it was decided when it was written; its status line and dates are its own. What the code does now is in `README.md`, `docs/` and `CHANGELOG.md`. The files stay at these paths because source comments and documents name them.

| File | What it designs | Named in |
|---|---|---|
| [phase2-evm-wallet-design.md](phase2-evm-wallet-design.md) | EVM wallet connection (P1) and the checks made before it (P0) | `goals/phase3-evm-tips-gates-design.md` |
| [phase3-evm-tips-gates-design.md](phase3-evm-tips-gates-design.md) | Tips (P2), NFT gates (P3) and a Solana fix | `src/core/extras/evmTokens.js`, `goals/phase4-evm-tip-confirm-design.md` |
| [phase4-evm-tip-confirm-design.md](phase4-evm-tip-confirm-design.md) | Confirmation and announcement of tips (P2b) | (no other file) |
| [phase5-walletconnect-design.md](phase5-walletconnect-design.md) | WalletConnect | `src/client/walletconnect.js` |
| [phase6-smart-wallet-siwe-design.md](phase6-smart-wallet-siwe-design.md) | Sign-in of smart-contract wallets (EIP-1271 / EIP-6492) and the buttons for JPYC wallets | `src/server/evm-gating.js` |
| [phase7-openpay-nft-door-design.md](phase7-openpay-nft-door-design.md) | A door opened by an OpenPay license NFT (`nft_gate.hyp`) | `docs/scripting/world/Player.md`, `CHANGELOG.md` |
| [phase8-tip-beta-limits-design.md](phase8-tip-beta-limits-design.md) | Tips shown as a beta, a maximum per tip (1,000 JPYC) and a revision of the terms | `src/core/extras/evmTokens.js`, `CHANGELOG.md` |

## Archive (`archive/`)

Historical. A refactoring plan and its task files, last changed on 2026-07-07:

- `archive/REFACTOR_PLAN.md`: the plan (it was at the top of the repository).
- `archive/_CONTEXT.md`: the constraints every task file shared.
- `archive/phase0-*.md` to `archive/phase5-*.md`: one task per file (0A to 5B, 19 files).

Each archived file says so in its first line. What they state as facts (the lint error counts, "no tests", "no CI gate") describes the repository at that date. Today `npm test`, `npm run check` and the workflows in `.github/workflows/` exist: see `CONTRIBUTING.md`.
