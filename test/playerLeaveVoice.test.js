import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { bundleProbe } from './lib/workerProbe.mjs'

// The real PlayerRemote.destroy (bundled like the server build): what a player's leaving tells the voice system
let m
let bundle
before(async () => {
  bundle = await bundleProbe(`
    export { PlayerRemote } from './src/core/entities/PlayerRemote'
  `)
  m = await import(bundle.url)
})
after(() => bundle?.destroy())

function remote(livekit) {
  const calls = []
  const p = Object.create(m.PlayerRemote.prototype)
  Object.assign(p, {
    data: { id: 'p1' },
    world: {
      livekit,
      setHot() {},
      events: { emit: (name, data) => calls.push(['event', name, data.playerId]) },
      entities: { remove: id => calls.push(['removed', id]) },
      network: { send: (...args) => calls.push(['sent', ...args]) },
    },
    base: { deactivate() {} },
    aura: { deactivate() {} },
  })
  return { p, calls }
}

test('a player who leaves the world is dropped from the voice room on this client, once', () => {
  const dropped = []
  const { p, calls } = remote({ dropPlayer: id => dropped.push(id) })
  p.destroy()
  assert.deepEqual(dropped, ['p1'])
  assert.deepEqual(calls, [
    ['event', 'leave', 'p1'],
    ['removed', 'p1'],
  ])
  p.destroy()
  assert.deepEqual(dropped, ['p1'], 'a second destroy does nothing')
})

test('on the server, whose voice system has no such part, and in a world without voice, leaving still works', () => {
  for (const livekit of [{ clearModifiers() {} }, undefined, null]) {
    const { p, calls } = remote(livekit)
    p.destroy(true)
    assert.deepEqual(calls, [
      ['event', 'leave', 'p1'],
      ['removed', 'p1'],
      ['sent', 'entityRemoved', 'p1'],
    ])
  }
})
