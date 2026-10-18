export const PUBLIC_ENV_DENYLIST = ['PUBLIC_RPC_URL']

export const isPublicEnvKey = key => key.startsWith('PUBLIC_') && !PUBLIC_ENV_DENYLIST.includes(key)

export function buildPublicEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => isPublicEnvKey(key)))
}

export function buildPublicEnvDefines(env) {
  return Object.fromEntries(
    Object.entries(buildPublicEnv(env)).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])
  )
}
