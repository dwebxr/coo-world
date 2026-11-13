// The four things src/server/solanaRpc.js used from @solana/spl-token, written here so that a production install
// does not need that package (it decodes u64 fields through bigint-buffer, GHSA-3gc7-fjrx-p6mg). Only what that
// file reads: the classic Token program (not Token-2022), the 165-byte account without extensions, and of it the
// mint, the owner and the amount. test/splTokenAccount.test.js compares each function with the real package, which
// stays installed as a dev dependency for that.
import { PublicKey } from '@solana/web3.js'

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
// mint 32, owner 32, amount 8, delegate 4 + 32, state 1, is-native 4 + 8, delegated amount 8, close authority 4 + 32
export const ACCOUNT_SIZE = 165

/**
 * The associated token account of `owner` for `mint` (both PublicKeys), as spl-token's
 * getAssociatedTokenAddressSync(mint, owner) gives it with its defaults: the Token program, and an owner on the
 * ed25519 curve. An owner off the curve (a program-derived address) throws, as it does there.
 */
export function associatedTokenAddress(mint, owner) {
  if (!PublicKey.isOnCurve(owner.toBuffer())) throw new Error('the owner is off the ed25519 curve')
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )
  return address
}

/**
 * The mint, owner and amount of a token account's data, at the offsets of spl-token's AccountLayout: mint bytes
 * 0-32, owner 32-64, amount an unsigned 64-bit little-endian integer at 64 (a bigint). The other fields (delegate,
 * state, close authority...) are neither read nor checked. Throws for anything but a Buffer of ACCOUNT_SIZE bytes.
 */
export function readTokenAccount(data) {
  if (!Buffer.isBuffer(data) || data.length !== ACCOUNT_SIZE) throw new Error('not the data of a token account')
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  }
}
