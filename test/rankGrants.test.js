import { test } from 'node:test'
import assert from 'node:assert/strict'

import { grantTokenRank, persistRank, revokeTokenRank } from '../src/server/rankGrants.js'
// the real wallet table, so the hand-over between the two modules is what runs
const wallets = await import('../src/server/solana-gating.js')

// a knex-shaped stand-in: db('users').where('id', id).update({ rank }) records the write, or fails
const makeDb = ({ fail = false } = {}) => {
  const writes = []
  const db = table => ({
    where: (column, value) => ({
      update: async patch => {
        if (fail) throw new Error('SQLITE_BUSY')
        writes.push({ table, column, value, ...patch })
      },
    }),
  })
  return { db, writes }
}
const player = (id, data = {}) => ({
  rankRevision: 0,
  rankWritesPending: 0,
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

test('persist: the grant is cleared only once the rank is in the database; a failed write leaves the session as it was', async () => {
  const socket = { id: 's-persist', disconnected: false }
  const p = player('s-persist')
  grantTokenRank({ socket, player: p, walletAddress: 'WALLET_C', wallets })
  const failing = makeDb({ fail: true })
  await assert.rejects(
    persistRank({ db: failing.db, player: p, rank: 1, wallets, isCurrent: () => true }),
    /SQLITE_BUSY/
  )
  assert.equal(p.data.tokenGrantedRank, true, 'still a token grant')
  assert.equal(wallets.walletOf('s-persist'), 'WALLET_C', 'still keyed to the wallet')
  const ok = makeDb()
  await persistRank({ db: ok.db, player: p, rank: 1, wallets, isCurrent: () => true })
  assert.deepEqual(ok.writes, [{ table: 'users', column: 'id', value: 's-persist', rank: 1 }])
  assert.equal(p.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-persist'), null)
  // a stored visitor rank ends a grant the same way
  const demoted = player('s-demote', { rank: 1, tokenGrantedRank: true })
  wallets.recordWallet('s-demote', 'WALLET_D')
  await persistRank({ db: ok.db, player: demoted, rank: 0, wallets, isCurrent: () => true })
  assert.equal(demoted.data.tokenGrantedRank, false)
  assert.equal(wallets.walletOf('s-demote'), null)
})

test('persist: helper fault injection preserves a newer revision after an older write', async () => {
  let finish
  const db = () => ({ where: () => ({ update: () => new Promise(resolve => (finish = resolve)) }) })
  const p = player('revision-race')
  const pending = persistRank({ db, player: p, rank: 0, wallets, isCurrent: () => true })
  p.rankRevision++
  grantTokenRank({ socket: { id: p.data.id }, player: p, walletAddress: 'NEW_WALLET', wallets })
  finish()
  await pending
  assert.equal(p.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf(p.data.id), 'NEW_WALLET')
  wallets.clearSocket(p.data.id)
})

test('persist: helper fault injection preserves a replacement session at the same revision', async () => {
  let finish
  let current = true
  const db = () => ({ where: () => ({ update: () => new Promise(resolve => (finish = resolve)) }) })
  const p = player('session-race', { tokenGrantedRank: true })
  const pending = persistRank({ db, player: p, rank: 0, wallets, isCurrent: () => current })
  current = false
  wallets.recordWallet(p.data.id, 'RECONNECTED_WALLET')
  finish()
  await pending
  assert.equal(p.data.tokenGrantedRank, true)
  assert.equal(wallets.walletOf(p.data.id), 'RECONNECTED_WALLET')
  wallets.clearSocket(p.data.id)
})
