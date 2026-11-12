import { test } from 'node:test'
import assert from 'node:assert/strict'

import { grantTokenRank, rankStored, revokeTokenRank } from '../src/server/rankGrants.js'
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

// rankStored is what ServerNetwork has userRows.js call when a rank it decided has landed (storeRank); the sequences
// of writes that lead to each call are in test/serverWallet.test.js, through the handlers
test('stored: the grant is over when the database holds the rank the session has, builder or visitor', () => {
  const socket = { id: 's-stored', disconnected: false }
  const p = player('s-stored')
  grantTokenRank({ socket, player: p, walletAddress: 'WALLET_C', wallets })
  p.data.rank = 1
  assert.equal(rankStored({ player: p, rank: 1, wallets, isCurrent: () => true }), true)
  assert.equal(p.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-stored'), null)
  // a stored visitor rank ends a grant the same way
  const demoted = player('s-demote', { rank: 0, tokenGrantedRank: true })
  wallets.recordWallet('s-demote', 'WALLET_D')
  assert.equal(rankStored({ player: demoted, rank: 0, wallets, isCurrent: () => true }), true)
  assert.equal(demoted.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-demote'), null)
})

test('stored: a rank other than the one the session has leaves the grant as it is, in both directions', () => {
  // the database took visitor; the session is a builder again (a later decision on its way, or a new grant)
  const up = player('s-up', { rank: 1, tokenGrantedRank: true })
  wallets.recordWallet('s-up', 'WALLET_UP')
  assert.equal(rankStored({ player: up, rank: 0, wallets, isCurrent: () => true }), false)
  assert.equal(up.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf('s-up'), 'WALLET_UP')
  // the database took builder; the session is a visitor meanwhile (a later decision on its way)
  const down = player('s-down', { rank: 0, tokenGrantedRank: true })
  wallets.recordWallet('s-down', 'WALLET_DOWN')
  assert.equal(rankStored({ player: down, rank: 1, wallets, isCurrent: () => true }), false)
  assert.equal(down.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf('s-down'), 'WALLET_DOWN')
  wallets.clearSocket('s-up')
  wallets.clearSocket('s-down')
})

test('stored: a player that is no longer the session of its user changes nothing', () => {
  // the user reconnected: the wallet table's entry under the same id is the new session's
  const p = player('session-race', { rank: 0, tokenGrantedRank: true })
  wallets.recordWallet(p.data.id, 'RECONNECTED_WALLET')
  assert.equal(rankStored({ player: p, rank: 0, wallets, isCurrent: () => false }), false)
  assert.equal(p.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf(p.data.id), 'RECONNECTED_WALLET')
  wallets.clearSocket(p.data.id)
})
