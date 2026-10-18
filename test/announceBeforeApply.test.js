import { makeNetwork } from './lib/networkHarness.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { cloneDeep } from 'lodash-es'
import fs from 'node:fs'
import { readInboundPacket } from '../src/server/inboundDecode.js'
import { loadClient, clientWorld } from './lib/clientHarness.mjs'

const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
  fs: { readFileSync: () => '' },
  path,
  __dirname: '.',
  hashFile: async () => 'hash',
  console: { log() {} },
  process: { env: {} },
})

for (const action of ['create', 'edit', 'fix', 'classify']) {
  test(`announce before apply: ServerAI ${action} broadcasts before modifying`, async () => {
    const calls = []
    const blueprint = { id: 'bp', version: 7, script: 'asset://old.js' }
    const network = makeNetwork()
    network.send = (...args) => {
      assert.equal(JSON.parse(network.dirtyBlueprints.get('bp').record.data).version, 8)
      calls.push(args)
    }
    const world = {
      blueprints: {
        get: () => blueprint,
        modify(change) {
          assert.deepEqual(calls, [['blueprintModified', change]])
          calls.push(['apply', change])
        },
      },
      network,
      loader: { get: () => ({ code: 'app.on("init", () => {})' }) },
    }
    const ai = new ServerAI(world)
    ai.client = { [action]: async () => (action === 'classify' ? 'name' : 'app.send("init", {})') }
    ai.assets = { upload: async () => {} }
    if (action === 'create') ai.classify = () => {}
    await ai[action]({ blueprintId: 'bp', appId: 'app', prompt: 'prompt', error: {} })
    assert.equal(calls.length, 2)
    assert.equal(calls[0][1].version, 8)
    assert.deepEqual([...world.network.dirtyBlueprints.keys()], ['bp'])
  })
}

test('announce before apply: ClientBuilder unlink sends its blueprint and entity change before applying', () => {
  // Exercise the existing unlink branch with the real client registry and packet encoder.
  const source = fs.readFileSync(new URL('../src/core/systems/ClientBuilder.js', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf('    // unlink\n'), source.indexOf('    // pin/unpin\n'))
  assert.ok(branch.includes('entity.modify(change)'))
  const unlink = new Function('uuid', 'cloneDeep', 'preflightPacket', branch)
  const world = clientWorld()
  const entity = {
    isApp: true,
    blueprint: { id: 'old', version: 0, props: {} },
    data: { id: 'app' },
    modify(change) {
      const packets = world.packets.map(packet => readInboundPacket(packet))
      assert.deepEqual(
        packets.map(([name]) => name),
        ['onBlueprintAdded', 'onEntityModified']
      )
      assert.deepEqual(packets[1][1], change)
      assert.equal(packets[0][1].id, change.blueprint)
    },
  }
  let applied = 0
  const modify = entity.modify
  entity.modify = change => {
    modify(change)
    applied++
  }
  unlink.call(
    { world, selected: entity, control: { keyU: { pressed: true } }, beam: { active: true }, select() {} },
    () => 'new',
    cloneDeep,
    (w, name, data) => w.network.fits(name, data)
  )
  assert.equal(applied, 1)
  assert.deepEqual(world.toasts, ['Unlinked'])
})
