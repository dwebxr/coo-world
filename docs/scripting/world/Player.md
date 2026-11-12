# Player

Represents a player. An instance of Player can be retrived via [World.getPlayer](/docs/scripting/world/World.md)

## Properties

### `.id`: String

The players unique ID. This is always the same for the same player, even when they leave and come back.

### `.name`: String

The players name.

### `.local`: Boolean

Whether the player is local to this client.

### `.admin`: Boolean

Whether the player is an admin in this world.

### `.position`: Vector3

The players position in the world.

Shared positions are supported within `[-1e6, 1e6]` metres on each axis (`TRANSFORM_LIMIT`). Local
movement can go beyond this extent, but other players then see the last accepted in-range position.
See [world extent](/docs/scripting/world/World.md#shared-world-extent).

### `.quaternion`: Quaternion

The players rotation in the world.

### `.rotation`: Euler

The players rotation in the world.

## Methods

`teleport` and `push` accept endowed and stock THREE `Vector3` instances; lookalike objects
throw. Non-finite or float32-overflow vector components are ignored, with one warning per method.
The relay bounds below still apply; direct local pushes have no additional `1e4` cap.

### `.getTokenBalance()`: Promise<{ verified, known, balance }>

Returns an intrinsic Promise of a fresh, frozen `{ verified, known, balance }` object for the
local player on a client. The balance is the configured world's COO token in the wallet's
associated SPL Token account; other accounts and Token-2022 are not counted.

- `verified`: the server has verified ownership of the wallet for this connection.
- `known`: a balance read succeeded. A missing token account is known with balance `0`.
- `balance`: a finite, nonnegative token amount, or `0` when unknown. Check both booleans before using it.

A remote player, any server script, or disabled token gating returns
`{ verified: false, known: false, balance: 0 }` without a request. Remote/server use warns once per
app. Operational failures resolve unknown; the Promise never rejects. A call on a stopped app
or in a fatal world throws synchronously, like other guarded APIs. If the app crashes, rebuilds,
is destroyed, or the world becomes fatal while waiting, the old call never settles.

Balances may be up to the server cache TTL (default 30 seconds, configurable up to 300 seconds)
plus 5 seconds on the client old. Budget pressure or outages can make a read unknown; the global
budget bounds cost, not availability. Ownership must be verified again after reconnect or restart.
After verification, any client script in this world can read this balance and send it to a server
script. Neither the wallet address nor verification is stored in player data.

A door opened using this result affects the player's **own screen only**. It is not server-enforced
passage control: a modified client can open it for itself. Use the engine's
[`wallet` event](/docs/scripting/world/World.md#engine-events) to refresh displays after verification changes.

```js
if (world.isClient) {
  try {
    const result = await world.getPlayer().getTokenBalance()
    if (result.verified && result.known && result.balance >= 10000) {
      // Open this client's door.
    }
  } catch (err) {
    // The app has stopped; no request was started.
  }
}
```

### `.getEvmHolding(spec)`: Promise<{ verified, known, balance, holds }>

**Server scripts only.** Returns an intrinsic Promise of a fresh, frozen `{ verified, known, balance, holds }`
object telling whether this player's EVM wallet, verified by the server for this connection (Sign-In with
Ethereum in the wallet panel), holds an NFT. The server looks the address up itself and does not hand it to the
script. The script gets what the contract answers about that address, and only for contracts the world's
operator listed (see [what a script can learn](#what-a-script-can-learn-from-a-holdings-check) below).

`spec` is `{ chainId, contract, standard, tokenId?, minBalance? }`:

- `chainId`: a chain listed in `PUBLIC_EVM_CHAIN_IDS` that has a server-side `EVM_RPC_URL_<chainId>`.
- `contract`: the token contract (`0x` + 40 hex digits). It must be in the operator's `EVM_HOLDING_CONTRACTS`
  (comma-separated `chainId:0xaddress`, compared without regard to case). When that variable is not set, the list
  is OpenPay's license contract on Polygon, `137:0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc`; setting it replaces
  that default, and setting it to nothing allows no contract.
- `standard`: `'erc721'` or `'erc1155'`.
- `tokenId`: a decimal string, a `0x` hex string or a safe integer. Required for ERC-1155. For ERC-721 it
  checks `ownerOf(tokenId)`; without it, any token of the collection counts (`balanceOf`). Pass 256-bit ids
  (for example an OpenPay license id, `keccak256('openpay:license:' + productId)`) as hex strings. OpenPay's
  license NFTs are ERC-1155 tokens of `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` on Polygon (`137`).
- `minBalance`: a positive safe integer, default `1`.

Results:

- `verified`: the player has a verified EVM wallet on this connection.
- `known`: the read succeeded. **`known: false` means "unknown right now", not "does not hold"**: an RPC
  outage, the shared request budget, an unsupported chain or an invalid `spec` (warned once per app) all
  give `known: false`. Ask again later instead of treating it as a refusal.
  A contract that is not in `EVM_HOLDING_CONTRACTS` also gives `known: false`, every time: the server makes no
  request for it, and writes one line to its log naming the contract (the first 16 such contracts of a server
  run). Asking again does not help; the operator has to list the contract and restart the server.
- `balance`: the count read at the latest block (capped at `Number.MAX_SAFE_INTEGER`), or `0`.
- `holds`: `known && balance >= minBalance`.

Reads are cached for 30 seconds per player and token (failures for 5 seconds) and share a global budget, so
a burst of checks resolves `known: false` instead of waiting. A client script gets
`{ verified: false, known: false, balance: 0, holds: false }` and a warning. The Promise never rejects; like
`getTokenBalance`, it never settles if the app stops or the world becomes fatal while waiting. NFTs can be
transferred, so check again when it matters (the engine's [`evmWallet` event](/docs/scripting/world/World.md#engine-events)
tells server scripts when a player's verification changes).

#### What a script can learn from a holdings check

The script is not given the player's address. It is given a number that the contract computes from that
address, so what it learns is whatever the listed contracts say:

- **A listed ERC-721 with `tokenId`.** The answer is whether the player's wallet is `ownerOf(tokenId)`. A script
  that asks token id after token id finds which token the player holds, and the owner of a token is public on
  chain: that is the player's address. Each question is one request against the shared budget, which makes this
  slow for a large collection and does not stop it.
- **A listed ERC-721 without `tokenId`, a listed ERC-1155, or a listed ERC-20 asked as `'erc721'` without
  `tokenId`** (`balanceOf(address)` is the same call). The answer is the balance (for an ERC-20, in its
  smallest unit), up to `Number.MAX_SAFE_INTEGER`. An exact balance of a token with few holders can also name
  one wallet on chain.
- **A listed contract that is not what it seems.** `balanceOf` is the contract's own code. A contract written
  for it can return part of the owner's address as the "balance" (40 bits a call: four calls give the whole
  address). The server cannot tell. This is why the operator names the contracts: listing one means trusting
  its `balanceOf` / `ownerOf` not to encode the owner, now and later. A contract that can be upgraded, or that
  whoever asked for the listing controls, can start doing so after it was listed. The default list has one
  contract, OpenPay's license contract. It has not been verified here: the project's notes of 2026-11-10
  (goals/phase7-openpay-nft-door-design.md) record only that its EIP-1967 proxy slots were empty when read then
  and that its published source has the standard ERC-1155 `balanceOf`; whether the deployed code is that source,
  and whether it can change, was not established, and nothing checks either. With it listed, a script can read a
  player's balance of any license id of that contract.
- **A contract that is not listed.** Nothing: `known: false`, and no request is made.

For world operators: `EVM_HOLDING_CONTRACTS` is the list of contracts you let every script in your world, by
any builder, ask about your visitors' verified wallets. Add a contract only if you would accept that.

Decide on the server and send the result only to that player with `app.sendTo`. Anything opened on the
client (a door, a barrier) is still only that player's screen. App settings (`props`) and the script are
sent to every visitor, so they cannot hold anything secret: content for holders only must come from a
source visitors cannot read and be sent by the server script after the check. A complete app is in
[`docs/scripting/examples/nft-gate.js`](/docs/scripting/examples/nft-gate.js), and a door that opens for the
holder of an OpenPay license NFT is in [`docs/scripting/examples/nft-door.js`](/docs/scripting/examples/nft-door.js).

```js
if (world.isServer) {
  app.on('check', async (data, playerId) => {
    const player = world.getPlayer(playerId)
    const result = await player.getEvmHolding({
      chainId: 137,
      contract: props.contract,
      standard: 'erc1155',
      tokenId: props.tokenId,
    })
    app.sendTo(playerId, 'result', { holds: result.holds, known: result.known, verified: result.verified })
  })
}
```

### `.teleport(position, rotationY)`

Teleports the player instantly to the new position. The `rotationY` value is in radians, and if omitted (or not a number) the player will continue facing their current direction.

On a client, only the local player can be teleported; server scripts can teleport any player.

Every position component must be finite and within `[-1e6, 1e6]` metres. A server-sent teleport or
local script teleport outside that bound is ignored. `rotationY` must be a finite number to change
the facing direction; otherwise only the position is applied.

Other players are told what a player's own client changes (its position, a teleport, its emote and its effect) at
most once per server tick, 30 times a second. A client script that teleports its player or sets an effect more often
than that, on every frame say, is seen by the others at what each tick ended on: the last position, and an effect
that was set and ended within one tick not at all.

### `.push(force)`

Applies a short, impulse-like push to the player in world-space. Multiple pushes accumulate vectorially and decay over time with high drag.

- **force**: A direction/impulse vector. Accepts a `Vector3`.

Behavior:
- Adds the impulse to the player’s current push; subsequent calls add to the existing push rather than replacing it.
- On a client, only the local player can be pushed; server scripts can push any player.
- Server-to-client push relays require every force component to be finite and within `[-1e4, 1e4]`;
  the entire push is ignored otherwise. Direct local script pushes bypass this relay bound.

Example:
```js
// Dash forward relative to camera yaw
const FORWARD = new Vector3(0, 0, -1)
const euler = new Euler(0, 0, 0, 'YXZ')
const quat = new Quaternion()

euler.setFromQuaternion(world.getPlayer().quaternion)
euler.x = 0; euler.z = 0
quat.setFromEuler(euler)

const dir = FORWARD.clone().applyQuaternion(quat).normalize()
world.getPlayer().push(dir.multiplyScalar(30)) // short forward burst
```

### `.setSessionAvatar(url)`

Changes the avatar the player wears for the rest of their session. It does not change the avatar saved on their profile, and it is gone when they leave.

- **url**: an `asset://<name>.vrm` URL (a built-in avatar or an uploaded one) or an `http(s)://` URL, up to 512 characters. `null` clears the session avatar. Other values are ignored.

On a client, only the local player's session avatar can be set; server scripts can set any player's.

**Where to call it.** Every other visitor's browser downloads the file a session avatar names, so who may name a file outside the world is limited:

- From a **server** script (`if (world.isServer)`), any allowed URL works for any player. The server applies it and tells everyone.
- From a **client** script, the call speaks for the visitor whose browser runs it. An `asset://` avatar is shown to everyone. An `http(s)://` URL outside the world is shown to others only when that visitor is a builder; otherwise the server does not pass it on and sets the visitor's own view back.

The server tells the player's own client every session avatar it takes for that player, and answers each of that client's own calls with the session avatar it has afterwards. So when a client script's call and a server script's call cross on the network, everyone, the player included, ends on the one the server took last. A client that calls again before the answer to its earlier call arrives passes over that answer and waits for the answer to its latest call, so the player does not wear the earlier avatar again on the way. A call whose update never reaches the server (a client sending faster than the server admits) gets no answer: that client keeps showing its own latest choice.

A builder who stops being one (their rank is lowered, their token grant ends, or the world's rank setting no longer makes everyone a builder) loses a session avatar outside the world that no server script chose, and wears their own avatar again (the world's default avatar when their own is outside the world too).

So a script that dresses visitors in avatars hosted elsewhere must do it from server code. Do not pass a URL a visitor supplied to `setSessionAvatar` on the server: that hands the visitor the same reach.

### `.getBoneTransform(boneName)`: Matrix4

Returns a matrix of the bone transform in world space.

See [Avatar](/docs/scripting/nodes/types/Avatar.md) for full details.

### `.damage(amount)`

Removes health from the player. Health cannot go below zero.

- **amount**: a number. A numeric string or a boolean is converted (`'10'` is 10); any other value (an object, a
  boxed `new Number(10)`, a value that is not finite) changes nothing.

### `.heal(amount)`

Adds health to the player. Health cannot go above 100.

- **amount**: a number, 100 if left out, read as `damage` reads it.

### `.applyEffect({ anchor, emote, snare, freeze, turn, duration, cancellable, onEnd })`

Applies an effect to the player. If the player already has an effect, it is replaced. The returned
handle has a `cancel()` method; `player.cancelEffect()` also ends the effect applied by this app.
Both end only this app's own effect: when another app's effect has taken its place they do nothing.
On the server `applyEffect` answers `false`, and gives the player nothing, when the script has sent too much in
that tick for the clients to be told: the effect the player has stays.
`onEnd` runs when the effect is over for any reason; an effect it gives the player stays.
An effect a server script ends this way, or that ends because its app is rebuilt, removed or crashes, ends on the
player's client too. On the server `cancel()` and `cancelEffect()` answer `false` when the end could not be told
to every client. When the script has sent too much in that tick to tell any, the effect stays (the handle's
`active` is still `true`): call again in a later tick. (A client script that gives its own player another effect at that very moment can see the
new one ended instead: the message names no effect.)

All options are optional, and each is read once, when `applyEffect` is called. Apart from `anchor` (a node) and
`onEnd` (a function), an option's value is a primitive (a string, a number, a boolean, `null`): an object or a
function as a value, a boxed one such as `new Number(1)` or `new String('asset://e.glb')` included, refuses the whole
effect. A refused effect is not applied, locally or for
other players: `applyEffect` returns `undefined` and the player's current effect stays. A falsy value leaves its
option out.

What travels to the server and to other players is these options and nothing else, each as a short primitive: a
string of at most 512 characters, a finite number or a boolean; and all of them together at most 2 KB (the UTF-8
bytes of their JSON). An effect over that is refused, as above.

**anchor**: an [Anchor](/docs/scripting/nodes/types/Anchor.md) to attach the player to. Its network
`anchorId` must be a string of at most 128 characters; any other `anchorId` refuses the whole effect, as above.
Scale is removed when deriving the player's rotation, which is normalised. A non-finite, singular or
out-of-range anchor pose is ignored for that frame, preserving the previous pose.

**emote**: a string URL to an emote to play while this effect is active: `asset://<name>.glb`
(optionally with a playback query, eg `?s=1.5`) or an `http(s)://` URL, up to 512 characters. Invalid
values are ignored locally and do not replace locomotion. Playback speed `s` must parse to a finite
number in `[0.01, 100]`, otherwise it defaults to 1. The `l`/`g` string flags are unchanged.
As with a session avatar, other visitors load the emote: an `http(s)://` emote outside the world is shown to
them when a **server** script applied the effect (or the player is a builder), not when a client script did
for a visitor. An `asset://` emote works from either. A builder who stops being one stops showing others an
emote outside the world that no server script chose.

**snare**: a finite number from 0 to 1 that reduces movement speed, where zero means no snaring and one means entirely snared. Invalid values are treated as 0. When snared, players can still turn and attempt to move.

**freeze**: when true, the player is frozen in place and all movement keys are ignored.

**turn**: a boolean. Only `true` makes the player continually face the direction the camera is looking in.

**duration**: seconds until the effect ends as local simulation time advances. A falsy value
(`0`, `''`, `null`, `undefined`, `NaN` or `false`) means no expiry. A string or a boolean is converted to a number:
`'2'` lasts two seconds, `true` one. The rest counts down: positive remaining time is stored, otherwise the effect
ends, so a negative value and a string that is not a number (`'soon'`) end it on the next frame. `Infinity` never
expires. An object (`new Number(2)` included) refuses the effect, as above.

**cancellable**: whether any movement keys will cancel the effect. if enabled, freeze is ignored.

**onEnd**: a function that should be called either at the end of the `duration` or when the player moves if `cancellable`.

When the app stops or is rebuilt, its effects end and their `onEnd` runs. From there, the app's player handles can
still end things (`cancelEffect`, `setVoiceLevel(null)`) and act (`teleport`, `damage`, ...) while the teardown runs,
but not start new effects or voice levels: `applyEffect` and `setVoiceLevel(level)` throw `[app] this app has stopped`
(see [App teardown](/docs/scripting/app/App.md#teardown)).
On a handle whose player has left they throw `[player] this player has left`.

### `.screenshare(screenId)`

Can only be called on a local player.

Prompts the player to share their screen, and then casts it to all video nodes that have a matching `.screenId` property.

The `screenId` is a string of at most 128 characters. Which player may share to which screen is not enforced by the
server: the script decides who is offered the prompt, but a modified client can share to any `screenId` in the world.
A moderator's mute hides a player's share on every client, and a kick ends it.

### `.setVoiceLevel(level)`

Overrides the players voice chat level to `disabled`, `spatial` or `global`.

By default all players have the voice level defined in the world settings menu, but `.setVoiceLevel` allows apps to override it using any logic needed.

Calling `player.setVoiceLevel(null)` removes the current apps override and reverting to the world setting (unless another app is overriding it).

**NOTE:** Changes stack with priority, so if two apps have set a voice level, the higher priority level takes precendence. Global is the highest priority.

A voice level, like a moderator's mute, is carried out by the clients that listen: each plays a voice at that level or
not at all. A player whose level is `disabled`, or who is muted, still sends their microphone to the voice server
while it is on; no client that follows the level plays it.

Must be called on the server for security reasons.
