# EVM wallets (Sign-In with Ethereum)

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

## WalletConnect (phones and other devices)

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
