import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveObjectURL } from 'node:buffer'
import {
  OBJECT_URL_LIMIT,
  createScriptBlob,
  createScriptObjectURL,
  isScriptBlob,
  revokeRunObjectURLs,
  revokeScriptObjectURL,
  safeBlobType,
  toHostBlob,
} from '../src/core/extras/scriptBlob.js'
import { Teardown, beginTeardown } from '../src/core/extras/runTeardown.js'

const bytes = new TextEncoder().encode('hello blob world')
const hostBlob = type => new Blob([bytes], { type })

test('scriptBlob: the facade is a frozen plain object with closure methods only', async () => {
  const facade = await createScriptBlob(hostBlob('text/html'))
  assert.equal(Object.getPrototypeOf(facade), Object.prototype)
  assert.equal(Object.isFrozen(facade), true)
  assert.deepEqual(Object.keys(facade).sort(), ['arrayBuffer', 'size', 'slice', 'text', 'type'])
  assert.equal(facade.size, bytes.length)
  assert.equal(facade.type, 'text/html')
  assert.equal(facade.stream, undefined)
  assert.equal(facade.bytes, undefined)
  assert.equal(facade instanceof Blob, false)
  // methods do not depend on `this`
  const { text, arrayBuffer } = facade
  assert.equal(await text(), 'hello blob world')
  assert.equal(new Uint8Array(await arrayBuffer()).length, bytes.length)
})

test('scriptBlob: arrayBuffer() returns a fresh copy each time', async () => {
  const facade = await createScriptBlob(hostBlob('image/png'))
  const a = await facade.arrayBuffer()
  const b = await facade.arrayBuffer()
  assert.notEqual(a, b)
  new Uint8Array(a).fill(0)
  assert.equal(new Uint8Array(b)[0], bytes[0])
  assert.equal(await facade.text(), 'hello blob world')
})

test('scriptBlob: slice() follows Blob index rules and ignores a script-chosen type', async () => {
  const facade = await createScriptBlob(hostBlob('text/html'))
  const head = facade.slice(0, 5, 'text/html')
  assert.equal(await head.text(), 'hello')
  assert.equal(head.type, 'text/html') // the parent's host type, not the argument
  assert.equal(facade.slice(0, 5, 'image/png').type, 'text/html')
  assert.equal(await facade.slice(-5).text(), 'world')
  assert.equal(await facade.slice(6, -6).text(), 'blob')
  assert.equal(facade.slice(10, 2).size, 0)
  assert.equal(facade.slice(100).size, 0)
  assert.equal(facade.slice().size, facade.size)
  assert.equal(isScriptBlob(head), true)
  assert.equal(Object.isFrozen(head), true)
})

test('scriptBlob: only facades resolve; anything else is rejected with a TypeError', async () => {
  const facade = await createScriptBlob(hostBlob('image/png'))
  assert.equal(isScriptBlob(facade), true)
  for (const value of [undefined, null, {}, hostBlob('image/png'), { ...facade }, Object.create(facade)]) {
    assert.equal(isScriptBlob(value), false)
    assert.throws(() => toHostBlob(value), TypeError)
    assert.throws(() => createScriptObjectURL(value), TypeError)
  }
  const back = toHostBlob(facade)
  assert.equal(back instanceof Blob, true)
  assert.equal(back.type, 'image/png')
  assert.equal(await back.text(), 'hello blob world')
})

test('safeBlobType: allowlisted media types pass, everything else becomes application/octet-stream', () => {
  assert.equal(safeBlobType('image/png'), 'image/png')
  assert.equal(safeBlobType('IMAGE/PNG; charset=binary'), 'image/png')
  assert.equal(safeBlobType('model/gltf-binary'), 'model/gltf-binary')
  assert.equal(safeBlobType('video/mp4'), 'video/mp4')
  for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'text/plain', '', undefined, null, 42]) {
    assert.equal(safeBlobType(type), 'application/octet-stream', String(type))
  }
})

test('createScriptObjectURL: the object URL serves the forced type', async () => {
  const html = await createScriptBlob(hostBlob('text/html'))
  const htmlUrl = createScriptObjectURL(html)
  assert.match(htmlUrl, /^blob:/)
  const htmlResp = await fetch(htmlUrl)
  assert.equal(htmlResp.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await htmlResp.text(), 'hello blob world')
  URL.revokeObjectURL(htmlUrl)
  // a slice that asked for text/html is still opaque
  const sliceUrl = createScriptObjectURL(html.slice(0, 5, 'text/html'))
  assert.equal((await fetch(sliceUrl)).headers.get('content-type'), 'application/octet-stream')
  URL.revokeObjectURL(sliceUrl)
  const png = await createScriptBlob(hostBlob('image/png'))
  const pngUrl = createScriptObjectURL(png)
  assert.equal((await fetch(pngUrl)).headers.get('content-type'), 'image/png')
  URL.revokeObjectURL(pngUrl)
})

test('createScriptBlob: a failing host read rejects with an intrinsic Error without a cause', async () => {
  const broken = {
    type: 'text/plain',
    arrayBuffer: async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    },
  }
  const err = await createScriptBlob(broken).then(
    () => null,
    e => e
  )
  assert.equal(Object.getPrototypeOf(err), Error.prototype)
  assert.equal(err.name, 'AbortError')
  assert.equal(err.message, 'The operation was aborted.')
  assert.equal('cause' in err, false)
})

// an app run as the object URLs see it (App.fetchFor hands the blob its run)
function appRun() {
  const run = { dead: false }
  return { entity: { deadHook: run }, run }
}

test('object URLs belong to the run whose fetch made the blob: revoked with it, refused after it', async () => {
  const owner = appRun()
  const blob = await createScriptBlob(hostBlob('image/png'), owner)
  const slice = blob.slice(0, 4)
  const urls = [createScriptObjectURL(blob), createScriptObjectURL(slice)]
  assert.ok(urls.every(url => resolveObjectURL(url)))
  // a script revokes its own; an engine URL (any other) is not revocable through it
  revokeScriptObjectURL(urls[0])
  assert.equal(resolveObjectURL(urls[0]), undefined)
  const engineURL = URL.createObjectURL(new Blob(['engine']))
  revokeScriptObjectURL(engineURL)
  assert.ok(resolveObjectURL(engineURL), 'only URLs minted for scripts are revoked')
  URL.revokeObjectURL(engineURL)
  // the teardown revokes what is left, and from its object-URL stage on the run makes none
  beginTeardown(owner.run, Teardown.OBJECT_URLS)
  revokeRunObjectURLs(owner.run)
  assert.equal(resolveObjectURL(urls[1]), undefined)
  assert.throws(() => createScriptObjectURL(blob), /this app has stopped/)
  // and once the run has ended
  const later = appRun()
  const other = await createScriptBlob(hostBlob('image/png'), later)
  later.entity.deadHook = { dead: false }
  assert.throws(() => createScriptObjectURL(other), /this app has stopped/)
})

test('object URLs: at most OBJECT_URL_LIMIT live ones per run; revoking frees a slot', async () => {
  const owner = appRun()
  const blob = await createScriptBlob(hostBlob('image/png'), owner)
  const urls = []
  for (let i = 0; i < OBJECT_URL_LIMIT; i++) urls.push(createScriptObjectURL(blob))
  assert.throws(() => createScriptObjectURL(blob), /more than 256 object URLs/)
  revokeScriptObjectURL(urls.pop())
  urls.push(createScriptObjectURL(blob))
  revokeRunObjectURLs(owner.run)
  assert.ok(urls.every(url => !resolveObjectURL(url)))
})
