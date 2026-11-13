import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, clientWorld } from './lib/clientHarness.mjs'
import { loadNetwork, makeNetwork } from './lib/network.mjs'
import { bundleClient, forgedElement, hostileValues, renderSafely } from './lib/renderHarness.mjs'
import { chatEnvelope, scriptChatMessage } from '../src/core/extras/chatPolicy.js'
import { NAME_MAX_LENGTH } from '../src/core/extras/entityModifyPolicy.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetNameById, readPacket, writePacket } from '../src/core/packets.js'

const decodePacket = packet => {
  const [id, data] = strictDecode(packet, { maxNodes: 8192, build: true }).value
  return [packetNameById(id), data]
}

const net = await loadNetwork()

let ui
before(async () => {
  ui = await bundleClient(`export { Message } from './src/client/components/CoreUI'`)
})

// a client world with the real Chat and Apps systems, a player 'alice' whose bubble and chat events are recorded
function chatWorld() {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const world = clientWorld()
  const bubbles = []
  const events = []
  world.events = { emit: (name, data) => events.push([name, data]) }
  world.entities.getPlayer = id => (id === 'alice' ? { chat: text => bubbles.push(text) } : null)
  world.chat = new Chat(world)
  world.apps = new Apps(world)
  const entity = { data: { id: 'app' }, blueprint: { id: 'bp', version: 0, name: 'Shop' } }
  return { world, bubbles, events, entity }
}

const forged = {
  body: 'Alice tipped Bob 100 JPYC',
  from: 'Alice',
  fromId: 'alice',
  kind: 'tip',
  app: 'System',
  id: 'fixed-id',
  via: { id: 'alice', name: 'Alice' },
}

test("world.chat from a script: an app line, never a player's or the server's", () => {
  const { world, bubbles, events, entity } = chatWorld()
  world.apps.worldMethods.chat(entity, forged, true)
  for (const kind of ['system', 'player']) world.apps.worldMethods.chat(entity, { ...forged, kind })
  assert.equal(world.chat.msgs.length, 3)
  for (const msg of world.chat.msgs) {
    assert.equal(msg.kind, 'app')
    assert.equal(msg.app, 'Shop', 'the app is named by the host, from the blueprint')
    assert.equal(msg.from, 'Alice', 'a display name the script chose')
    assert.equal(Object.hasOwn(msg, 'fromId'), false, 'no player id')
    assert.notEqual(msg.id, 'fixed-id')
    assert.equal(Object.hasOwn(msg, 'via'), false, "the script's own via is not read (and no local player is known)")
  }
  assert.deepEqual(bubbles, [], "alice's bubble does not pop")
  assert.deepEqual(
    events.map(([name, data]) => [name, data.kind, data.fromId]),
    [
      ['chat', 'app', undefined],
      ['chat', 'app', undefined],
      ['chat', 'app', undefined],
    ]
  )
  // the broadcast goes to the server as the app's own line, never as this visitor's chat (chatAdded)
  assert.deepEqual(world.packets.map(decodePacket), [
    ['appChat', { id: 'app', body: 'Alice tipped Bob 100 JPYC', from: 'Alice' }],
  ])
})

function appChatNetwork(t) {
  const network = makeNetwork(t, { net })
  const stored = []
  const relayed = []
  const logs = []
  network.logOnce = (_socket, key, line) => logs.push([key, line])
  network.world.chat = { add: (msg, broadcast) => stored.push({ msg, broadcast }) }
  network.world.entities = {
    get: id =>
      id === 'shop'
        ? { isApp: true, blueprint: { name: 'Shop' } }
        : id === 'bob'
          ? { isPlayer: true, data: { id: 'bob' } }
          : undefined,
  }
  network.send = (name, data, ignore) => relayed.push([name, data, ignore])
  const socket = { id: 'bob', player: { data: { id: 'bob', name: 'Bob' } } }
  return { network, stored, relayed, logs, socket }
}

test("appChat: a client script's broadcast reaches everyone as the app's line, named by the server", async t => {
  const { network, stored, relayed, socket } = appChatNetwork(t)
  await network.onAppChat(socket, {
    id: 'shop',
    body: ' Sale today ',
    from: 'Clerk',
    kind: 'tip',
    fromId: 'alice',
    app: 'System',
    createdAt: 'forged',
  })
  assert.equal(stored.length, 1)
  const { msg } = stored[0]
  assert.equal(msg.kind, 'app')
  assert.equal(msg.app, 'Shop', "the server's blueprint name, not the packet's")
  assert.equal(msg.from, 'Clerk')
  assert.equal(msg.body, 'Sale today')
  assert.equal(msg.fromId, null)
  assert.notEqual(msg.createdAt, 'forged')
  assert.deepEqual(relayed, [['chatAdded', msg, 'bob']], 'relayed to the others, not back to the sender')
})

test('appChat: an unknown or non-app entity, or a message that is not text, is dropped and logged once', async t => {
  const { network, stored, relayed, logs, socket } = appChatNetwork(t)
  for (const data of [
    { id: 'missing', body: 'x' },
    { id: 'bob', body: 'x' },
    { id: 'shop', body: { not: 'text' } },
    { id: 'shop', body: '   ' },
    { body: 'no id' },
    'text',
    null,
  ]) {
    await network.onAppChat(socket, data)
  }
  assert.deepEqual(stored, [])
  assert.deepEqual(relayed, [])
  assert.deepEqual([...new Set(logs.map(([key]) => key))].sort(), ['appChat-app', 'appChat-invalid'])
})

test('world.chat from a script: hostile values are read once and must be text', () => {
  const { world, entity } = chatWorld()
  let reads = 0
  const changing = {
    get body() {
      reads++
      return reads === 1 ? 'hello' : forgedElement()
    },
    from: forgedElement(),
  }
  world.apps.worldMethods.chat(entity, changing)
  assert.equal(reads, 1)
  assert.deepEqual(
    { ...world.chat.msgs[0], id: null, createdAt: null },
    { kind: 'app', app: 'Shop', body: 'hello', id: null, createdAt: null }
  )
  for (const msg of [{ body: forgedElement() }, { body: new String('x') }, 'text', null, new Proxy({}, {})]) {
    world.apps.worldMethods.chat(entity, msg)
  }
  assert.equal(world.chat.msgs.length, 1)
  assert.equal(scriptChatMessage(new Proxy({}, { getPrototypeOf: () => assert.fail('x') }), 'Shop'), null)
})

test('world.chat on the server: broadcast as an app line', () => {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const sent = []
  const world = {
    network: { isServer: true, send: (name, data) => sent.push([name, data]) && true, asScript: fn => fn() },
    entities: { getPlayer: () => assert.fail('no bubble on an app line') },
    events: { emit() {} },
  }
  world.chat = new Chat(world)
  const apps = new Apps(world)
  apps.worldMethods.chat({ data: { id: 'app' }, blueprint: { name: 'Shop' } }, forged, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'chatAdded')
  assert.equal(sent[0][1].kind, 'app')
  assert.equal(sent[0][1].app, 'Shop')
  assert.equal(Object.hasOwn(sent[0][1], 'fromId'), false)
  // a server script's line was not sent by a visitor's client: it names nobody, whatever the script gave
  assert.equal(Object.hasOwn(sent[0][1], 'via'), false)
  assert.equal(Object.hasOwn(world.chat.msgs[0], 'via'), false)
  assert.equal(Object.hasOwn(scriptChatMessage(forged, 'Shop'), 'via'), false)
})

test("a player's chat packet is a player line whatever kind it claims", async t => {
  const network = makeNetwork(t, { net })
  const stored = []
  const relayed = []
  network.world.chat = { add: (msg, broadcast) => stored.push({ msg, broadcast }) }
  network.send = (name, data, ignore) => relayed.push([name, data, ignore])
  const socket = { id: 'bob', player: { data: { id: 'bob', name: 'Bob' } } }
  for (const kind of ['tip', 'system', 'app', 'player', undefined]) {
    await network.onChatAdded(socket, { ...forged, kind })
  }
  assert.equal(stored.length, 5)
  for (const { msg } of stored) {
    assert.equal(msg.kind, 'player')
    assert.equal(msg.fromId, 'bob')
    assert.equal(msg.from, 'Bob')
    assert.equal(Object.hasOwn(msg, 'app'), false)
    assert.equal(Object.hasOwn(msg, 'via'), false, "a player's line never names a relayer, nor becomes an app line")
    assert.equal(Object.hasOwn(chatEnvelope(msg), 'via'), false)
  }
  assert.ok(relayed.every(([name, data, ignore]) => name === 'chatAdded' && data.kind === 'player' && ignore === 'bob'))
})

test('Chat.add: only a player line pops a bubble; other kinds lose any player id', () => {
  const { world, bubbles } = chatWorld()
  world.chat.add({ kind: 'player', fromId: 'alice', from: 'Alice', body: 'hi' })
  world.chat.add({ kind: 'system', fromId: 'alice', body: 'notice' })
  world.chat.add({ kind: 'tip', fromId: 'alice', body: 'tip' })
  // a line without a kind (an older server) shows as a plain line and pops nothing
  world.chat.add({ fromId: 'alice', from: 'Alice', body: 'legacy' })
  world.chat.add({ kind: 'bogus', body: 'unknown kind' })
  assert.deepEqual(bubbles, ['hi'])
  assert.deepEqual(
    world.chat.msgs.map(msg => [msg.kind, msg.fromId]),
    [
      ['player', 'alice'],
      ['system', undefined],
      ['tip', undefined],
      [undefined, 'alice'],
      [undefined, undefined],
    ]
  )
  assert.deepEqual(chatEnvelope({ kind: 'app', app: 'x'.repeat(100), body: 'b' }), {
    kind: 'app',
    app: 'x'.repeat(64),
    body: 'b',
  })
})

test('Message: tip and system lines carry a marker an app line cannot show; text only', () => {
  // markup only (the component's style sheet names every class)
  const html = msg =>
    renderSafely(ui, ui.createElement(ui.Message, { msg })).replace(/<style[^]*?<\/style>|<!-- -->/g, '')
  const tip = html({ kind: 'tip', body: 'Alice tipped Bob 100 JPYC' })
  const system = html({ kind: 'system', body: 'Spawn updated' })
  const app = html({ kind: 'app', app: 'System', from: 'Alice', body: 'Alice tipped Bob 100 JPYC' })
  const appWithoutName = html({ kind: 'app', body: 'x' })
  const player = html({ kind: 'player', fromId: 'p', from: '', body: 'hello' })
  const legacy = html({ from: null, fromId: null, body: 'old server line' })
  assert.match(tip, /class="message-marker tip"/)
  assert.match(system, /class="message-marker system"/)
  assert.match(tip, /class="[^"]*\bmessage tip"/)
  for (const line of [app, appWithoutName, player, legacy]) {
    assert.doesNotMatch(line, /message-marker/)
    assert.doesNotMatch(line, /class="[^"]*\bmessage (tip|system)\b/)
  }
  assert.match(app, /class="message-app">System</)
  assert.match(appWithoutName, /class="message-app">App</)
  assert.match(player, /\[Anonymous\]/)
  // a body, name or app name that is not text renders as nothing
  const hostile = html({ kind: 'app', app: forgedElement(), from: forgedElement(), body: forgedElement() })
  assert.match(hostile, /class="message-app">App</)
})

// ---------- who relayed an app line (`via`): the server's stamp, the sender's own copy, the chat panel ----------

test("appChat: the line names the sender's player (via), from the connection, never from the packet", async t => {
  const { network, stored, relayed } = appChatNetwork(t)
  // (the connection's id is not the player's, so the one taken is seen)
  const socket = { id: 'conn-1', player: { data: { id: 'bob', name: 'Bob' } } }
  let reads = 0
  const counted = {
    get() {
      reads++
      return 'alice'
    },
    getPrototypeOf() {
      reads++
      return Object.prototype
    },
  }
  const packets = [
    { id: 'shop', body: 'one', from: 'Admin', via: { id: 'alice', name: 'Admin' } },
    { id: 'shop', body: 'two', from: 'Admin', via: 'Admin' },
    { id: 'shop', body: 'three', from: 'Admin', via: ['alice', 'Admin'] },
    {
      id: 'shop',
      body: 'four',
      from: 'Admin',
      get via() {
        reads++
        return { id: 'alice', name: 'Admin' }
      },
    },
    { id: 'shop', body: 'five', from: 'Admin', via: new Proxy({}, counted) },
  ]
  for (const data of packets) await network.onAppChat(socket, data)
  // asserted after the act (the handler's own try/catch would take an assertion made inside it)
  assert.equal(reads, 0, "nothing of the packet's via is read")
  assert.deepEqual(
    stored.map(({ msg }) => [msg.body, msg.from, msg.via]),
    ['one', 'two', 'three', 'four', 'five'].map(body => [body, 'Admin', { id: 'bob', name: 'Bob' }])
  )
  assert.deepEqual(
    relayed.map(([name, data, ignore]) => [name, data.via, ignore]),
    packets.map(() => ['chatAdded', { id: 'bob', name: 'Bob' }, 'conn-1'])
  )
  // the name is the one the server holds when the line arrives
  socket.player.data.name = 'Bobby'
  await network.onAppChat(socket, { id: 'shop', body: 'six' })
  assert.deepEqual(stored.at(-1).msg.via, { id: 'bob', name: 'Bobby' })
  assert.equal(stored.at(-1).msg.from, null)
})

test('appChat: the stored line, the chat event and the snapshot carry the via; a listener cannot change it', async t => {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const network = makeNetwork(t, { net })
  const events = []
  const relayed = []
  network.world.events = { emit: (name, data) => events.push([name, data]) }
  network.world.entities = {
    get: id => (id === 'shop' ? { isApp: true, blueprint: { name: 'Shop' } } : undefined),
    getPlayer: () => null,
  }
  network.world.chat = new Chat(network.world)
  network.send = (name, data, ignore) => relayed.push([name, data, ignore])
  const socket = { id: 'bob', player: { data: { id: 'bob', name: 'Bob' } } }
  await network.onAppChat(socket, { id: 'shop', body: 'sale', from: 'Clerk', via: { id: 'alice', name: 'Admin' } })
  const [stored] = network.world.chat.msgs
  assert.deepEqual(stored.via, { id: 'bob', name: 'Bob' })
  assert.equal(Object.isFrozen(stored.via), true)
  // the event a script's world.on('chat') gets: the same via, which no listener can change
  assert.equal(events.length, 1)
  const [name, event] = events[0]
  assert.equal(name, 'chat')
  assert.equal(event.via, stored.via)
  assert.throws(() => {
    event.via.name = 'Admin'
  }, TypeError)
  assert.equal(stored.via.name, 'Bob')
  // what the others are sent, and what a newcomer's snapshot holds, as the server packs them and a client reads them
  const [, line] = readPacket(writePacket('chatAdded', relayed[0][1]))
  assert.deepEqual(line.via, { id: 'bob', name: 'Bob' })
  const [, snapshot] = readPacket(writePacket('snapshot', { chat: network.world.chat.serialize() }))
  assert.deepEqual(snapshot.chat[0].via, { id: 'bob', name: 'Bob' })
  // a client keeps it from the snapshot (Chat.deserialize) and from a chatAdded (Chat.add, through the envelope)
  const { world } = chatWorld()
  world.chat.deserialize(snapshot.chat)
  assert.deepEqual(world.chat.msgs[0].via, { id: 'bob', name: 'Bob' })
  world.chat.add(line, false)
  assert.deepEqual(world.chat.msgs[1].via, { id: 'bob', name: 'Bob' })
})

test("world.chat from a client script: the sender's own copy of a broadcast names it as the others' copies do", () => {
  const { world, entity } = chatWorld()
  world.entities.player = { data: { id: 'player', name: 'Alice' } }
  world.apps.worldMethods.chat(entity, { body: 'sale', from: 'Clerk', via: { id: 'x', name: 'Admin' } }, true)
  world.apps.worldMethods.chat(entity, { body: 'here only' }, false)
  world.apps.worldMethods.chat(entity, { body: 'here only, false by default' })
  const [broadcast, ...local] = world.chat.msgs
  assert.deepEqual(broadcast.via, { id: 'player', name: 'Alice' }, "the local player's id and name")
  assert.equal(Object.isFrozen(broadcast.via), true)
  for (const msg of local) assert.equal(Object.hasOwn(msg, 'via'), false, 'a line that stays here names nobody')
  // the packet carries no via: the server sets its own
  assert.deepEqual(world.packets.map(decodePacket), [['appChat', { id: 'app', body: 'sale', from: 'Clerk' }]])
  // the name as the local player has it when the line is made
  world.entities.player.data.name = 'Alicia'
  world.apps.worldMethods.chat(entity, { body: 'renamed' }, true)
  assert.deepEqual(world.chat.msgs.at(-1).via, { id: 'player', name: 'Alicia' })
  // before the local player is known (a script that runs while the snapshot is read): the line is sent all the same
  // (the others get the server's via) and this copy names nobody
  world.entities.player = null
  world.apps.worldMethods.chat(entity, { body: 'early' }, true)
  assert.equal(world.chat.msgs.at(-1).body, 'early')
  assert.equal(Object.hasOwn(world.chat.msgs.at(-1), 'via'), false)
  assert.deepEqual(world.packets.map(decodePacket).at(-1), ['appChat', { id: 'app', body: 'early', from: null }])
})

test('Message: an app line a visitor sent says whose browser sent it; one without is drawn as before', () => {
  const html = msg =>
    renderSafely(ui, ui.createElement(ui.Message, { msg })).replace(/<style[^]*?<\/style>|<!-- -->/g, '')
  // the class the component's style sheet is generated under
  const markup = msg => html(msg).replace(/^<div class="_[a-z0-9]+ /, '<div class="_ ')
  // app lines without a via: the markup the component made before via existed (recorded from it)
  assert.equal(
    markup({ kind: 'app', app: 'Shop', from: 'Clerk', body: 'Sale today' }),
    '<div class="_  message app"><span class="message-app">Shop</span><span class="message-from">[Clerk]</span><span class="message-body">Sale today</span></div>'
  )
  assert.equal(
    markup({ kind: 'app', app: 'Shop', body: 'no from' }),
    '<div class="_  message app"><span class="message-app">Shop</span><span class="message-body">no from</span></div>'
  )
  assert.equal(
    markup({ kind: 'app', body: 'no app name' }),
    '<div class="_  message app"><span class="message-app">App</span><span class="message-body">no app name</span></div>'
  )
  // with one: after the app's name and the display name, before the text
  const suffix = name =>
    `<span class="message-via" title="Sent from ${name}&#x27;s browser by this app&#x27;s script">via ${name}</span>`
  assert.equal(
    markup({ kind: 'app', app: 'Shop', from: 'Clerk', body: 'Sale today', via: { id: 'bob', name: 'Bob' } }),
    `<div class="_  message app"><span class="message-app">Shop</span><span class="message-from">[Clerk]</span>${suffix('Bob')}<span class="message-body">Sale today</span></div>`
  )
  assert.equal(
    markup({ kind: 'app', app: 'Shop', body: 'x', via: { id: 'bob', name: 'Bob' } }),
    `<div class="_  message app"><span class="message-app">Shop</span>${suffix('Bob')}<span class="message-body">x</span></div>`
  )
  // a name that is empty or not text is Anonymous (a boxed string, a forged element, an object whose toString throws,
  // a Proxy: none is converted); a long one is cut as a name is
  for (const name of ['', undefined, null, ['Bob'], ...Object.values(hostileValues())]) {
    assert.ok(html({ kind: 'app', app: 'Shop', body: 'x', via: { id: 'b', name } }).includes(suffix('Anonymous')))
  }
  assert.ok(html({ kind: 'app', body: 'x', via: {} }).includes(suffix('Anonymous')), 'a via without a name')
  assert.ok(html({ kind: 'app', body: 'x', via: hostileValues().proxy }).includes(suffix('Anonymous')), 'a Proxy')
  const long = 'n'.repeat(100)
  assert.ok(
    html({ kind: 'app', body: 'x', via: { id: 'b', name: long } }).includes(suffix('n'.repeat(NAME_MAX_LENGTH)))
  )
  // a via that is not an object, or on a line that is not an app's, shows nothing
  for (const via of ['Bob', 7, true, null]) {
    assert.doesNotMatch(html({ kind: 'app', body: 'x', via }), /message-via/, String(via))
  }
  for (const kind of ['player', 'system', 'tip', undefined]) {
    const line = html({ kind, fromId: 'p', from: 'Alice', body: 'x', via: { id: 'bob', name: 'Bob' } })
    assert.doesNotMatch(line, /message-via|via Bob/, String(kind))
  }
})
