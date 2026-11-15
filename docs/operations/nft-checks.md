# NFT checks for apps

The wallet a check is about is the one a player verified with the EVM sign-in: see [EVM wallets](evm-wallets.md).

```bash
EVM_RPC_URL_137=https://polygon-mainnet.example/your-key   # server only, never PUBLIC_
# The contracts scripts may ask about: chainId:0xaddress, comma separated. This line is the default when the variable is not set
EVM_HOLDING_CONTRACTS=137:0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc
```

Server scripts can ask `player.getEvmHolding({ chainId, contract, standard, tokenId })` whether a player's verified wallet holds an ERC-721 / ERC-1155 token (including OpenPay license NFTs), and send the answer to that player only with `app.sendTo` (app settings and scripts are visible to every visitor, so anything secret must come from your own server). See `docs/scripting/world/Player.md` and the example apps `docs/scripting/examples/nft-gate.js` and `docs/scripting/examples/nft-door.js` (a door preset for an OpenPay license NFT; OpenPay's license contract on Polygon is `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc`).

- **Which contracts.** The server makes a read only for a contract in `EVM_HOLDING_CONTRACTS`. Addresses are compared without regard to case
  - Not set: the list is the OpenPay license contract on Polygon (the line above), so the shipped door works without it
  - Set: your list replaces the default; it does not add to it. A world that uses the OpenPay door and lists another contract has to list both
  - Set to nothing (`EVM_HOLDING_CONTRACTS=`): no contract, every check answers "unknown"
  - An entry that is not `chainId:0xaddress` stops the server at start-up with an `[envs]` error. The start-up log says which contracts are listed
  - For a contract that is not listed the script gets `known: false`, the chain is not asked, and the server log names the contract once (the first 16 of a server run)
- **Why there is a list.** The script is not given the player's address, but it is given what the contract answers about that address, and a contract's `balanceOf` is its own code. Before the list, a script author could deploy a contract whose `balanceOf(owner, id)` returned 40 bits of the owner's address and read the whole verified address of any visitor in four calls
- **What the list does not do.** Listing a contract trusts its `balanceOf` / `ownerOf` not to encode the owner
  - A listed contract that can be upgraded, or that its operator controls, can start doing that after you listed it
  - A listed ERC-721 answers `ownerOf` for every token id: a script that asks id by id learns which token a visitor holds, and with it the wallet, which is public on chain
  - A balance of a token with few holders can name one wallet
  - Every script in the world, by any builder, can ask about every listed contract
