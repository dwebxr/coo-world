// How much of the token a wallet must hold to be granted builder access (PUBLIC_REQUIRED_TOKEN_AMOUNT), read the
// same way by the server, which decides, and by the client, which only shows it.
//
// Not set: 10,000. Set: a number above 0. Anything else gives null, and null means that no wallet is granted
// builder access by token. An empty value used to read as 0, which every verified wallet reaches, also one that
// never held the token; a value that is not a number ("100,000") used to fall back to 10,000 without a word.
export const DEFAULT_REQUIRED_TOKEN_AMOUNT = 10000

export function parseRequiredTokenAmount(value) {
  if (value === undefined || value === null) return DEFAULT_REQUIRED_TOKEN_AMOUNT
  if (typeof value !== 'number' && typeof value !== 'string') return null
  // an empty or blank string is 0 to Number, and 0 is refused below
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}
