// The interface made again after a render error (world-client.js: the root ErrorBoundary mounts a new CoreUI) starts
// from what the world has already told it (ClientUI.latest), not from nothing. `ready` is told once, when the local
// player is in: a CoreUI that waited for it again stayed behind the loading screen for good, without the sidebar, the
// chat or the controls. CoreUI is rendered to a string here (no effects run), so what shows is what it starts from.
// test/e2e/interface-faults.mjs makes the whole interface fail once in a browser and sees it come back.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

import { bundleClient } from './lib/renderHarness.mjs'

let ui
before(async () => {
  ui = await bundleClient(`
    export { CoreUI } from './src/client/components/CoreUI'
    export { ClientUI } from './src/core/systems/ClientUI'
    export { default as EventEmitter } from 'eventemitter3'
  `)
})

// a world with the real ClientUI and what the interface reads while it renders
function world() {
  const emitter = fields => Object.assign(new ui.EventEmitter(), fields)
  const w = new ui.EventEmitter()
  w.ui = new ui.ClientUI(w)
  w.entities = { player: { data: { id: 'me', name: 'Me' }, isAdmin: () => false, isBuilder: () => false } }
  w.settings = emitter({ title: 'A world', desc: '', image: null })
  w.prefs = emitter({ ui: 1, actions: true })
  w.livekit = emitter({ status: { available: false } })
  w.controls = { pointer: { locked: false }, actions: [] }
  w.builder = { enabled: false }
  w.chat = { subscribe: () => () => {} }
  w.network = { id: 'me' }
  w.xr = { supportsVR: false }
  w.resolveURL = url => url
  w.fatalError = null
  return w
}

const render = w => ui.renderToString(ui.createElement(ui.CoreUI, { world: w }))

test('a CoreUI made before the world is ready shows the loading screen', () => {
  const html = render(world())
  assert.match(html, /loading-image/)
  assert.doesNotMatch(html, /class="sidebar/)
})

test('a CoreUI made after the world was ready shows the interface, not the loading screen', () => {
  const w = world()
  w.emit('ready', true)
  const html = render(w)
  assert.doesNotMatch(html, /loading-image/)
  assert.match(html, /class="sidebar/)
  assert.match(html, /mainchat/)
})

test('a CoreUI made again still shows a kick, a lost connection and a confirm dialog that waits for an answer', () => {
  const kicked = world()
  kicked.emit('kick', 'player_limit')
  assert.match(render(kicked), /Player limit reached\./)

  const closed = world()
  closed.emit('ready', true)
  closed.emit('disconnect', true)
  assert.match(render(closed), /Reconnect/)

  const asking = world()
  asking.emit('ready', true)
  let answer
  asking.ui.confirm({ title: 'Delete this app?', message: 'It cannot be undone.' }).then(value => (answer = value))
  assert.match(render(asking), /Delete this app\?/)
  asking.ui.latest.confirm.cancel()
  assert.equal(asking.ui.latest.confirm, null, 'an answered dialog is not shown again')
  assert.doesNotMatch(render(asking), /Delete this app\?/)
  return Promise.resolve().then(() => assert.equal(answer, false))
})

test('the avatar pane is shown again while it is open, and not once it is closed', () => {
  const w = world()
  w.emit('ready', true)
  w.emit('avatar', { hash: 'abc', url: 'asset://abc.vrm', file: null, canPlace: false })
  assert.match(render(w), /vpane-head-title/)
  w.emit('avatar', null)
  assert.doesNotMatch(render(w), /vpane-head-title/)
})
