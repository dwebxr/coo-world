import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, clientWorld } from './lib/clientHarness.mjs'
import { loadNetwork, makeNetwork } from './lib/network.mjs'
import { bundleClient, forgedElement, renderSafely } from './lib/renderHarness.mjs'
import { chatEnvelope, scriptChatMessage } from '../src/core/extras/chatPolicy.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'
import { packetNameById } from '../src/core/packets.js'

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
  const asked = []
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const Apps = loadClient('core/systems/Apps.js', 'Apps')
  const sent = []
  const world = {
    network: { isServer: true, send: (name, data) => sent.push([name, data]) && true, asScript: fn => fn() },
    // (asked for no player: recorded and asserted after, as a throw in the chat's handling could be caught there)
    entities: { getPlayer: id => (asked.push(id), undefined) },
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
  assert.deepEqual(asked, [], 'no bubble on an app line')
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
