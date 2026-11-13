// What of the environment the page is handed: /env.js at run time (src/server/index.js) and the defines of the
// build (scripts/lib/buildDefines.mjs).
//
// Lists of names, and no other name is handed out. The prefix alone used to be enough, so any variable an operator
// named PUBLIC_… was served to every visitor. What this does not do: it does not look at values. Whatever is put
// under one of the listed names is served.

// The PUBLIC_ names the browser code reads, each of them as a literal (test/publicEnv.test.js keeps this list equal
// to the literals in what is bundled for a browser). Served in /env.js, and written into the page's bundles by the
// build.
export const PUBLIC_ENV_NAMES = Object.freeze([
  'PUBLIC_WS_URL',
  'PUBLIC_PLAYER_COLLISION',
  'PUBLIC_DEBUG',
  'PUBLIC_TOKEN_MINT',
  'PUBLIC_REQUIRED_TOKEN_AMOUNT',
  'PUBLIC_EVM_CHAIN_IDS',
  'PUBLIC_EVM_TIP_TOKENS',
  'PUBLIC_WALLETCONNECT_PROJECT_ID',
])

// Served in /env.js as before the lists, when they are set. The server reads them; nothing in this repository reads
// them from the page, but a page or tool outside it may. They are public values (the first two also reach the page
// in the join snapshot, as apiUrl and maxUploadSize), and a world that sets them gets the /env.js it got before.
// Not written into the bundles: no bundled code reads them, so a define would replace nothing.
export const SERVED_AS_BEFORE_ENV_NAMES = Object.freeze([
  'PUBLIC_API_URL',
  'PUBLIC_MAX_UPLOAD_SIZE',
  'PUBLIC_TOKEN_DECIMALS',
])

// what /env.js serves: the two lists
export const SERVED_ENV_NAMES = Object.freeze([...PUBLIC_ENV_NAMES, ...SERVED_AS_BEFORE_ENV_NAMES])

// Left out of /env.js without a word at start-up: the deprecated fallback of SOLANA_RPC_URL, which the server alone
// reads and which can hold an RPC credential (it was refused by name before the lists too).
export const WITHHELD_ENV_NAMES = Object.freeze(['PUBLIC_RPC_URL'])

export const isPublicEnvKey = key => SERVED_ENV_NAMES.includes(key)

// the served names that are set, in the order the environment has them (so a world that sets no other PUBLIC_ name
// gets the /env.js it got before the lists)
export function buildPublicEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => isPublicEnvKey(key) && value !== undefined))
}

// the defines of the page's bundles: the names the client reads that are set, each value as a JSON string
export function buildPublicEnvDefines(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => PUBLIC_ENV_NAMES.includes(key) && value !== undefined)
      .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])
  )
}

// The PUBLIC_ names in the environment that are neither served nor withheld by name. A name like that was probably
// meant to reach the page (it did, before the lists), or is a mistake.
export function unlistedPublicEnv(env) {
  return Object.keys(env)
    .filter(key => key.startsWith('PUBLIC_') && !isPublicEnvKey(key) && !WITHHELD_ENV_NAMES.includes(key))
    .sort()
}

// What the server says about them when it starts, once: the names and never a value. null when there are none.
export function unlistedPublicEnvNote(env) {
  const names = unlistedPublicEnv(env)
  if (!names.length) return null
  return (
    `[envs] not handed to the page (/env.js): ${names.join(', ')}. ` +
    `The names it serves are: ${SERVED_ENV_NAMES.join(', ')}`
  )
}
