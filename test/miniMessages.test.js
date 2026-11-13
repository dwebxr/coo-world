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

// MiniMessages from CoreUI.js. A state set by a listener or a timer is drawn by the next render(), as React would
// schedule it. Timers run on a clock of the test's own: each keeps the delay it was asked for, advance() moves the
// time and runs the callbacks that are due (in the order they are due, drawing after each), and clearTimeout cancels.
function mountMiniMessages(world) {
  const source = fs.readFileSync(new URL('../src/client/components/CoreUI.js', import.meta.url), 'utf8')
  const code = transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '').replace(/^export /gm, ''), {
    loader: 'jsx',
    jsxFactory: 'element',
  }).code
  const slots = []
  const effects = []
  let cursor = 0
  let now = 0
  let timerIds = 0
  const timers = new Map()
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
    setTimeout(fn, delay) {
      timers.set(++timerIds, { fn, delay, at: now + delay })
      return timerIds
    },
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
    advance(ms) {
      render()
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        render()
      }
      now = end
    },
    // the delays of the timers not yet run or cancelled
    pending: () => [...timers.values()].map(timer => timer.delay),
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

// the line goes after 4 s (CoreUI.js: setTimeout(…, 4000)), counted from when it was shown
test('the touch chat line goes when its 4 s are up and not before, and a newer line starts its time again', () => {
  const world = chatWorld()
  const mini = mountMiniMessages(world)
  world.receive('chatAdded', line('1', 'bob', 'hello from bob'))
  assert.equal(mini.shown(), 'hello from bob')
  assert.deepEqual(mini.pending(), [4000], 'one timer, of the delay the line is shown for')
  mini.advance(3999)
  assert.equal(mini.shown(), 'hello from bob')
  mini.advance(1)
  assert.equal(mini.shown(), null)

  // a line replaced by another: the newer one has its own 4 s
  world.receive('chatAdded', line('2', 'carol', 'carol'))
  assert.equal(mini.shown(), 'carol')
  mini.advance(3000)
  world.receive('chatAdded', line('3', 'dave', 'dave'))
  assert.equal(mini.shown(), 'dave')
  mini.advance(1000)
  assert.equal(mini.shown(), 'dave', "carol's time ended dave's line")
  mini.advance(2999)
  assert.equal(mini.shown(), 'dave')
  mini.advance(1)
  assert.equal(mini.shown(), null)
  mini.unmount()
})

test('a line after a clear keeps its own 4 s: the time of the line the clear took away does not end it', () => {
  const world = chatWorld()
  const mini = mountMiniMessages(world)
  world.receive('chatAdded', line('1', 'bob', 'hello from bob'))
  assert.equal(mini.shown(), 'hello from bob')
  mini.advance(1000)
  world.receive('chatCleared')
  assert.equal(mini.shown(), null)
  mini.advance(500)
  world.receive('chatAdded', line('2', 'carol', 'carol after the clear'))
  assert.equal(mini.shown(), 'carol after the clear')
  assert.deepEqual(mini.pending(), [4000], "only the new line's timer is left")
  // bob's line would have gone at 4000; carol's goes at 1500 + 4000
  mini.advance(2500)
  assert.equal(mini.shown(), 'carol after the clear', "the cleared line's time ended the new line")
  mini.advance(1499)
  assert.equal(mini.shown(), 'carol after the clear')
  mini.advance(1)
  assert.equal(mini.shown(), null)
  mini.unmount()
})

test('closing the touch chat line (unmount) cancels its timer and its subscription', () => {
  const world = chatWorld()
  const mini = mountMiniMessages(world)
  world.receive('chatAdded', line('1', 'bob', 'hello from bob'))
  assert.equal(mini.shown(), 'hello from bob')
  assert.equal(mini.pending().length, 1)
  assert.equal(world.chat.listeners.size, 1)
  mini.unmount()
  assert.deepEqual(mini.pending(), [], 'a timer outlived the line')
  assert.equal(world.chat.listeners.size, 0, 'still subscribed')
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
