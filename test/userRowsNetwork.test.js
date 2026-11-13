// A user's row and the server's memory of it (src/server/userRows.js), through the real ServerNetwork handlers and
// the real join (test/lib/network.mjs): what a join gets when the row it read is older than a change, in
// which order a user's writes reach the database, and what a write that fails leaves. The rules on their own are
// in test/userRows.test.js; what a decided rank does to a token grant is in test/serverWallet.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeWs, loadNetwork, makeNetwork } from './lib/network.mjs'
import { readPacket } from '../src/core/packets.js'
import { Ranks } from '../src/core/extras/ranks.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

// (the old harness's network saved nothing on a timer; a session token here is the id of its user)
const SESSION = 'src/core/utils-server.js'
const net = await loadNetwork({ env: { SAVE_INTERVAL: 0 }, standIns: [SESSION] })

// `users` is the table. A read returns a copy of the row as it is when the read is issued and may be held
// (`f.read`); an update is recorded when it starts (`statements`), may be held or fail (`f.write`), and changes the
// row when it lands. The voice token (the join's last wait) may be held too (`f.voice`).
function fixture(t) {
  const f = { logs: [], users: new Map(), entities: new Map(), statements: [], read: null, write: null, voice: null }
  const db = table => {
    assert.equal(table, 'users')
    return {
      where: (column, id) => ({
        first: async () => {
          const row = f.users.has(id) ? { ...f.users.get(id) } : undefined
          await f.read?.(id)
          return row
        },
        update: async patch => {
          const statement = { id, patch: { ...patch } }
          f.statements.push(statement)
          await f.write?.(statement)
          Object.assign(f.users.get(id), patch)
        },
      }),
    }
  }
  // (a write that fails is a plain line of the server's log: console.error)
  const network = makeNetwork(t, {
    net,
    log: line => f.logs.push(line),
    env: { ADMIN_CODE: 'code' },
    init: { db },
    modules: { [SESSION]: { readJWT: async userId => ({ userId }), expiredSessionUser: async () => null } },
  })
  f.network = network
  network.spawn = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
  Object.assign(network.world, {
    settings: { serialize: () => ({}), effectiveRank: 0, customAvatars: true },
    livekit: {
      serialize: async () => {
        await f.voice?.()
        return {}
      },
      clearModifiers() {},
    },
    collections: { serialize: () => [] },
    chat: { serialize: () => [] },
    ai: { serialize: () => ({}) },
    blueprints: { serialize: () => [] },
    events: { emit() {} },
    entities: {
      items: f.entities,
      add(data) {
        const player = {
          data,
          isPlayer: true,
          modify: patch => Object.assign(data, patch),
          isAdmin: () => data.rank >= Ranks.ADMIN,
          isBuilder: () => data.rank >= Ranks.BUILDER,
          destroy: () => f.entities.delete(data.id),
        }
        f.entities.set(data.id, player)
        return player
      },
      get: id => f.entities.get(id),
      serialize: () => [...f.entities.values()].map(player => ({ ...player.data })),
    },
  })
  // a join of user `id`, not waited for, with the query parameters of its WebSocket URL: -> { ws, done }
  f.join = (id, params = {}) => {
    const ws = fakeWs()
    return { ws, done: network.onConnection(ws, { authToken: id, ...params }) }
  }
  f.connect = async (id, rank = Ranks.VISITOR) => {
    if (!f.users.has(id)) f.users.set(id, { id, name: id, avatar: null, rank })
    const { ws, done } = f.join(id)
    await done
    assert.equal(ws.terminations, 0, 'the join was taken')
    return network.sockets.get(id)
  }
  f.rank = (admin, id, rank) => network.onModifyRank(admin, { playerId: id, rank })
  f.rows = () => network.userRows()
  f.patches = () => f.statements.map(statement => statement.patch)
  return f
}

// The plain reload: the old connection is still here when the new one reads the row, and is gone before the read
// answers. The row the join gets is the one from before the change.
async function reloadDuring(f, change, params) {
  const read = deferred()
  const reading = deferred()
  f.read = () => {
    reading.resolve()
    return read.promise
  }
  const { ws, done } = f.join('u', params)
  await reading.promise
  f.read = null
  const old = f.network.sockets.get('u')
  await change(old)
  old.ws.terminate()
  assert.equal(f.network.sockets.has('u'), false, 'the old connection is gone')
  read.resolve()
  await done
  const next = f.network.sockets.get('u')
  assert.ok(next && next !== old)
  assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
  return { next, ws }
}

test('join: a rank taken while the row was being read is the rank of the new session, write pending, landed or failed', async t => {
  for (const fate of ['pending', 'landed', 'failed']) {
    const f = fixture(t)
    await f.connect('u', Ranks.ADMIN)
    const admin = await f.connect('admin', Ranks.ADMIN)
    const write = deferred()
    const { next, ws } = await reloadDuring(f, async () => {
      if (fate === 'pending') f.write = () => write.promise
      if (fate === 'failed') {
        f.write = async () => {
          throw new Error('SQLITE_BUSY')
        }
      }
      await f.rank(admin, 'u', Ranks.VISITOR)
      await turn()
      assert.equal(f.users.get('u').rank, fate === 'landed' ? Ranks.VISITOR : Ranks.ADMIN, fate)
      if (fate === 'landed') {
        assert.deepEqual(f.rows().intended('u'), { rank: Ranks.VISITOR }, 'kept while the user is joining')
      }
    })
    assert.equal(next.player.data.rank, Ranks.VISITOR, `${fate}: not the rank of the row that was read`)
    // what the snapshot told the joiner about itself
    const [, snapshot] = readPacket(ws.packets[0])
    assert.equal(snapshot.entities.find(entity => entity.id === 'u').rank, Ranks.VISITOR, fate)
    if (fate === 'landed') assert.equal(f.rows().size, 0, 'the join is over: nothing is kept')
    if (fate === 'pending') {
      assert.equal(f.rows().size, 1)
      write.resolve()
      await f.rows().idle()
      assert.equal(f.rows().size, 0)
      assert.equal(f.users.get('u').rank, Ranks.VISITOR)
    }
    if (fate === 'failed') {
      // the database still says admin; for as long as the server runs, a join gets what was decided
      assert.equal(f.users.get('u').rank, Ranks.ADMIN)
      assert.deepEqual(f.rows().intended('u'), { rank: Ranks.VISITOR })
      next.ws.terminate()
      const again = await f.connect('u')
      assert.equal(again.player.data.rank, Ranks.VISITOR, 'a later join too')
      assert.equal(f.logs.filter(line => line.includes('not stored')).length, 1)
    }
  }
})

test('join: a name and an avatar set while the row was being read are those of the new session', async t => {
  for (const fate of ['pending', 'landed', 'failed']) {
    const f = fixture(t)
    await f.connect('u')
    const write = deferred()
    const { next } = await reloadDuring(f, async old => {
      if (fate === 'pending') f.write = () => write.promise
      if (fate === 'failed') {
        f.write = async () => {
          throw new Error('SQLITE_BUSY')
        }
      }
      await f.network.onCommand(old, { args: ['name', 'Ada'] })
      await f.network.onEntityModified(old, { id: 'u', avatar: 'asset://ada.vrm' })
      await turn()
    })
    assert.equal(next.player.data.name, 'Ada', fate)
    assert.equal(next.player.data.avatar, 'asset://ada.vrm', fate)
    write.resolve()
    await f.rows().idle()
    if (fate === 'failed') assert.deepEqual(f.users.get('u'), { id: 'u', name: 'u', avatar: null, rank: 0 })
    else assert.deepEqual(f.users.get('u'), { id: 'u', name: 'Ada', avatar: 'asset://ada.vrm', rank: 0 })
  }
})

// The `name` query parameter of the WebSocket URL (ClientNetwork.init adds it when it is given a name; the browser
// client of this repository gives none). sanitizeName keeps a string with at least one visible character, cut to
// 64 characters, and the join prefers it to the name of the row, which the decided values go over first. It is
// not written to the row.
test('join: a name the connection brings is the name of the new session, over a name decided while the row was read', async t => {
  for (const brought of ['Old', ' ​ ', undefined]) {
    const f = fixture(t)
    await f.connect('u')
    const { next, ws } = await reloadDuring(
      f,
      async old => {
        await f.network.onCommand(old, { args: ['name', 'New'] })
        await turn()
        assert.equal(f.users.get('u').name, 'New', 'the write has landed')
        assert.deepEqual(f.rows().intended('u'), { name: 'New' }, 'kept while the user is joining')
      },
      brought === undefined ? {} : { name: brought }
    )
    // a name of visible characters is the session's; one of white space and invisible characters is no name
    const expected = brought === 'Old' ? 'Old' : 'New'
    assert.equal(next.player.data.name, expected, JSON.stringify(brought))
    const [, snapshot] = readPacket(ws.packets[0])
    assert.equal(snapshot.entities.find(entity => entity.id === 'u').name, expected, JSON.stringify(brought))
    // the row keeps the decided name: the join writes nothing
    assert.deepEqual(f.patches(), [{ name: 'New' }])
    assert.equal(f.users.get('u').name, 'New')
    assert.equal(f.rows().size, 0)
    // a later join that brings no name gets it from the row
    next.ws.terminate()
    const again = await f.connect('u')
    assert.equal(again.player.data.name, 'New')
  }
})

test('join: a rank changed while the old connection is asked, or while it is closed, is the rank of the replacement', async t => {
  for (const when of ['asked', 'closing']) {
    const f = fixture(t)
    f.network.takeoverPingMs = 30
    f.network.takeoverCloseMs = 1000
    const old = await f.connect('u', Ranks.ADMIN)
    const admin = await f.connect('admin', Ranks.ADMIN)
    // its transport reports the close only a moment after it is terminated
    const terminate = old.ws.terminate
    let closing = null
    old.ws.terminate = () => {
      closing = deferred()
      setTimeout(() => {
        terminate()
        closing.resolve()
      }, 40)
    }
    const { ws, done } = f.join('u')
    await turn()
    if (when === 'asked') {
      assert.ok(old.probing, 'the old connection is being asked')
    } else {
      while (!closing) await new Promise(resolve => setTimeout(resolve, 2))
      assert.equal(f.network.sockets.get('u'), old, 'still registered while it closes')
    }
    // the row was read before the ping; the change lands at once (as on SQLite) and nothing reads the row again
    await f.rank(admin, 'u', Ranks.VISITOR)
    await f.rows().idle()
    assert.equal(f.users.get('u').rank, Ranks.VISITOR)
    assert.equal(old.player.data.rank, Ranks.VISITOR)
    await done
    const next = f.network.sockets.get('u')
    assert.ok(next && next !== old)
    assert.equal(readPacket(ws.packets[0])[0], 'onSnapshot')
    assert.equal(next.player.data.rank, Ranks.VISITOR, when)
    assert.equal(f.rows().size, 0, 'nothing is kept once the join is over')
    assert.equal(f.statements.length, 1)
  }
})

test('join: a change after the last wait finds the new player, and a later join reads it from the row', async t => {
  const f = fixture(t)
  await f.connect('u')
  const admin = await f.connect('admin', Ranks.ADMIN)
  f.network.sockets.get('u').ws.terminate()
  const voice = deferred()
  const waiting = deferred()
  f.voice = () => {
    waiting.resolve()
    return voice.promise
  }
  const { done } = f.join('u')
  await waiting.promise
  f.voice = null
  // between the old player's leaving and the new one's add there is no player to rank: the change is not made
  await f.rank(admin, 'u', Ranks.BUILDER)
  assert.equal(f.statements.length, 0)
  voice.resolve()
  await done
  const next = f.network.sockets.get('u')
  assert.equal(next.player.data.rank, Ranks.VISITOR)
  await f.rank(admin, 'u', Ranks.BUILDER)
  assert.equal(next.player.data.rank, Ranks.BUILDER)
  await f.rows().idle()
  assert.deepEqual(f.patches(), [{ rank: Ranks.BUILDER }])
  assert.equal(f.rows().size, 0)
  next.ws.terminate()
  const again = await f.connect('u')
  assert.equal(again.player.data.rank, Ranks.BUILDER)
})

test('join: a join that ends without a player gives the kept entry back', async t => {
  const f = fixture(t)
  await f.connect('u', Ranks.ADMIN)
  const admin = await f.connect('admin', Ranks.ADMIN)
  const read = deferred()
  const reading = deferred()
  f.read = () => {
    reading.resolve()
    return read.promise
  }
  const { ws, done } = f.join('u')
  await reading.promise
  f.read = null
  await f.rank(admin, 'u', Ranks.BUILDER)
  await f.rows().idle()
  assert.equal(f.rows().size, 1, 'stored, kept for the join')
  // the newcomer closes while its read is under way
  ws.terminate()
  assert.equal(f.rows().size, 0)
  read.resolve()
  await done
  assert.equal(f.network.joining.size, 0)
})

test('writes of one user reach the database one at a time, in the order decided: the row ends on the last', async t => {
  const f = fixture(t)
  await f.connect('u')
  const admin = await f.connect('admin', Ranks.ADMIN)
  // a pool of several connections: given two statements of a user at once, it would land the later one first
  const open = []
  f.write = statement => {
    const held = deferred()
    open.push({ statement, held })
    return held.promise
  }
  for (const rank of [Ranks.ADMIN, Ranks.BUILDER, Ranks.VISITOR]) await f.rank(admin, 'u', rank)
  await f.network.onCommand(f.network.sockets.get('u'), { args: ['name', 'Ada'] })
  assert.equal(open.length, 1, 'one statement of the user under way')
  assert.equal(f.network.sockets.get('u').player.data.rank, Ranks.VISITOR)
  while (open.length) {
    assert.equal(open.length, 1)
    open.pop().held.resolve()
    await turn()
  }
  assert.deepEqual(f.patches(), [{ rank: Ranks.ADMIN }, { rank: Ranks.VISITOR, name: 'Ada' }])
  assert.deepEqual(f.users.get('u'), { id: 'u', name: 'Ada', avatar: null, rank: Ranks.VISITOR })
  assert.equal(f.rows().size, 0)
})

test('the handlers do not wait for the write: a held statement holds up neither the handler nor the next packet', async t => {
  const f = fixture(t)
  const socket = await f.connect('u')
  const admin = await f.connect('admin', Ranks.ADMIN)
  const never = new Promise(() => {})
  f.write = () => never
  const settled = async promise => {
    let done = false
    promise.then(() => (done = true))
    await turn()
    return done
  }
  assert.equal(await settled(f.network.onCommand(socket, { args: ['name', 'Ada'] })), true)
  assert.equal(await settled(f.network.onEntityModified(socket, { id: 'u', avatar: 'asset://ada.vrm' })), true)
  assert.equal(await settled(f.rank(admin, 'u', Ranks.BUILDER)), true)
  assert.equal(await settled(f.network.onCommand(admin, { args: ['admin', 'code'] })), true)
  assert.deepEqual(
    f.statements.map(statement => [statement.id, statement.patch]),
    [
      ['u', { name: 'Ada' }],
      ['admin', { rank: Ranks.VISITOR }],
    ]
  )
  assert.deepEqual(f.rows().intended('u'), { name: 'Ada', avatar: 'asset://ada.vrm', rank: Ranks.BUILDER })
  assert.equal(socket.player.data.rank, Ranks.BUILDER)
})

test('each change of a row goes through the same writer: /name, the own-player change, a rank, the admin code', async t => {
  const f = fixture(t)
  const socket = await f.connect('u')
  const admin = await f.connect('admin', Ranks.ADMIN)
  const fail = async () => {
    throw new Error('SQLITE_BUSY')
  }
  // each one fails on its own; the next carries what the ones before left
  f.write = fail
  await f.network.onCommand(socket, { args: ['name', 'Ada'] })
  await f.rows().idle()
  await f.network.onEntityModified(socket, { id: 'u', name: 'Bea', avatar: 'asset://bea.vrm' })
  await f.rows().idle()
  await f.rank(admin, 'u', Ranks.BUILDER)
  await f.rows().idle()
  assert.deepEqual(f.rows().intended('u'), { name: 'Bea', avatar: 'asset://bea.vrm', rank: Ranks.BUILDER })
  assert.deepEqual(f.users.get('u'), { id: 'u', name: 'u', avatar: null, rank: 0 })
  assert.deepEqual(
    f.logs.filter(line => line.includes('not stored')),
    [
      '[network] name of user "u" not stored (kept in memory; written again with that user\'s next change or at the final save): SQLITE_BUSY',
    ],
    'one line for the run of failures of that user'
  )
  f.write = null
  await f.network.onCommand(socket, { args: ['name', 'Cyd'] })
  await f.rows().idle()
  assert.deepEqual(f.patches().at(-1), { name: 'Cyd', avatar: 'asset://bea.vrm', rank: Ranks.BUILDER })
  assert.deepEqual(f.users.get('u'), { id: 'u', name: 'Cyd', avatar: 'asset://bea.vrm', rank: Ranks.BUILDER })
  assert.equal(f.rows().size, 0)
  // the admin code: another user's row, and a failure of its own
  f.write = fail
  await f.network.onCommand(admin, { args: ['admin', 'code'] })
  await f.rows().idle()
  assert.deepEqual(f.rows().intended('admin'), { rank: Ranks.VISITOR })
  assert.equal(f.logs.filter(line => line.includes('rank of user "admin" not stored')).length, 1)
})

test('a column the database refuses does not keep a rank from being stored', async t => {
  const f = fixture(t)
  const socket = await f.connect('u')
  const admin = await f.connect('admin', Ranks.ADMIN)
  // a column narrower than the avatar the server takes (as PostgreSQL's varchar(255) was for a 512-character url)
  f.write = async statement => {
    if (statement.patch.avatar?.length > 16) {
      throw Object.assign(new Error('value too long for type character varying(16)'), { code: '22001' })
    }
  }
  const avatar = 'asset://' + 'a'.repeat(60) + '.vrm'
  await f.network.onEntityModified(socket, { id: 'u', avatar })
  await f.rows().idle()
  assert.equal(socket.player.data.avatar, avatar)
  assert.equal(f.users.get('u').avatar, null)
  await f.rank(admin, 'u', Ranks.BUILDER)
  await f.rows().idle()
  assert.equal(f.users.get('u').rank, Ranks.BUILDER, 'the rank is stored')
  assert.deepEqual(f.patches(), [{ avatar }, { avatar, rank: Ranks.BUILDER }, { avatar }, { rank: Ranks.BUILDER }])
  assert.equal(f.rows().unstored(), 1, 'the avatar is not, and is not repaired by the later write')
  assert.equal(f.logs.filter(line => line.includes('not stored')).length, 1)
  // a reload still shows the avatar the session had, from memory
  socket.ws.terminate()
  const again = await f.connect('u')
  assert.equal(again.player.data.avatar, avatar)
  assert.equal(again.player.data.rank, Ranks.BUILDER)
})
