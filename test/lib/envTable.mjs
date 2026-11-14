// Every environment variable name the server, the scripts and the agent read, and what kind of value it holds.
// Data only (nothing is imported): test/envTable.test.js holds it to the source in both directions (a name that is
// read and not here fails, and so does a name here that nothing reads any more), test/e2e/access-control.mjs
// takes from it which values must never reach a page, and a check of .env.example can be built on it.
//
// The classes:
//   secret    whoever holds the value can act as the server or as its operator (sign a session for any user, become
//             admin, spend on the operator's accounts, read the database or the store). It must not reach a page, a
//             bundle, a packet or /status.
//   public    reaches every visitor by design; `served` says where.
//   operator  a setting of the operator's: neither a secret nor handed out as such (a limit, a path, a switch).
//   internal  a knob for tests or for looking into a running server; not a setting of a world.
//   platform  set by the hosting platform or by the build, not by the operator.
//
// A name ending in `*` stands for every name that begins so (one variable per chain id).
export const ENV_CLASSES = ['secret', 'public', 'operator', 'internal', 'platform']

const secret = why => ({ class: 'secret', why })
const served = (where, why) => ({ class: 'public', served: where, why })
const operator = why => ({ class: 'operator', why })
const ENV_JS = '/env.js (publicEnv.js PUBLIC_ENV_NAMES)'
const ENV_JS_AS_BEFORE = '/env.js (publicEnv.js SERVED_AS_BEFORE_ENV_NAMES)'

export const ENV_TABLE = {
  // ---- secrets ----
  JWT_SECRET: secret('signs every session token: its holder is any user, admins included'),
  JWT_SECRET_PREVIOUS: secret('still accepted when a session token is read: its holder is any user'),
  ADMIN_CODE: secret('`/admin <code>` makes a player admin'),
  AI_API_KEY: secret("the operator's account at the AI provider"),
  LIVEKIT_API_SECRET: secret('signs voice tokens: its holder joins and publishes in any room'),
  DB_URI: secret('a PostgreSQL address with its password (or the word `local`)'),
  ASSETS_S3_URI: secret("the store's address with its access key and secret"),
  SOLANA_RPC_URL: secret('an RPC address whose path or query is the credential'),
  PUBLIC_RPC_URL: secret('the deprecated fallback of SOLANA_RPC_URL: the same kind of address, under a PUBLIC_ name'),
  'EVM_RPC_URL_*': secret('an RPC address whose path is the credential, one per chain id'),

  // ---- handed to every visitor ----
  PUBLIC_WS_URL: served(ENV_JS, 'where the page connects'),
  PUBLIC_PLAYER_COLLISION: served(ENV_JS, 'a physics switch both sides read'),
  PUBLIC_DEBUG: served(ENV_JS, 'whether the page puts engine handles on window'),
  PUBLIC_TOKEN_MINT: served(ENV_JS, 'the token of the token gate'),
  PUBLIC_REQUIRED_TOKEN_AMOUNT: served(ENV_JS, 'the amount the wallet panel shows'),
  PUBLIC_EVM_CHAIN_IDS: served(ENV_JS, 'the chains of EVM sign-in'),
  PUBLIC_EVM_TIP_TOKENS: served(ENV_JS, 'the tokens of the tip form'),
  PUBLIC_WALLETCONNECT_PROJECT_ID: served(ENV_JS, 'a project id that is public by design'),
  PUBLIC_API_URL: served(`${ENV_JS_AS_BEFORE} and the join snapshot (apiUrl)`, 'where the page uploads'),
  PUBLIC_MAX_UPLOAD_SIZE: served(
    `${ENV_JS_AS_BEFORE} and the join snapshot (maxUploadSize)`,
    'the limit the page applies before it uploads'
  ),
  PUBLIC_TOKEN_DECIMALS: served(ENV_JS_AS_BEFORE, "the token's decimals; the server reads it, the page does not"),
  ASSETS_BASE_URL: served('the join snapshot (assetsUrl) and the page (og:url)', 'where asset:// urls load from'),
  LIVEKIT_WS_URL: served('the join snapshot (livekit.wsUrl)', 'the voice server the page connects to'),
  LIVEKIT_API_KEY: served(
    "the join snapshot: the `iss` of every player's voice token (livekit.token)",
    'the key id of the voice server; the token it names is signed with LIVEKIT_API_SECRET'
  ),
  AI_PROVIDER: served('the join snapshot (ai.provider)', 'shown in the AI pane'),
  AI_MODEL: served('the join snapshot (ai.model)', 'shown in the AI pane'),
  AI_EFFORT: served('the join snapshot (ai.effort)', 'shown in the AI pane'),

  // ---- the operator's settings ----
  WORLD: operator('the world folder'),
  PORT: operator('the port the server listens on'),
  NODE_ENV: operator('`production` locks admin without a code and turns the test knobs off'),
  SAVE_INTERVAL: operator('seconds between saves'),
  ADMIN_OPEN: operator('`true`: every visitor is an admin (no code)'),
  KICK_MINUTES: operator('how long a kick keeps a user out'),
  KICK_BY_ADDRESS: operator('a kick by an admin also holds new users from that address'),
  HSTS_MAX_AGE: operator('the Strict-Transport-Security header'),
  CSP_MODE: operator("`report` or `enforce`: how the world page's Content-Security-Policy is sent"),
  CLEAN: operator('the clean-up of unused assets at start-up'),
  CLEAN_TRASH_DAYS: operator('how long removed assets stay in the trash'),
  DB_SCHEMA: operator('the PostgreSQL schema'),
  ASSETS: operator('`local` or `s3`'),
  OUTBOUND_TRUSTED_ORIGINS: operator("origins the guard on server scripts' fetches trusts beside the assets URL"),
  MONITOR_TICK: operator('`1`: a per-minute summary of server tick times in the log'),
  TOKEN_BALANCE_TTL_SECONDS: operator('how long a token balance is cached'),
  EVM_HOLDING_CONTRACTS: operator('the contracts player.getEvmHolding() may ask about'),
  UPLOAD_CONCURRENT_TOTAL: operator('upload limit'),
  UPLOAD_CONCURRENT_VISITORS: operator('upload limit'),
  UPLOAD_RESERVED_TRUSTED: operator('upload limit'),
  UPLOAD_RATE_VISITOR_PER_MIN: operator('upload limit'),
  UPLOAD_RATE_BUILDER_PER_MIN: operator('upload limit'),
  UPLOAD_CHECK_RATE_PER_MIN: operator('upload limit'),
  UPLOAD_QUOTA_VISITOR_MB: operator('upload limit'),
  UPLOAD_QUOTA_BUILDER_MB: operator('upload limit'),
  UPLOAD_QUOTA_VISITORS_TOTAL_MB: operator('upload limit'),
  UPLOAD_SLOT_TIMEOUT_S: operator('upload limit'),
  UPLOAD_MIN_FREE_MB: operator('upload limit'),
  UPLOAD_MAX_TRACKED: operator('upload limit'),
  UPLOAD_CLIENT_IP_HEADER: operator("the proxy header a client's address is read from"),
  UPLOAD_LOG_CLIENT_IP: operator("`true`: upload log lines carry the client's address"),
  STORAGE_MAX_KEYS: operator('script storage limit'),
  STORAGE_MAX_VALUE_BYTES: operator('script storage limit'),
  STORAGE_MAX_BYTES: operator('script storage limit'),
  WS_CONNECT_RATE_PER_MIN: operator('connection limit'),
  WS_CONNECT_BURST: operator('connection limit'),
  WS_CONNECT_RATE_PER_MIN_56: operator('connection limit'),
  WS_CONNECT_BURST_56: operator('connection limit'),
  WS_CONNECT_RATE_PER_MIN_48: operator('connection limit'),
  WS_CONNECT_BURST_48: operator('connection limit'),
  WS_CONNECT_CONCURRENT_PER_IP: operator('connection limit'),
  WS_CONNECT_CONCURRENT_PER_56: operator('connection limit'),
  WS_CONNECT_CONCURRENT_PER_48: operator('connection limit'),
  WS_MAX_SOCKETS: operator('connection limit'),
  WS_CONNECT_MAX_TRACKED: operator('connection limit'),
  WS_RESERVED_SOCKETS: operator('connection places kept for ranked users'),
  WS_RESERVED_RANK: operator('connection places kept for ranked users'),
  AI_MAX_PER_USER_PER_HOUR: operator('AI limit'),
  AI_MAX_PER_HOUR: operator('AI limit'),
  AI_MAX_CONCURRENT: operator('AI limit'),
  AI_MAX_SECONDS: operator('AI limit'),
  // agent.mjs (the node client), not the server
  WS_URL: operator('agent.mjs: the world it connects to'),
  AGENT_ID: operator('agent.mjs: names its token file'),
  AGENT_NAME: operator("agent.mjs: the agent's name"),
  AGENT_AVATAR: operator("agent.mjs: the agent's avatar"),
  AGENT_TICK_MS: operator('agent.mjs: its loop interval'),

  // ---- test knobs ----
  ADMIN_ATTEMPT_WAIT_SCALE: {
    class: 'internal',
    why: 'shortens the waits after wrong admin codes, for the e2e suites; ignored with NODE_ENV=production',
  },

  // ---- the platform and the build ----
  COMMIT_HASH: { class: 'platform', why: 'set by the image build', served: '/status (commitHash)' },
  FLY_APP_NAME: { class: 'platform', why: 'set by Fly: client addresses are then read from fly-client-ip' },
  CLIENT: { class: 'platform', why: "a define key of the server's build (scripts/lib/buildDefines.mjs), not a read" },
  SERVER: { class: 'platform', why: "a define key of the server's build (scripts/lib/buildDefines.mjs), not a read" },
  // (scripts/prod-smoke.mjs hands these three of its own environment to the server it starts, and nothing else)
  PATH: { class: 'platform', why: "the system's; passed on by scripts/prod-smoke.mjs to the server it starts" },
  HOME: { class: 'platform', why: "the system's; passed on by scripts/prod-smoke.mjs to the server it starts" },
  TMPDIR: { class: 'platform', why: "the system's; passed on by scripts/prod-smoke.mjs to the server it starts" },
}

// the entry of a name: its own, or that of the `STEM_*` entry it falls under
export function envEntry(name, table = ENV_TABLE) {
  if (Object.prototype.hasOwnProperty.call(table, name)) return table[name]
  for (const key of Object.keys(table)) {
    if (key.endsWith('*') && name.startsWith(key.slice(0, -1)) && name.length > key.length - 1) return table[key]
  }
  return null
}

export const envNamesOf = (kind, table = ENV_TABLE) => Object.keys(table).filter(name => table[name].class === kind)

// What is wrong between a table and what the source reads (envScan.mjs scanEnvSource) -> a list of sentences, empty
// when they agree.
export function checkEnvTable({ names, stems, blind }, table = ENV_TABLE) {
  const problems = []
  for (const [name, entry] of Object.entries(table)) {
    if (!ENV_CLASSES.includes(entry?.class)) problems.push(`${name}: class ${JSON.stringify(entry?.class)} is not one`)
    if (typeof entry?.why !== 'string' || !entry.why) problems.push(`${name}: no reason given`)
    if (entry?.class === 'public' && !entry.served) problems.push(`${name}: public, and not said where it is served`)
  }
  for (const [name, files] of names) {
    if (!envEntry(name, table)) problems.push(`${name} is read (${files.join(', ')}) and has no class`)
  }
  for (const [stem, files] of stems) {
    // a templated name: the table has `STEM_*`, or names beginning with the stem are read by name beside it
    const listed = Object.prototype.hasOwnProperty.call(table, `${stem}*`)
    const spelled = [...names.keys()].some(name => name.startsWith(stem) && name.length > stem.length)
    if (!listed && !spelled) problems.push(`${stem}<…> is read (${files.join(', ')}) and has no class`)
  }
  for (const file of blind) {
    problems.push(`${file} reads the environment by a computed name and the scan found no name for it`)
  }
  for (const name of Object.keys(table)) {
    const read = name.endsWith('*') ? stems.has(name.slice(0, -1)) : names.has(name)
    if (!read) problems.push(`${name} has a class and nothing reads it`)
  }
  return problems
}
