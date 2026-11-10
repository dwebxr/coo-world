import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { assetName, isBlueprintURL, isHttpURL, previewValue } from '../src/core/extras/assetURL.js'
import { resolveAssetFile } from '../src/core/extras/resolveAssetFile.js'

const dir = path.resolve('/srv/world/assets')
const hash = `${'0123456789abcdef'.repeat(4)}.js`

const refused = (fn, reason) =>
  assert.throws(fn, err => {
    assert.equal(err.code, 'ASSET_REFUSED')
    if (reason) assert.match(err.message, reason)
    return true
  })

test('resolveAssetFile: a content-hash or built-in name is a file directly inside the assets directory', () => {
  assert.equal(resolveAssetFile(`asset://${hash}`, dir), path.join(dir, hash))
  for (const name of ['avatar.vrm', 'emote-idle.glb', 'crash-block.glb', 'My_file-v2.0.png', '...', 'x'.repeat(128)]) {
    assert.equal(resolveAssetFile(`asset://${name}`, dir), path.join(dir, name), name)
  }
})

test('resolveAssetFile: paths, traversal, encodings, other schemes, long names and non-strings are refused', () => {
  const bad = [
    '/etc/passwd',
    '/srv/world/assets/x.js',
    'etc/passwd',
    'x.js',
    'asset:/x.js',
    'ASSET://x.js',
    ' asset://x.js',
    'file:///etc/passwd',
    'https://example.com/a.js',
    'blob:nodedata:abc',
    'asset://',
    'asset://.',
    'asset://..',
    'asset://../x',
    'asset://../../../proc/self/environ',
    'asset://a/b',
    'asset://a/../b',
    'asset:///etc/passwd',
    'asset://%2e%2e',
    'asset://%2e%2e%2fx',
    'asset://..%2fx',
    'asset://a\\b',
    'asset://..\\x',
    'asset://x.js\0',
    'asset://x\0.js',
    'asset://x.js?v=1',
    'asset://x.js#h',
    'asset://x js',
    'asset://x.js ',
    'asset://ｘ.js',
    `asset://${'x'.repeat(129)}`,
  ]
  for (const url of bad) refused(() => resolveAssetFile(url, dir), undefined)
  for (const url of [null, undefined, 1, {}, ['asset://x.js'], () => 'asset://x.js', Symbol('x')]) {
    refused(() => resolveAssetFile(url, dir), /not a string/)
  }
  refused(() => resolveAssetFile('/etc/passwd', dir), /not an asset:\/\/ URL/)
  refused(() => resolveAssetFile('asset://../x', dir), /invalid asset name/)
})

test('resolveAssetFile: containment holds when the assets dir has .. segments or a trailing slash', () => {
  for (const assetsDir of [
    '/srv/world/../world/assets',
    '/srv/world/assets/',
    '/srv/world/assets/./',
    '/srv//world/assets',
  ]) {
    assert.equal(resolveAssetFile(`asset://${hash}`, assetsDir), path.join(dir, hash), assetsDir)
    refused(() => resolveAssetFile('asset://../x', assetsDir))
    refused(() => resolveAssetFile('asset://..', assetsDir))
  }
  // a relative assets dir resolves against the working directory, and stays the parent
  const relative = resolveAssetFile(`asset://${hash}`, 'world/assets')
  assert.equal(relative, path.join(path.resolve('world/assets'), hash))
  for (const assetsDir of [undefined, null, '', 1]) {
    assert.throws(() => resolveAssetFile(`asset://${hash}`, assetsDir), /no assets directory/)
  }
})

test('resolveAssetFile: the refusal names the reason and only a short, printable prefix of the value', () => {
  const secret = '/proc/self/environ' + 'S'.repeat(200)
  assert.throws(
    () => resolveAssetFile(secret, dir),
    err => {
      assert.ok(err.message.length < 80, err.message)
      assert.ok(!err.message.includes('S'.repeat(20)))
      return true
    }
  )
  assert.throws(
    () => resolveAssetFile('asset://\n\u0000‮../x', dir),
    err => !/[\n\0‮]/.test(err.message)
  )
  assert.equal(previewValue('abc'), '"abc"')
  assert.equal(previewValue('a"b\\c'), JSON.stringify('a"b\\c'))
  assert.equal(previewValue('x'.repeat(30)), `"${'x'.repeat(24)}..."`)
  assert.equal(previewValue('\n\u0000é'), '"???"')
  assert.equal(previewValue(null), '(null)')
  assert.equal(previewValue(1), '(number)')
})

test('assetURL: asset names and http(s) URLs are the two blueprint reference forms', () => {
  assert.equal(assetName(`asset://${hash}`), hash)
  for (const url of ['asset://..', 'asset://.', 'asset://a/b', 'asset://', '/x', 1, null]) {
    assert.equal(assetName(url), null, String(url))
  }
  for (const url of ['https://example.com/a.glb', 'http://localhost:3000/assets/a.js?v=1#x']) {
    assert.equal(isHttpURL(url), true, url)
    assert.equal(isBlueprintURL(url), true, url)
  }
  // the loader fetches only the literal lower-case prefix; other spellings are not remote URLs to it
  for (const url of [
    'HTTPS://example.com/a.glb',
    'https:example.com/a.glb',
    'https:/example.com/a.glb',
    '//example.com/a.glb',
    'example.com/a.glb',
    'https://',
    'https://exa mple.com/a.glb',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,x',
    'blob:http://localhost/x',
    '',
  ]) {
    assert.equal(isHttpURL(url), false, url)
    assert.equal(isBlueprintURL(url), false, url)
  }
})
