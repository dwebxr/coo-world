import { test } from 'node:test'
import assert from 'node:assert/strict'

import { endGrantByDecision, grantTokenRank, revokeTokenRank } from '../src/server/rankGrants.js'
// the real wallet table, so the hand-over between the two modules is what runs
const wallets = await import('../src/server/solana-gating.js')

const player = (id, data = {}) => ({
  rankRevision: 0,
  data: { id, userId: id, rank: 0, ...data },
})

test('grant: a live session is flagged and keyed to its wallet; a session that ended during the check gets nothing', () => {
  const live = { id: 's-live', disconnected: false }
  const p = player('s-live')
  assert.equal(grantTokenRank({ socket: live, player: p, walletAddress: 'WALLET_A', wallets }), true)
  assert.equal(p.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf('s-live'), 'WALLET_A')
  const gone = { id: 's-gone', disconnected: true }
  const q = player('s-gone')
  wallets.clearSocket('s-gone') // what onDisconnect did while the chain was being consulted
  assert.equal(grantTokenRank({ socket: gone, player: q, walletAddress: 'WALLET_B', wallets }), false)
  assert.equal(q.data.tokenGrantedRank, undefined)
  assert.equal(wallets.walletOf('s-gone'), null, 'no stale entry')
  revokeTokenRank({ socket: live, player: p, wallets })
  assert.equal(p.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-live'), null)
})

// endGrantByDecision is what ServerNetwork.storeRank runs when an admin or the admin code decides a rank; the
// sequences of decisions and writes around it are in test/serverWallet.test.js, through the handlers
test('a decided rank ends the grant at once: the mark and the wallet entry go, whatever rank was decided', () => {
  for (const rank of [0, 1, 2]) {
    const socket = { id: `s-decided-${rank}`, disconnected: false }
    const p = player(socket.id)
    grantTokenRank({ socket, player: p, walletAddress: 'WALLET_C', wallets })
    // (the handler gave the player the rank before it called this; nothing here reads it)
    p.data.rank = rank
    endGrantByDecision({ player: p, wallets })
    assert.equal(p.data.tokenGrantedRank, false)
    assert.equal(wallets.walletOf(socket.id), null)
  }
  // a player without a grant: nothing to end, and another player's entry is not touched
  wallets.recordWallet('s-other', 'WALLET_OTHER')
  const plain = player('s-plain')
  endGrantByDecision({ player: plain, wallets })
  assert.equal(plain.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-other'), 'WALLET_OTHER')
  wallets.clearSocket('s-other')
})
