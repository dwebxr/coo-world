// The JWT secret signs every session token, and a token only carries a userId: whoever knows the secret can sign in
// as any user, admins included. `hyper` is the value .env.example used to ship and upstream hyperfy still ships, so
// a server that still has it is open to anyone who reads the repository.
export const PUBLIC_TEMPLATE_SECRETS = ['hyper']
export const MIN_SECRET_LENGTH = 32

const HOW_TO = 'generate one with `openssl rand -hex 32`'

// the secret itself is used as given; only the checks look at a trimmed, lower-cased copy, because a .env can keep
// spaces inside quotes (`'hyper '`) and case (`HYPER`), and those are no harder to guess
export function checkJwtSecret(secret, { warn = console.warn } = {}) {
  const normalized = String(secret ?? '')
    .trim()
    .toLowerCase()
  if (!normalized) {
    throw new Error(`[envs] JWT_SECRET not set: ${HOW_TO}`)
  }
  if (PUBLIC_TEMPLATE_SECRETS.includes(normalized)) {
    throw new Error(`[envs] JWT_SECRET is the public template value, so anyone can forge sign-ins: ${HOW_TO}`)
  }
  if (normalized.length < MIN_SECRET_LENGTH) {
    warn(`[envs] JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: ${HOW_TO}`)
  }
}

// JWT_SECRET_PREVIOUS: the secret before a planned change, accepted when a session token is read and never used to
// sign (utils-server.js). Unset is the normal state. Set, it must be a real secret (the template value would let
// anyone sign in as anyone, as it would for JWT_SECRET) and not the current one (then it does nothing). The raw
// values are compared: the checks above look at a trimmed, lower-cased copy.
export function checkPreviousJwtSecret(previous, current, { warn = console.warn } = {}) {
  if (previous === undefined || previous === '') return
  const normalized = String(previous).trim().toLowerCase()
  if (!normalized) {
    throw new Error('[envs] JWT_SECRET_PREVIOUS is blank: remove it, or set it to the secret that was in use before')
  }
  if (PUBLIC_TEMPLATE_SECRETS.includes(normalized)) {
    throw new Error('[envs] JWT_SECRET_PREVIOUS is the public template value, so anyone can forge sign-ins: remove it')
  }
  if (previous === current) {
    warn('[envs] JWT_SECRET_PREVIOUS is the same as JWT_SECRET: it has no effect, remove it')
    return
  }
  warn(
    '[envs] JWT_SECRET_PREVIOUS is set: session tokens signed with the previous secret are accepted and renewed. ' +
      'Remove it once returning users have had time to reconnect, and never set it to a secret that leaked.'
  )
}
