# Solana token gating

This world implements token gating via Solana wallet connection. A visitor whose verified wallet holds the required amount of a token is made a builder for the session.

## Try it Live (Coo World)

🌐 **[https://play.dwebxr.xyz](https://play.dwebxr.xyz)**

Connect a Solana wallet holding **100,000 COO** tokens to receive builder permissions.

- **Token Mint Address**: `8MXWPUCmxtmaxNSmAve3YvQNAKmAbZJ1XxSnrqN9pump`
- **Required Amount**: 100,000 COO

## Configuration

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

## Features

- **Connect Wallet**: Connect Solana wallets like Phantom
- **Server-Side Balance Check**: The server reads the token balance; browsers never contact the RPC
- **Automatic Permission Grant**: Builder permissions are granted when the wallet is verified (a signature, no transaction) and its balance, read at that moment, is at least the required amount
- **Session-Only**: Permissions granted via token are valid only for the current session (reset on reload)

## What ends a grant, and what does not

- **Ends it**: the page reporting that the wallet was disconnected or its account changed; a new wallet sign-in on the same connection (the rank is gone when the server accepts the sign-in request, which it does not within 5 s of the one before, and comes back only if the new signature is verified and the balance read then is enough); a reload; the connection ending. A rank an admin gives or takes (or the admin code) ends it too, at that moment: the session then has the rank the admin decided, which a wallet disconnect does not take, and when that rank is below builder the token can grant again.
- **Does not end it**: the tokens leaving the wallet. A grant is decided from the balance read when it is made and is not looked at again when the balance changes (later balance requests may read the node again; they do not change a grant), so a wallet that sells or moves its tokens stays a builder until its session ends, and the same tokens moved to a second wallet can make that one a builder too. The disconnect report comes from the page: a visitor who changes the page does not send it.
- So the gate shows that a wallet held the amount at one moment, not that it holds it. What a builder made stays in the world when the grant ends.

## Notes

- Free public RPCs have rate limits; using an RPC provider like [Helius](https://helius.dev/) is recommended
- Token mint address should be a Solana SPL token address
- The page is handed a list of `PUBLIC_` variables, not every variable with that prefix: the names the client reads, plus `PUBLIC_API_URL`, `PUBLIC_MAX_UPLOAD_SIZE` and `PUBLIC_TOKEN_DECIMALS` (the list is in `src/core/extras/publicEnv.js`). No other `PUBLIC_` variable is sent. Those that are set are named together, by name and not by value, in one error line at start-up; the deprecated `PUBLIC_RPC_URL` is the exception: it is never sent and is not named there. Whatever is put under a listed name is public
