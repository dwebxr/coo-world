// Who may send what: every name of the packet registry (src/core/packets.js), with the rule the server applies to a
// client that sends it (src/core/systems/ServerNetwork.js, read handler by handler). Data only.
//
// test/packetAccess.test.js holds this table to the registry (a name without a rule fails, and so does a rule for a
// name that is gone) and to the server (a name whose rules say it is handled has an `on<Name>`, and the reverse).
// test/packetRefusals.test.js asks the handlers themselves, rule by rule, on the real class (test/lib/network.mjs).
// test/e2e/access-control.mjs sends the packets against a running server: each rule names the case there that
// tries it (`e2e`), or the existing test that does (`cover`), and the suite fails when a case named here did not
// run. So a new packet cannot be added without saying who may send it, and a rule cannot claim a case that does
// not exist. What the table cannot do is notice a rule that is wrong in itself: that is what the cases are for.
//
// One packet can fall under several rules (`command` is five commands; `entityModified` is a player's own fields,
// another player's, and an app's).

export const CLASSES = {
  any: 'any connection may send it; the handler checks the payload, not the sender',
  builder: 'the sender is a builder (its own rank or the rank the world gives everyone)',
  admin: 'the sender is an admin',
  'admin-setting': 'a world setting only an admin may change (settingsPolicy.js ADMIN_SETTING_KEYS)',
  outranks: "the sender's rank is above the target's (kick, mute)",
  holder: 'a sender that is no builder, on an app it holds itself: it may let go of its move or its upload',
  'admin-code': '`/admin <code>`: the code decides, and wrong codes are slowed and end with the socket closed',
  feature: 'a wallet flow: open to any connection where the world has the feature, ignored where it has not',
  relay: 'server to client; a copy a client sends is dropped, with a log line',
  'no-handler': 'server to client; the server has no handler for it, so a copy a client sends does nothing',
  nobody: 'refused whoever sends it, an admin included',
  'app-line':
    "a client script's line of chat: any connection may send it, and a line the server relays is the line of the app it names, never a player's",
  world: "depends on the world's settings: what is refused in one world is allowed in another",
}

// the classes under which the server has an `on<Name>` method for the packet
export const HANDLED = Object.keys(CLASSES).filter(name => name !== 'no-handler')

const FULLSTACK = 'test/e2e/fullstack.mjs'
const EXTRAS = 'test/e2e/gate-extras.mjs'
// (the token gate's own e2e suite, test/e2e/token-gate.mjs, drives these through a browser wallet)
const SOLANA_UNIT = 'test/serverWallet.test.js'
const EVM_WALLET = 'test/e2e/evm-wallet.mjs'
const EVM_TIPS = 'test/e2e/evm-tips-gate.mjs'
const TRANSFORMS = 'test/e2e/hostile-transforms.mjs'

// a rule tried by a case of access-control.mjs
const e2e = (kind, what, id, also) => ({ class: kind, what, e2e: id, ...(also ? { cover: also } : {}) })
// a rule another test already tries: the file, and a string that file must still contain (the step's name)
const covered = (kind, what, file, has) => ({ class: kind, what, cover: { file, has } })
const serverToClient = what => [e2e('no-handler', what, 'no-handler')]
// The wallet flows. Where the world has the feature the packet is answered, or acts on the sender's wallet state;
// where it has not, the handler returns before anything else. The five that are answered in a world with the
// feature to any sender are tried by the e2e case `wallet` in both worlds. The other six are not answered to a
// sender without a wallet state of its own (a sign-in under way, a verified wallet), whatever the world: from
// outside, their feature check cannot be told from the next check, so they are asked in the unit test, with that
// state set and collaborators that fail the test if they are touched.
const REFUSALS = 'test/packetRefusals.test.js'
const WALLET_UNIT = 'the wallet flows: in a world without the feature each handler returns before it reads anything'
const walletRule = (what, also) => [e2e('feature', what, 'wallet', also)]
const walletUnit = what => [covered('feature', what, REFUSALS, WALLET_UNIT)]
const SOLANA = 'the token gate (PUBLIC_TOKEN_MINT)'
const EVM = 'EVM sign-in (PUBLIC_EVM_CHAIN_IDS)'
const TIPS = 'tips (PUBLIC_EVM_CHAIN_IDS and PUBLIC_EVM_TIP_TOKENS)'
const RELAY = [
  covered(
    'relay',
    'a server script acts on a player; a client copy is dropped',
    FULLSTACK,
    'A8 a client-sent player relay packet'
  ),
]

export const PACKET_RULES = {
  snapshot: serverToClient('the join state'),
  command: [
    e2e(
      'any',
      "`/name <name>`: the sender's own name; any other words become the `command` event of server scripts",
      'any-connection'
    ),
    e2e('admin-code', '`/admin <code>`', 'admin-code', { file: FULLSTACK, has: 'A14b wrong admin codes' }),
    e2e('builder', '`/spawn set|clear`', 'spawn'),
    e2e('builder', '`/chat clear`', 'chat-clear'),
    e2e('builder', '`/server stats`', 'server-stats'),
  ],
  chatAdded: [
    e2e('any', 'a chat line; the server writes who it is from', 'any-connection', {
      file: FULLSTACK,
      has: 'A10 a malformed chat message',
    }),
  ],
  chatCleared: serverToClient('the chat was cleared (a client clears it with `/chat clear`)'),
  blueprintAdded: [e2e('builder', 'a new blueprint (refused at the inbound gate already)', 'blueprint-add')],
  blueprintModified: [
    e2e('builder', 'a change to a blueprint (refused at the inbound gate already)', 'blueprint-modify'),
  ],
  entityAdded: [
    e2e('builder', 'a new app', 'entity-add'),
    e2e('nobody', 'a player, or an app under the id of a player (an added entity is a new app)', 'player-add'),
  ],
  entityModified: [
    e2e('any', "the sender's own player: its movement fields and its name", 'any-connection'),
    e2e(
      'nobody',
      "the sender's own player: a field only the server sets (rank, userId, owner, health, type, enteredAt, evmTips, and position, quaternion, emote, effect under the server's own names)",
      'own-player'
    ),
    e2e('nobody', "another player's fields", 'other-player'),
    e2e('builder', 'an app', 'entity-modify'),
    e2e(
      'holder',
      'an app the sender is moving or uploading: `mover: null` / `uploader: null` and nothing else',
      'holder',
      {
        file: TRANSFORMS,
        has: 'demoted mover releases only',
      }
    ),
    e2e('world', "the sender's own stored avatar: a builder, or anyone where Custom Avatars is on", 'world-avatars'),
    covered(
      'builder',
      "a url outside the world as the sender's avatar, session avatar or emote",
      FULLSTACK,
      'A9b a url outside the world'
    ),
  ],
  entityEvent: [
    e2e('any', 'an event for an app script (the app decides what it listens to)', 'any-connection'),
    e2e('nobody', 'an event with the name of an engine hook or a world event (internalEvents.js)', 'internal-events'),
  ],
  entityRemoved: [
    e2e('builder', 'an app', 'entity-remove'),
    e2e('holder', 'an app whose upload the sender has pending', 'holder'),
    e2e('nobody', 'a player', 'other-player'),
  ],
  playerTeleport: RELAY,
  playerPush: RELAY,
  playerSessionAvatar: RELAY,
  liveKitLevel: serverToClient("a player's voice level"),
  mute: [e2e('outranks', 'mute or unmute a player (also server to client: who is muted)', 'mute')],
  settingsModified: [
    e2e('builder', 'title, desc, image, avatar, voice, playerLimit, ao', 'settings'),
    e2e('admin-setting', 'rank, customAvatars', 'settings-admin'),
  ],
  spawnModified: [e2e('builder', 'set or clear the spawn point', 'spawn')],
  modifyRank: [e2e('admin', "another player's rank, or the sender's own", 'modify-rank')],
  kick: [
    e2e('outranks', 'close a player and keep it out (also server to client: why a connection is closed)', 'kick', {
      file: FULLSTACK,
      has: 'A14c a kicked player is told',
    }),
  ],
  ai: [
    e2e('builder', "an AI action on the operator's account (refused at the inbound gate already)", 'ai', {
      file: EXTRAS,
      has: 'AI create through the mock base URL',
    }),
  ],
  ping: [e2e('any', 'answered with a pong: the barrier of every case', 'any-connection')],
  pong: serverToClient('the answer to a ping'),
  requestBuilderByToken: walletUnit(`${SOLANA}: the signed message, for a sign-in under way`),
  revokeBuilderByToken: walletUnit(`${SOLANA}: a verified wallet given up`),
  requestBuilderNonce: walletRule(SOLANA, { file: SOLANA_UNIT, has: 'onRequestBuilderNonce' }),
  builderNonce: serverToClient('the sign-in message of the token gate'),
  walletStatus: serverToClient('whether the wallet is verified'),
  tokenBalanceRequest: walletRule(SOLANA, { file: SOLANA_UNIT, has: 'onTokenBalanceRequest' }),
  tokenBalance: serverToClient('a token balance'),
  requestBuilderRecheck: walletUnit(`${SOLANA}: a verified wallet's balance asked again`),
  requestEvmNonce: walletRule(EVM, { file: EVM_WALLET, has: 'requestEvmNonce' }),
  evmNonce: serverToClient('the EVM sign-in message'),
  requestEvmVerify: walletUnit(`${EVM}: the signed message, for a sign-in under way`),
  evmWalletStatus: serverToClient('whether the EVM wallet is verified'),
  revokeEvmWallet: walletUnit(`${EVM}: a verified wallet given up`),
  setEvmTipReceive: walletUnit(`${TIPS}: a verified wallet's switch for receiving tips`),
  requestEvmTipIntent: walletRule(TIPS, { file: EVM_TIPS, has: 'requestEvmTipIntent' }),
  evmTipIntent: serverToClient('the answer to a tip intent'),
  evmTip: walletRule(TIPS, { file: EVM_TIPS, has: "wire.send('evmTip'" }),
  evmTipStatus: serverToClient('what became of a reported tip'),
  appChat: [
    e2e(
      'app-line',
      "a client script's world.chat(): relayed, if at all, as the line of an app that exists (kind app, no player id, the app's name from the server's blueprint), within the connection's budget. Not checked by anything: which app's script sent it (a known gap, CHANGELOG \"What remains\"; the suite says in a GAP line what the server did)",
      'app-chat'
    ),
  ],
}

// The settings of a world that change who may do what. A case of the suite, or the test that covers it.
export const WORLD_CONFIG = [
  e2e('world', 'settings.rank = builder: every connection is a builder (free build)', 'world-rank'),
  e2e('world', 'settings.customAvatars: anyone may set their stored avatar (and upload a .vrm)', 'world-avatars'),
  covered(
    'world',
    'no ADMIN_CODE, with ADMIN_OPEN=true or outside production: every connection is an admin',
    'test/adminCode.test.js',
    "'open'"
  ),
  e2e('world', 'PUBLIC_TOKEN_MINT / PUBLIC_EVM_CHAIN_IDS / PUBLIC_EVM_TIP_TOKENS: the wallet flows exist', 'wallet'),
]

// What is not a packet rule and is asserted elsewhere: named here so that the suite does not repeat it.
export const OTHER_COVER = [
  covered(
    'builder',
    'POST /api/upload and /api/upload-check: who may upload what',
    'test/uploadRoutes.test.js',
    'upload: visitor without the avatar exception'
  ),
  covered('builder', 'a builder upload stored and served', EXTRAS, 'builder upload'),
  covered('any', 'the headers of pages and of stored files', EXTRAS, 'page headers'),
  covered('any', '/status counts and names nobody', FULLSTACK, 'A8b /status counts who is here'),
  covered('any', 'an outdated client is refused before a user row is made', FULLSTACK, 'A15 an outdated client'),
  covered(
    'any',
    'session tokens: algorithm, expiry, renewal, the previous secret',
    'test/sessionTokens.test.js',
    'only HS256 tokens'
  ),
]

// the event names the suite sends as `entityEvent` and expects to be refused: each is a world event server scripts
// trust (a confirmed tip, a verified wallet, a command a player typed)
export const REFUSED_EVENT_NAMES = ['tip', 'evmWallet', 'command']

// the cases of access-control.mjs that are not about one packet
export const OTHER_CASES = ['identity', 'secrets', 'secrets-wallet-world']

export const rulesOf = name => (Object.prototype.hasOwnProperty.call(PACKET_RULES, name) ? PACKET_RULES[name] : null)
export const isHandled = name => (rulesOf(name) ?? []).some(rule => HANDLED.includes(rule.class))
export const namesOfClass = kind =>
  Object.keys(PACKET_RULES).filter(name => PACKET_RULES[name].some(rule => rule.class === kind))
// the names a case of the suite tries
export const namesOfCase = id =>
  Object.keys(PACKET_RULES).filter(name => PACKET_RULES[name].some(rule => rule.e2e === id))

// every case of the suite the tables name
export function namedCases() {
  const ids = new Set(OTHER_CASES)
  for (const rules of [...Object.values(PACKET_RULES), WORLD_CONFIG]) {
    for (const rule of rules) if (rule.e2e) ids.add(rule.e2e)
  }
  return [...ids].sort()
}

// What is wrong between the registry, the tables and the server's handlers -> a list of sentences, empty when they
// agree. `names`: the registry's names; `handlers`: the packet names the server has an `on<Name>` method for.
export function checkPacketRules({ names, handlers }, rules = PACKET_RULES) {
  const problems = []
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(rules, name)) problems.push(`${name} is in the registry and has no rule`)
  }
  for (const [name, list] of Object.entries(rules)) {
    if (!names.includes(name)) problems.push(`${name} has a rule and is not in the registry`)
    if (!Array.isArray(list) || !list.length) {
      problems.push(`${name} has no rule`)
      continue
    }
    for (const rule of list) {
      if (!Object.prototype.hasOwnProperty.call(CLASSES, rule.class))
        problems.push(`${name}: ${rule.class} is not a class`)
      if (!rule.what) problems.push(`${name}: a rule that does not say what it is about`)
      if (!rule.e2e && !rule.cover) problems.push(`${name}: a rule that no case and no test tries`)
    }
    const handled = list.some(rule => HANDLED.includes(rule.class))
    if (handled && list.some(rule => rule.class === 'no-handler')) {
      problems.push(`${name} is said to be handled and to have no handler`)
    }
    if (handled && !handlers.includes(name))
      problems.push(`${name} is said to be handled and the server has no handler`)
    if (!handled && handlers.includes(name)) problems.push(`${name} has a handler on the server and no rule for it`)
  }
  return problems
}
