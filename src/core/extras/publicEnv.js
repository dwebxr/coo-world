// What of the environment the page is handed: /env.js at run time (src/server/index.js) and the defines of the
// build (scripts/lib/buildDefines.mjs).
//
// It is a list of names, and no other name is handed out: the PUBLIC_ names the browser code reads, each of them
// as a literal (test/publicEnv.test.js keeps the list equal to the literals in what is bundled for a browser). The
// prefix alone used to be enough, so any variable an operator named PUBLIC_… was served to every visitor.
// What this does not do: it does not look at values. Whatever is put under one of these names is served.
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

// PUBLIC_ names that the server alone reads. Not in /env.js or the defines either, and not named at start-up: the
// server knows what they are for.
// - PUBLIC_API_URL and PUBLIC_MAX_UPLOAD_SIZE reach the page in the join snapshot (apiUrl, maxUploadSize)
// - PUBLIC_TOKEN_DECIMALS is read where balances are read (tokenBalance.js)
// - PUBLIC_RPC_URL is the deprecated fallback of SOLANA_RPC_URL and can hold an RPC credential
export const SERVER_PUBLIC_ENV_NAMES = Object.freeze([
  'PUBLIC_API_URL',
  'PUBLIC_MAX_UPLOAD_SIZE',
  'PUBLIC_TOKEN_DECIMALS',
  'PUBLIC_RPC_URL',
])

export const isPublicEnvKey = key => PUBLIC_ENV_NAMES.includes(key)

// the listed names that are set, in the order of the list
export function buildPublicEnv(env) {
  const out = {}
  for (const name of PUBLIC_ENV_NAMES) {
    if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) out[name] = env[name]
  }
  return out
}

export function buildPublicEnvDefines(env) {
  return Object.fromEntries(
    Object.entries(buildPublicEnv(env)).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])
  )
}

// The PUBLIC_ names in the environment that nothing reads: neither served nor one of the server's own. A name like
// that was probably meant to reach the page (it did, before the list), or is a mistake.
export function unlistedPublicEnv(env) {
  return Object.keys(env)
    .filter(key => key.startsWith('PUBLIC_') && !isPublicEnvKey(key) && !SERVER_PUBLIC_ENV_NAMES.includes(key))
    .sort()
}

// What the server says about them when it starts, once: the names and never a value. null when there are none.
export function unlistedPublicEnvNote(env) {
  const names = unlistedPublicEnv(env)
  if (!names.length) return null
  return (
    `[envs] not handed to the page (/env.js): ${names.join(', ')}. ` +
    `Only names the client reads are: ${PUBLIC_ENV_NAMES.join(', ')}`
  )
}
