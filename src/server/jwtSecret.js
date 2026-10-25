// The JWT secret signs every session token, and a token only carries a userId: whoever knows the secret can sign in
// as any user, admins included. `hyper` is the value .env.example used to ship and upstream hyperfy still ships, so
// a server that still has it is open to anyone who reads the repository.
export const PUBLIC_TEMPLATE_SECRETS = ['hyper']
export const MIN_SECRET_LENGTH = 32

const HOW_TO = 'generate one with `openssl rand -hex 32`'

export function checkJwtSecret(secret, { warn = console.warn } = {}) {
  if (!secret) {
    throw new Error(`[envs] JWT_SECRET not set: ${HOW_TO}`)
  }
  if (PUBLIC_TEMPLATE_SECRETS.includes(secret)) {
    throw new Error(`[envs] JWT_SECRET is the public template value, so anyone can forge sign-ins: ${HOW_TO}`)
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    warn(`[envs] JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: ${HOW_TO}`)
  }
}
