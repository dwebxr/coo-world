import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './lib/clientHarness.mjs'
import { bundleClient, renderSafely } from './lib/renderHarness.mjs'
import { briefError } from '../src/core/extras/logOnce.js'

let ui
before(async () => {
  ui = await bundleClient(`export { LoadingOverlay } from './src/client/components/CoreUI'`)
})

const Settings = loadClient('core/systems/Settings.js', 'Settings')

const hostileTitle = { toString: null, valueOf: null }

test('Settings.deserialize: stored and snapshot values follow the settingsModified rules; bad ones fall back', () => {
  const warnings = []
  const original = console.warn
  console.warn = line => warnings.push(line)
  let settings
  try {
    settings = new Settings({})
    const changes = []
    settings.on('change', change => changes.push(change))
    settings.deserialize({
      title: hostileTitle,
      desc: 'x'.repeat(5000),
      image: { url: {} },
      avatar: { type: 'avatar', name: 'a.vrm', url: 'asset://a.vrm', extra: true },
      customAvatars: 'yes',
      voice: 'bogus',
      rank: 2,
      playerLimit: 1.5,
      // ao missing: stays unset
    })
    assert.equal(changes.length, 1)
  } finally {
    console.warn = original
  }
  assert.equal(settings.title, null)
  assert.equal(settings.desc.length, 2048, 'cut like a settings change')
  assert.equal(settings.image, null)
  assert.deepEqual(settings.avatar, { type: 'avatar', name: 'a.vrm', url: 'asset://a.vrm' })
  assert.equal(settings.customAvatars, false)
  assert.equal(settings.voice, 'spatial')
  assert.equal(settings.rank, 0, 'an invalid rank never becomes admin')
  assert.equal(settings.playerLimit, 0)
  assert.equal(settings.ao, undefined)
  // a second load of the same bad value says nothing new
  console.warn = line => warnings.push(line)
  try {
    settings.deserialize({ title: hostileTitle })
  } finally {
    console.warn = original
  }
  assert.deepEqual(warnings.map(line => line.match(/stored (\w+)/)[1]).sort(), [
    'customAvatars',
    'image',
    'playerLimit',
    'rank',
    'title',
    'voice',
  ])
})

test('the title and loading image sinks keep primitive guards', () => {
  const doc = { title: '', addEventListener() {}, removeEventListener() {} }
  const Client = loadClient('core/systems/Client.js', 'Client', {
    briefError,
    initYoga() {},
    window: {},
    document: doc,
  })
  const client = new Client({})
  client.onSettingsChange({ title: { value: hostileTitle } })
  assert.equal(doc.title, 'World')
  client.onSettingsChange({ title: { value: 'My world' } })
  assert.equal(doc.title, 'My world')
  const world = {
    settings: { title: hostileTitle, desc: { not: 'text' }, image: { url: {} } },
    resolveURL: url => url.trim(),
    on() {},
    off() {},
  }
  const html = renderSafely(ui, ui.createElement(ui.LoadingOverlay, { world }))
  assert.match(html, /background-image:none/)
})
