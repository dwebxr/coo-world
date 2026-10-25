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
