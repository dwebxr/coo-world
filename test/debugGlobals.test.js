// src/core/extras/debugGlobals.js: when the page puts handles on the engine on window.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { debugGlobalsEnabled, setDebugGlobal } from '../src/core/extras/debugGlobals.js'

test('on for a page served from the machine itself or when PUBLIC_DEBUG is true; off otherwise', () => {
  const at = hostname => ({ hostname })
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(debugGlobalsEnabled({}, at(host)), true, host)
  for (const host of ['play.example', 'localhost.example', 'notlocalhost', '127.0.0.1.example', '10.0.0.5', '']) {
    assert.equal(debugGlobalsEnabled({}, at(host)), false, host)
  }
  assert.equal(debugGlobalsEnabled({ PUBLIC_DEBUG: 'true' }, at('play.example')), true)
  for (const value of ['false', '', '1', 'TRUE', true, undefined]) {
    assert.equal(debugGlobalsEnabled({ PUBLIC_DEBUG: value }, at('play.example')), false, String(value))
  }
  assert.equal(debugGlobalsEnabled(undefined, undefined), false, 'no page (the server, a worker)')
})

test('setDebugGlobal writes to window only when enabled', () => {
  const saved = { window: globalThis.window, env: globalThis.env, location: globalThis.location }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
  try {
    delete globalThis.window
    setDebugGlobal('probe', 1) // no window: nothing, no throw
    globalThis.window = {}
    globalThis.env = {}
    globalThis.location = { hostname: 'play.example' }
    setDebugGlobal('probe', 1)
    assert.equal('probe' in globalThis.window, false)
    globalThis.env = { PUBLIC_DEBUG: 'true' }
    setDebugGlobal('probe', 2)
    assert.equal(globalThis.window.probe, 2)
    globalThis.window = {}
    globalThis.env = {}
    globalThis.location = { hostname: 'localhost' }
    setDebugGlobal('probe', 3)
    assert.equal(globalThis.window.probe, 3)
  } finally {
    restore()
  }
})
