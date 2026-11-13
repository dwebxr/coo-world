// The touch chat line (MiniMessages, CoreUI.js) when the chat is cleared (UI-07). A builder's `/chat clear` reaches
// every client as `chatCleared` (ServerNetwork → ClientNetwork.onChatCleared → Chat.clear), and Chat hands each
// listener the empty list. MiniMessages, shown on a touch device while the chat is closed, read the last line's
// `fromId` from it and threw: the client's packet queue logged the TypeError, and the line it was showing stayed until
// its 4 s timer, where the full chat empties at once. Run here: the real ClientNetwork (its packet queue), the real
// Chat and the actual MiniMessages source, its hooks emulated as clientLifecycle.test.js mountComponent does
// (react-dom/server, which renderHarness.mjs uses, runs no effects, and the chat subscription is an effect).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { transformSync } from 'esbuild'

import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { readPacket, writePacket } from '../src/core/packets.js'

const Chat = loadClient('core/systems/Chat.js', 'Chat')
// (the harness's ClientNetwork is given no packet reader: its tests call the handlers)
const ClientNetwork = loadClient('core/systems/ClientNetwork.js', 'ClientNetwork', { readPacket })

// a client world whose packets go through the real queue to the real Chat
function chatWorld() {
  const world = clientWorld()
  world.network = new ClientNetwork(world)
  world.network.id = 'me'
  world.events = { emit() {} }
  world.entities.getPlayer = () => null
  world.chat = new Chat(world)
  // a packet from the server, handled when the world next ticks (preFixedUpdate)
  world.receive = (name, data) => {
    world.network.onPacket({ data: writePacket(name, data) })
    world.network.preFixedUpdate()
  }
  return world
}

const line = (id, fromId, body) => ({
  id,
  kind: 'player',
  from: fromId,
  fromId,
  body,
  createdAt: '2026-01-01T00:00:00Z',
})

// MiniMessages from CoreUI.js: a state set by a listener is drawn by the next render(), as React would schedule it;
// its timers are held, not run
function mountMiniMessages(world) {
  const source = fs.readFileSync(new URL('../src/client/components/CoreUI.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  const effects = []
  let cursor = 0
  const timers = new Map()
  let timerIds = 0
  const context = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => (slots[index] = typeof value === 'function' ? value(slots[index]) : value)]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps && deps.every((dep, i) => dep === previous.deps[i])) return
      slots[index] = { effect: true, deps: deps ?? [], cleanup: previous?.cleanup }
      effects.push(() => {
        slots[index].cleanup?.()
        slots[index].cleanup = effect()
      })
    },
    css: () => '',
    element: (type, props) => ({ type, props }),
    setTimeout: fn => (timers.set(++timerIds, fn), timerIds),
    clearTimeout: id => timers.delete(id),
  }
  const MiniMessages = new Function(...Object.keys(context), `${code}\nreturn MiniMessages`)(...Object.values(context))
  let output
  const render = () => {
    cursor = 0
    output = MiniMessages({ world })
    while (effects.length) {
      for (const effect of effects.splice(0)) effect()
      cursor = 0
      output = MiniMessages({ world })
    }
  }
  render()
  return {
    // the body of the line shown, or null when nothing is
    shown() {
      render()
      return output ? output.props.msg.body : null
    },
    unmount() {
      for (const slot of slots) if (slot?.effect) slot.cleanup?.()
    },
  }
}

test('a cleared chat: the touch chat line throws nothing and goes, as the full chat empties, and the next line shows', t => {
  const errors = t.mock.method(console, 'error', () => {})
  const world = chatWorld()
  const mini = mountMiniMessages(world)
  assert.equal(mini.shown(), null)
  world.receive('chatAdded', line('1', 'bob', 'hello from bob'))
  assert.equal(mini.shown(), 'hello from bob')

  world.receive('chatCleared')
  assert.deepEqual(
    errors.mock.calls.map(call => String(call.arguments[0])),
    [],
    'the packet queue logged what the listener threw'
  )
  assert.equal(world.chat.msgs.length, 0)
  assert.equal(mini.shown(), null, 'the line shown before the clear stayed')
  assert.equal(world.chat.listeners.size, 1, 'still listening')

  world.receive('chatAdded', line('2', 'carol', 'carol after the clear'))
  assert.equal(mini.shown(), 'carol after the clear')
  // (as before: this visitor's own line is not shown here)
  world.receive('chatAdded', line('3', 'me', 'my own line'))
  assert.equal(mini.shown(), 'carol after the clear')
  // a clear with nothing shown
  world.receive('chatCleared')
  world.receive('chatCleared')
  assert.equal(mini.shown(), null)
  assert.equal(errors.mock.callCount(), 0)
  mini.unmount()
  assert.equal(world.chat.listeners.size, 0)
})

test('an empty chat handed to the touch chat line (Chat.deserialize([])) throws nothing', () => {
  const world = chatWorld()
  const mini = mountMiniMessages(world)
  world.receive('chatAdded', line('1', 'bob', 'hello from bob'))
  assert.equal(mini.shown(), 'hello from bob')
  assert.doesNotThrow(() => world.chat.deserialize([]))
  assert.equal(mini.shown(), null)
  mini.unmount()
})
