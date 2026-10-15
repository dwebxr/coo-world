import { test } from 'node:test'
import assert from 'node:assert/strict'

// imported without PUBLIC_TOKEN_MINT: gating is off, nothing talks to a chain
const gating = await import('../src/server/solana-gating.js')

test('wallet bookkeeping: recorded per socket, read back, cleared on revoke and on disconnect', () => {
  assert.equal(gating.TOKEN_GATING_ENABLED, false)
  assert.equal(gating.walletOf('s1'), null)
  gating.recordWallet('s1', 'WALLET_A')
  gating.recordWallet('s2', 'WALLET_A')
  assert.equal(gating.walletOf('s1'), 'WALLET_A')
  assert.equal(gating.walletOf('s2'), 'WALLET_A')
  // revoke clears one session only
  gating.clearWallet('s1')
  assert.equal(gating.walletOf('s1'), null)
  assert.equal(gating.walletOf('s2'), 'WALLET_A')
  // disconnect cleanup clears it along with the nonce state
  gating.clearSocket('s2')
  assert.equal(gating.walletOf('s2'), null)
  assert.equal(gating.clearWallet('never'), undefined, 'clearing an unknown socket is a no-op')
})
