// `/admin <code>` in the real ServerNetwork.onCommand (test/lib/networkHarness.mjs): who becomes admin, what a wrong
// code does, and what the world tells clients about its admin mode. The brake itself is in test/adminCode.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeNetwork } from './lib/networkHarness.mjs'
import { Ranks } from '../src/core/extras/ranks.js'

const CODE = 'a-long-random-admin-code'

function fixture(env = { ADMIN_CODE: CODE }) {
  const writes = []
  const broadcasts = []
  const commands = []
  const network = makeNetwork(() => {}, { context: { process: { env } } })
  network.db = () => ({
    where: (_column, id) => ({
      update: async patch => writes.push({ id, ...patch }),
    }),
  })
  network.send = (name, data) => broadcasts.push([name, data])
  network.world.events = { emit: (name, payload) => commands.push([name, payload]) }
  let sockets = 0
  // a connected player: `user` is the user id (a socket's id is its user's), `address` its address key
  const connect = ({
    user = `user-${++sockets}`,
    rank = Ranks.VISITOR,
    address = '203.0.113.5',
    parents = [],
  } = {}) => {
    const data = { id: user, userId: user, rank }
    const socket = {
      id: user,
      addressKey: address,
      addressParents: parents,
      sent: [],
      closed: false,
      send: (name, payload) => socket.sent.push([name, payload]),
      disconnect: () => (socket.closed = true),
      player: {
        data,
        rankRevision: 0,
        rankWritesPending: 0,
        isAdmin: () => data.rank >= Ranks.ADMIN,
        modify: patch => Object.assign(data, patch),
      },
    }
    network.sockets.set(user, socket)
    return socket
  }
  const admin = (socket, ...args) => network.onCommand(socket, { args: ['admin', ...args] })
  const said = socket => socket.sent.filter(([name]) => name === 'chatAdded').map(([, line]) => line.body)
  return { network, writes, broadcasts, commands, connect, admin, said }
}

test('the right code makes a visitor admin, stored; entered again it takes admin away', async () => {
  const f = fixture()
  const socket = f.connect()
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.ADMIN)
  // (compared as JSON: the handler's objects come from the harness's own realm)
  assert.equal(JSON.stringify(f.broadcasts), JSON.stringify([['entityModified', { id: socket.id, rank: Ranks.ADMIN }]]))
  assert.deepEqual(f.writes, [{ id: socket.id, rank: Ranks.ADMIN }])
  assert.deepEqual(f.said(socket), ['Admin granted!'])
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.deepEqual(f.writes.at(-1), { id: socket.id, rank: Ranks.VISITOR })
  assert.deepEqual(f.said(socket), ['Admin granted!', 'Admin revoked!'])
})

test('a wrong, missing or malformed code changes nothing and is answered to that player only', async () => {
  const f = fixture()
  const socket = f.connect()
  for (const candidate of ['wrong', undefined, 7, { toString: () => CODE }, CODE + ' ']) {
    await f.admin(f.connect({ address: `203.0.113.${50 + f.writes.length}` }), candidate)
  }
  await f.admin(socket, 'wrong')
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.deepEqual(f.broadcasts, [], 'nothing is broadcast')
  assert.deepEqual(f.writes, [], 'nothing is stored')
  assert.deepEqual(f.said(socket), ['Wrong admin code.'])
  assert.equal(socket.closed, false)
})

test('the admin command is never handed on as a command event, in any letter case; other commands are', async () => {
  const f = fixture()
  const socket = f.connect()
  for (const cmd of ['admin', 'Admin', 'ADMIN', 'aDmIn']) {
    await f.network.onCommand(socket, { args: [cmd, CODE] })
  }
  assert.deepEqual(f.commands, [], 'the code never reaches a script')
  // and each of those spellings is the admin command: four right codes toggle admin four times
  assert.equal(f.writes.length, 4)
  await f.network.onCommand(socket, { args: ['dance', 'now'] })
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0][0], 'command')
  assert.deepEqual([...f.commands[0][1].args], ['dance', 'now'])
})

test('after three wrong codes the fourth starts a wait: the right code is refused during it, unread, and said once', async () => {
  const f = fixture()
  const socket = f.connect()
  for (let i = 0; i < 4; i++) await f.admin(socket, 'guess')
  await f.admin(socket, CODE)
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.VISITOR, 'not admin: the code was not looked at')
  assert.deepEqual(f.said(socket), [
    'Wrong admin code.',
    'Wrong admin code.',
    'Wrong admin code.',
    'Wrong admin code.',
    'Too many attempts. Try again later.',
  ])
  // the wait is the address's and the user's: another visitor from the same address waits too, one from elsewhere
  // does not
  const neighbour = f.connect()
  await f.admin(neighbour, CODE)
  assert.equal(neighbour.player.data.rank, Ranks.VISITOR)
  const elsewhere = f.connect({ address: '198.51.100.9' })
  await f.admin(elsewhere, CODE)
  assert.equal(elsewhere.player.data.rank, Ranks.ADMIN)
})

test('a socket that keeps trying is closed with a reason; a reconnect of the same user is still held by the wait', async () => {
  const f = fixture()
  const socket = f.connect({ user: 'mallory' })
  for (let i = 0; i < 20; i++) await f.admin(socket, 'guess')
  assert.equal(socket.closed, false)
  await f.admin(socket, 'guess')
  assert.equal(socket.closed, true)
  assert.deepEqual(socket.sent.at(-1), ['kick', 'admin_attempts'])
  const again = f.connect({ user: 'mallory', address: '198.51.100.77' })
  await f.admin(again, CODE)
  assert.equal(again.player.data.rank, Ranks.VISITOR, 'the user id is still waiting')
})

test('modes: without a code the command does nothing; clients are told there is a code unless the world is open', async () => {
  const snapshot = network => {
    Object.assign(network.world, {
      settings: { serialize: () => ({}) },
      collections: { serialize: () => [] },
      chat: { serialize: () => [] },
      ai: { serialize: () => ({}) },
      blueprints: { serialize: () => [] },
    })
    network.spawn = {}
    return network.snapshotState('id', { livekit: null, authToken: 't', entities: [] })
  }
  for (const [env, mode, hasAdminCode] of [
    [{ ADMIN_CODE: CODE }, 'code', true],
    [{}, 'open', false],
    [{ ADMIN_OPEN: 'true', NODE_ENV: 'production' }, 'open', false],
    [{ NODE_ENV: 'production' }, 'locked', true],
    [{ ADMIN_CODE: '', NODE_ENV: 'production' }, 'locked', true],
  ]) {
    const f = fixture(env)
    assert.equal(f.network.admin().mode, mode, JSON.stringify(env))
    assert.equal(snapshot(f.network).hasAdminCode, hasAdminCode, `${mode}: what a joining client is told`)
    if (mode === 'code') continue
    const socket = f.connect()
    for (const candidate of ['', undefined, 'anything', 'true']) await f.admin(socket, candidate)
    assert.equal(socket.player.data.rank, Ranks.VISITOR, `${mode}: no code grants admin`)
    assert.deepEqual(socket.sent, [], `${mode}: and nothing is said`)
    assert.deepEqual(f.commands, [])
  }
})

test('an address nobody could work out is not one shared key: visitors behind a hiding proxy do not hold each other', async () => {
  const f = fixture()
  for (let i = 0; i < 12; i++) await f.admin(f.connect({ address: 'unknown' }), 'guess')
  const admin = f.connect({ address: 'unknown' })
  await f.admin(admin, CODE)
  assert.equal(admin.player.data.rank, Ranks.ADMIN)
  // and a connection made without an address at all (a test harness, an internal caller)
  const bare = f.connect({ address: undefined })
  await f.admin(bare, CODE)
  assert.equal(bare.player.data.rank, Ranks.ADMIN)
})
