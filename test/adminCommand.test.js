// `/admin <code>` in the real ServerNetwork.onCommand (test/lib/network.mjs): who becomes admin, what a wrong
// code does, and what the world tells clients about its admin mode. The brake itself is in test/adminCode.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fakeWs, makeNetwork } from './lib/network.mjs'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { fixture as joinFixture, net, sentTo } from './lib/joinFixture.mjs'
import { deferred } from './lib/persistenceFixture.mjs'
import { Ranks } from '../src/core/extras/ranks.js'
import { packetNodeLimit } from '../src/core/extras/inboundPolicy.js'
import { readInboundPacket } from '../src/server/inboundDecode.js'
import { parseCommand, readCommandPacket } from '../src/core/extras/chatCommand.js'
import { CHAT_BODY_MAX_LENGTH } from '../src/core/extras/chatPolicy.js'

const CODE = 'a-long-random-admin-code'

function fixture(t, env = { ADMIN_CODE: CODE }) {
  const writes = []
  const rows = new Map()
  let hold = null
  const broadcasts = []
  const commands = []
  const network = makeNetwork(t, {
    net,
    log: () => {},
    env,
    world: { events: { emit: (name, payload) => commands.push([name, payload]) } },
    init: {
      db: () => ({
        where: (_column, id) => ({
          // a user row's UPDATE: in `writes` when it starts, in `rows` when it lands; `holdNext(promise)` makes the
          // next one wait for that promise before it lands
          update: async patch => {
            writes.push({ id, ...patch })
            const held = hold
            hold = null
            if (held) await held
            rows.set(id, { ...rows.get(id), ...patch })
          },
        }),
      }),
    },
  })
  network.send = (name, data) => broadcasts.push([name, data])
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
        isAdmin: () => data.rank >= Ranks.ADMIN,
        modify: patch => Object.assign(data, patch),
      },
    }
    network.sockets.set(user, socket)
    return socket
  }
  const admin = (socket, ...args) => network.onCommand(socket, { args: ['admin', ...args] })
  const said = socket => socket.sent.filter(([name]) => name === 'chatAdded').map(([, line]) => line.body)
  const holdNext = promise => (hold = promise)
  return { network, writes, rows, holdNext, broadcasts, commands, connect, admin, said }
}

test('the right code makes a visitor admin, stored; entered again it takes admin away', async t => {
  const f = fixture(t)
  const socket = f.connect()
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.ADMIN)
  // (compared as JSON, as when the handler's objects came from the old harness's own realm)
  assert.equal(JSON.stringify(f.broadcasts), JSON.stringify([['entityModified', { id: socket.id, rank: Ranks.ADMIN }]]))
  assert.deepEqual(f.writes, [{ id: socket.id, rank: Ranks.ADMIN }])
  assert.deepEqual(f.said(socket), ['Admin granted!'])
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.deepEqual(f.writes.at(-1), { id: socket.id, rank: Ranks.VISITOR })
  assert.deepEqual(f.said(socket), ['Admin granted!', 'Admin revoked!'])
})

test('a wrong, missing or malformed code changes nothing and is answered to that player only', async t => {
  const f = fixture(t)
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

test('the admin command is never handed on as a command event, in any letter case; other commands are', async t => {
  const f = fixture(t)
  const socket = f.connect()
  for (const cmd of ['admin', 'Admin', 'ADMIN', 'aDmIn']) {
    await f.network.onCommand(socket, { args: [cmd, CODE] })
  }
  assert.deepEqual(f.commands, [], 'the code never reaches a script')
  // and each of those spellings is the admin command: four right codes toggle admin four times, and the row is left
  // with the rank of the fourth
  assert.deepEqual(f.said(socket), ['Admin granted!', 'Admin revoked!', 'Admin granted!', 'Admin revoked!'])
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  await f.network.userRows().idle()
  assert.deepEqual(f.writes.at(-1), { id: socket.id, rank: Ranks.VISITOR })
  assert.deepEqual(f.rows.get(socket.id), { rank: Ranks.VISITOR })
  assert.equal(f.network.userRows().unstored(), 0)
  // Was 4 statements, exactly. A user's row has one writer (userRows.js): a rank decided while its statement is
  // under way goes out with the next statement, and one replaced before its turn is not written; how many toggles
  // meet a statement under way depends on how fast the database answers (these immediate mocks give 3; under the old
  // harness each `await` of a handler's promise from the vm's realm took turns enough for every statement to land
  // first). What holds whatever the database: at least 2 statements, the first toggle's (the writer starts with it at
  // once) and the fourth's (nothing decided is left unwritten, above), and at most one per toggle. A writer that wrote
  // every toggle at once, without merging, is within these bounds too: that is allowed here (the next test holds a
  // statement to show the merging).
  assert.ok(f.writes.length >= 2 && f.writes.length <= 4, `${f.writes.length} statements`)
  await f.network.onCommand(socket, { args: ['dance', 'now'] })
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0][0], 'command')
  assert.deepEqual([...f.commands[0][1].args], ['dance', 'now'])
  // the shape a client script gets from Chat.command: the server's event used to carry `args` alone
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands[0][1])), {
    playerId: socket.player.data.id,
    cmd: 'dance',
    value: 'now',
    args: ['dance', 'now'],
  })
})

test('/admin: toggles decided while a statement of the row is held go out as one more statement, the rank of the last', async t => {
  const f = fixture(t)
  const socket = f.connect()
  const release = deferred()
  f.holdNext(release.promise)
  await f.admin(socket, CODE)
  // (under way is not stored: the change counts as unwritten until its statement has come back)
  assert.equal(f.network.userRows().unstored(), 1)
  // decided while that statement (admin) is under way: visitor, admin, visitor
  for (let i = 0; i < 3; i++) await f.admin(socket, CODE)
  assert.deepEqual(f.writes, [{ id: socket.id, rank: Ranks.ADMIN }])
  assert.equal(f.rows.get(socket.id), undefined, 'nothing has landed')
  // released, with no further toggle: the rank decided last is written, by one more statement; the two between never
  release.resolve()
  await f.network.userRows().idle()
  assert.deepEqual(f.writes, [
    { id: socket.id, rank: Ranks.ADMIN },
    { id: socket.id, rank: Ranks.VISITOR },
  ])
  assert.deepEqual(f.rows.get(socket.id), { rank: Ranks.VISITOR })
  assert.equal(socket.player.data.rank, Ranks.VISITOR)
  assert.equal(f.network.userRows().unstored(), 0)
  assert.deepEqual(f.said(socket), ['Admin granted!', 'Admin revoked!', 'Admin granted!', 'Admin revoked!'])
})

test('a command packet is a list of words: anything else is not handed to scripts', async t => {
  const f = fixture(t)
  const socket = f.connect()
  // a client is free to put anything in the list; scripts were handed it
  for (const args of [
    ['dance', 7],
    ['dance', { toString: 'x' }],
    ['dance', ['nested']],
    [null],
    ['dance', undefined],
    // more than a chat line can hold
    ['say', 'x'.repeat(CHAT_BODY_MAX_LENGTH)],
    Array.from({ length: CHAT_BODY_MAX_LENGTH }, () => 'a'),
  ]) {
    await f.network.onCommand(socket, { args })
  }
  assert.deepEqual(f.commands, [])
  // the longest line a client can type is still one
  const longest = ['say', 'x'.repeat(CHAT_BODY_MAX_LENGTH - 5)]
  await f.network.onCommand(socket, { args: longest })
  assert.equal(f.commands.length, 1)
  // a non-string code is not an attempt at the admin code either
  const before = f.writes.length
  await f.network.onCommand(socket, { args: ['admin', { code: CODE }] })
  assert.equal(f.writes.length, before)
  assert.equal(f.commands.length, 1)
})

test('command packets: cmd and value are the client’s when they are the text of the words, and made from them otherwise', () => {
  const read = data => readCommandPacket(data)
  // what Chat.command sends for "/dance  now  please": untrimmed text, trimmed words
  assert.deepEqual(read({ cmd: 'dance', value: ' now  please', args: ['dance', 'now', 'please'] }), {
    cmd: 'dance',
    value: ' now  please',
    args: ['dance', 'now', 'please'],
  })
  for (const { cmd, value, args } of [
    parseCommand('/dance now'),
    parseCommand('/x'),
    parseCommand('/'),
    parseCommand('/a  b '),
  ]) {
    assert.deepEqual(read({ cmd, value, args }), { cmd, value, args }, JSON.stringify(args))
  }
  // parts that disagree with the words, or are missing, are made from the words
  assert.deepEqual(read({ cmd: 'kick', value: 'everyone', args: ['dance', 'now'] }), {
    cmd: 'dance',
    value: 'now',
    args: ['dance', 'now'],
  })
  assert.deepEqual(read({ args: ['dance', 'now', 'please'] }), {
    cmd: 'dance',
    value: 'now please',
    args: ['dance', 'now', 'please'],
  })
  assert.deepEqual(read({ cmd: 7, value: {}, args: ['dance'] }), { cmd: 'dance', value: '', args: ['dance'] })
  assert.deepEqual(read({ args: [] }), { cmd: '', value: '', args: [] })
  assert.deepEqual(read({ cmd: 'x'.repeat(CHAT_BODY_MAX_LENGTH), value: '', args: ['dance'] }), {
    cmd: 'dance',
    value: '',
    args: ['dance'],
  })
  // text that pads the same words out past a chat line's length is not taken either
  assert.deepEqual(read({ cmd: 'dance', value: `now${' '.repeat(CHAT_BODY_MAX_LENGTH)}`, args: ['dance', 'now'] }), {
    cmd: 'dance',
    value: 'now',
    args: ['dance', 'now'],
  })
  // not a command
  for (const data of [
    null,
    undefined,
    {},
    { args: 'dance' },
    { args: [1] },
    { args: ['a', null] },
    { args: { 0: 'a', length: 1 } },
  ]) {
    assert.equal(read(data), null, JSON.stringify(data))
  }
})

test('the third wrong code starts a wait: the right code is refused during it, unread, and said once', async t => {
  const f = fixture(t)
  const socket = f.connect()
  for (let i = 0; i < 3; i++) await f.admin(socket, 'guess')
  await f.admin(socket, CODE)
  await f.admin(socket, CODE)
  assert.equal(socket.player.data.rank, Ranks.VISITOR, 'not admin: the code was not looked at')
  assert.deepEqual(f.said(socket), [
    'Wrong admin code.',
    'Wrong admin code.',
    'Wrong admin code.',
    'Too many attempts. Try again later.',
  ])
  // the wait is the address's and the user's: another visitor from the same address waits too (and is told so on
  // its own line), one from elsewhere does not
  const neighbour = f.connect()
  await f.admin(neighbour, CODE)
  await f.admin(neighbour, CODE)
  assert.equal(neighbour.player.data.rank, Ranks.VISITOR)
  assert.deepEqual(f.said(neighbour), ['Too many attempts. Try again later.'])
  const elsewhere = f.connect({ address: '198.51.100.9' })
  await f.admin(elsewhere, CODE)
  assert.equal(elsewhere.player.data.rank, Ranks.ADMIN)
})

test('a line is the admin command on the client exactly when it is on the server: then no side hands it to scripts', async t => {
  // the real Chat.command on a client, its packet as the server decodes it, and the real onCommand
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const lines = [
    ['/admin CODE', true],
    ['/Admin CODE', true],
    ['/ADMIN CODE', true],
    ['/ Admin CODE', true],
    ['/   admin CODE', true],
    ['/\tAdmin CODE', true],
    ['/Admin\t CODE', true],
    ['/\u00a0admin CODE', true],
    ['/admin\u3000 CODE', true],
    ['/Admin', true],
    ['/admin\tCODE', false],
    ['/admin\u00a0CODE', false],
    ['/administrator CODE', false],
    ['/\u200badmin CODE', false],
    ['/say admin CODE', false],
    ['/name admin', false],
    ['/dance', false],
  ]
  for (const [text, expected] of lines) {
    const line = text.replace('CODE', CODE)
    const world = clientWorld()
    const clientEvents = []
    world.events = { emit: (...args) => clientEvents.push(args) }
    new Chat(world).command(line)
    assert.equal(world.packets.length, 1, `${JSON.stringify(text)}: sent to the server`)
    const [method, data] = readInboundPacket(world.packets[0], { maxNodes: packetNodeLimit('command') })
    assert.equal(method, 'onCommand')
    const f = fixture(t)
    const gate = f.network.admin().gate
    const looked = []
    const attempt = gate.attempt
    gate.attempt = (who, candidate) => (looked.push(candidate), attempt(who, candidate))
    await f.network.onCommand(f.connect(), data)
    const name = JSON.stringify(text)
    assert.equal(looked.length > 0, expected, `${name}: the server takes it for the admin command`)
    if (looked.length) {
      assert.deepEqual(clientEvents, [], `${name}: no command event on the client`)
      assert.deepEqual(f.commands, [], `${name}: none on the server`)
    } else {
      assert.equal(clientEvents.length, 1, `${name}: a command event on the client`)
      assert.equal(f.commands.length, 1, `${name}: and on the server`)
    }
  }
  // a client of someone's own making may send the first word untrimmed: it is the admin command all the same
  for (const first of [' admin', 'ADMIN\t', '\u00a0Admin\u00a0']) {
    const f = fixture(t)
    const socket = f.connect()
    await f.network.onCommand(socket, { args: [first, CODE] })
    assert.equal(socket.player.data.rank, Ranks.ADMIN, JSON.stringify(first))
    assert.deepEqual(f.commands, [])
  }
  // a first word that is not text: not the admin command on the server either, and not a command at all (a list
  // with something in it that is not a word is handed to no script). No words at all is a command with none.
  for (const args of [[7, CODE], [['admin'], CODE], [{ toString: () => 'admin' }, CODE], [null, CODE], []]) {
    const f = fixture(t)
    const socket = f.connect()
    await f.network.onCommand(socket, { args })
    assert.equal(socket.player.data.rank, Ranks.VISITOR)
    assert.deepEqual(socket.sent, [])
    assert.equal(f.commands.length, args.length ? 0 : 1, JSON.stringify(args))
  }
})

test('the admin command is not handed to a command bound on the client under that name either', () => {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const world = clientWorld()
  // (no command event: recorded and asserted after, as a throw in the chat's handling could be caught there)
  const emitted = []
  world.events = { emit: (...args) => emitted.push(args) }
  const chat = new Chat(world)
  const called = []
  for (const name of ['admin', 'Admin', ' Admin']) chat.bindCommand(name, action => called.push(action))
  for (const line of ['/admin CODE', '/Admin CODE', '/ Admin CODE']) chat.command(line)
  assert.deepEqual(emitted, [], 'no command event')
  assert.deepEqual(called, [])
  assert.equal(world.packets.length, 3, 'each went to the server')
})

test('connections get their address keys on joining: two from one address share its wait, one from another does not', async t => {
  // the real onConnection, given the address keys the /ws route hands it
  const f = joinFixture(t, { env: { ADMIN_CODE: CODE } })
  const connect = async origin => {
    const ws = fakeWs()
    await f.network.onConnection(ws, {}, origin)
    ws.drain()
    const socket = [...f.network.sockets.values()].find(socket => socket.ws === ws)
    assert.ok(socket, 'joined')
    return socket
  }
  const said = socket =>
    sentTo(socket)
      .filter(([method]) => method === 'onChatAdded')
      .map(([, line]) => line.body)
  const guess = (socket, candidate = 'guess') => f.network.onCommand(socket, { args: ['admin', candidate] })
  const here = { key: '203.0.113.20', parents: [] }
  const first = await connect(here)
  for (let i = 0; i < 3; i++) await guess(first)
  assert.deepEqual(said(first), Array(3).fill('Wrong admin code.'))
  // another user on the same address: held by the address's wait
  const second = await connect(here)
  await guess(second, CODE)
  assert.deepEqual(said(second), ['Too many attempts. Try again later.'])
  assert.equal(second.player.data.rank, Ranks.VISITOR)
  // another address is not
  const elsewhere = await connect({ key: '198.51.100.20', parents: [] })
  await guess(elsewhere)
  assert.deepEqual(said(elsewhere), ['Wrong admin code.'])

  // the wider networks: 32 wrong codes from as many /64s of one /48 hold a 33rd /64 in it, not one outside it
  const parents = ['2001:db8:7::/56', '2001:db8:7::/48']
  for (let i = 0; i < 32; i++) await guess(await connect({ key: `2001:db8:7:${i.toString(16)}::/64`, parents }))
  const inside = await connect({ key: '2001:db8:7:ff::/64', parents })
  await guess(inside)
  assert.deepEqual(said(inside), ['Too many attempts. Try again later.'])
  const outside = await connect({ key: '2001:db8:8::/64', parents: ['2001:db8:8::/56', '2001:db8:8::/48'] })
  await guess(outside)
  assert.deepEqual(said(outside), ['Wrong admin code.'])
})

test('a socket that keeps trying is closed with a reason; a reconnect of the same user is still held by the wait', async t => {
  const f = fixture(t)
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

test('modes: without a code the command does nothing; clients are told there is a code unless the world is open', async t => {
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
    const f = fixture(t, env)
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

test('an address nobody could work out is not one shared key: visitors behind a hiding proxy do not hold each other', async t => {
  const f = fixture(t)
  for (let i = 0; i < 12; i++) await f.admin(f.connect({ address: 'unknown' }), 'guess')
  const admin = f.connect({ address: 'unknown' })
  await f.admin(admin, CODE)
  assert.equal(admin.player.data.rank, Ranks.ADMIN)
  // and a connection made without an address at all (a test harness, an internal caller)
  const bare = f.connect({ address: undefined })
  await f.admin(bare, CODE)
  assert.equal(bare.player.data.rank, Ranks.ADMIN)
})

test('Chat.command: a word every object has is not a bound command', () => {
  const sent = []
  const emitted = []
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const chat = new Chat({
    network: { isServer: false, id: 'me', send: (name, data) => sent.push([name, data]) },
    events: { emit: (name, data) => emitted.push([name, data]) },
  })
  for (const word of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) chat.command(`/${word} x`)
  assert.equal(sent.length, 4, 'each goes to the server as any unbound command does')
  assert.equal(emitted.length, 4)
})
