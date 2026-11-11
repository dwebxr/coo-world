// src/server/aiBudget.js: how many AI generations run and for whom, what an `ai` request may hold, and the real
// ServerAI and ServerNetwork entry points that use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AI_LIMIT_DEFAULTS,
  AI_REFUSALS,
  AI_TEXT_MAX_LENGTH,
  createAiBudget,
  readAiAction,
  readAiLimitsEnv,
} from '../src/server/aiBudget.js'
import { loadClient } from './lib/clientHarness.mjs'
import { makeNetwork } from './lib/networkHarness.mjs'

const HOUR = 60 * 60 * 1000

function budget(limits) {
  let time = 0
  return { b: createAiBudget(limits, { now: () => time }), advance: ms => (time += ms) }
}

test('limits from the environment: defaults, whole numbers of at least 1, anything else refuses to start', () => {
  assert.deepEqual(readAiLimitsEnv({}), { ...AI_LIMIT_DEFAULTS })
  assert.deepEqual(readAiLimitsEnv({ AI_MAX_PER_USER_PER_HOUR: '5', AI_MAX_PER_HOUR: '9', AI_MAX_CONCURRENT: '3' }), {
    perUserConcurrent: 1,
    perUserPerHour: 5,
    concurrent: 3,
    perHour: 9,
  })
  assert.deepEqual(readAiLimitsEnv({ AI_MAX_PER_HOUR: '' }), { ...AI_LIMIT_DEFAULTS }, 'blank is unset')
  for (const bad of ['0', '-1', '1.5', 'many', 'Infinity', ' ']) {
    assert.throws(() => readAiLimitsEnv({ AI_MAX_PER_HOUR: bad }), /AI_MAX_PER_HOUR must be a whole number/, bad)
  }
})

test('one builder runs one generation at a time, and a fixed number an hour', () => {
  const { b, advance } = budget({ perUserPerHour: 3, concurrent: 10, perHour: 100 })
  const first = b.start('user:a')
  assert.equal(first.ok, true)
  assert.deepEqual(b.start('user:a'), { ok: false, reason: 'user_busy' })
  assert.equal(b.start('user:b').ok, true, 'another builder is not held by it')
  first.done()
  first.done() // a second call changes nothing: the place is given back once
  assert.equal(b.stats().running, 1, 'user:b still runs')
  const second = b.start('user:a')
  assert.deepEqual(b.start('user:a'), { ok: false, reason: 'user_busy' }, 'still one at a time')
  second.done()
  b.start('user:a').done()
  assert.deepEqual(b.start('user:a'), { ok: false, reason: 'user_limit' }, 'three this hour')
  advance(HOUR - 1)
  assert.equal(b.start('user:a').reason, 'user_limit')
  advance(1)
  assert.equal(b.start('user:a').ok, true, 'an hour after the first')
})

test('the world runs a fixed number at once and an hour, whoever asks', () => {
  const { b, advance } = budget({ concurrent: 2, perHour: 5, perUserPerHour: 100 })
  const places = [b.start('user:1'), b.start('user:2')]
  assert.ok(places.every(place => place.ok))
  assert.deepEqual(b.start('user:3'), { ok: false, reason: 'world_busy' })
  places[0].done()
  assert.equal(b.start('user:3').ok, true)
  // every visitor a new user id (a world open to all): the hour's limit still holds
  places[1].done()
  let started = 3
  for (let i = 0; i < 20; i++) {
    const place = b.start(`fresh-${i}`)
    if (place.ok) {
      started++
      place.done()
    }
  }
  assert.equal(started, 5)
  assert.equal(b.start('fresh-x').reason, 'world_limit', 'five this hour, whoever they were')
  advance(HOUR)
  assert.equal(b.stats().lastHour, 0)
})

test('a refused request takes nothing: it does not count toward the hour', () => {
  const { b } = budget({ perUserPerHour: 2, concurrent: 1, perHour: 100 })
  const running = b.start('user:a')
  for (let i = 0; i < 50; i++) b.start('user:a')
  for (let i = 0; i < 50; i++) b.start('user:b')
  running.done()
  assert.equal(b.start('user:a').ok, true, 'the second of two, not refused for the fifty tries')
  assert.equal(b.stats().lastHour, 2)
})

test('the table of builders is bounded', () => {
  const { b, advance } = budget({ perUserPerHour: 1, concurrent: 1, perHour: 1e9 })
  for (let i = 0; i < 6000; i++) {
    b.start(`user-${i}`).done?.()
    advance(1000)
  }
  assert.ok(b.stats().users <= 4096 + 1, `users kept: ${b.stats().users}`)
})

test('an ai request is read into plain, bounded values, or it is not one', () => {
  assert.deepEqual(readAiAction({ name: 'create', blueprintId: 'bp', appId: 'app', prompt: 'a red cube', extra: 1 }), {
    name: 'create',
    blueprintId: 'bp',
    appId: 'app',
    prompt: 'a red cube',
  })
  assert.deepEqual(readAiAction({ name: 'edit', blueprintId: 'bp', prompt: 'x'.repeat(AI_TEXT_MAX_LENGTH + 5) }), {
    name: 'edit',
    blueprintId: 'bp',
    appId: undefined,
    prompt: 'x'.repeat(AI_TEXT_MAX_LENGTH),
  })
  assert.deepEqual(
    readAiAction({
      name: 'fix',
      blueprintId: 'bp',
      appId: 'app',
      error: {
        name: 'TypeError',
        message: 'boom',
        stack: 's'.repeat(AI_TEXT_MAX_LENGTH + 5),
        cause: { deep: {} },
        code: 7,
      },
    }),
    {
      name: 'fix',
      blueprintId: 'bp',
      appId: 'app',
      error: { name: 'TypeError', message: 'boom', stack: 's'.repeat(AI_TEXT_MAX_LENGTH) },
    }
  )
  for (const bad of [
    null,
    undefined,
    'create',
    7,
    [],
    {},
    { name: 'delete', blueprintId: 'bp', prompt: 'x' },
    { name: 'constructor', blueprintId: 'bp', prompt: 'x' },
    { name: 'create', prompt: 'x' },
    { name: 'create', blueprintId: 7, prompt: 'x' },
    { name: 'create', blueprintId: 'b'.repeat(65), prompt: 'x' },
    { name: 'create', blueprintId: 'bp', appId: {}, prompt: 'x' },
    { name: 'create', blueprintId: 'bp' },
    { name: 'create', blueprintId: 'bp', prompt: '   ' },
    { name: 'create', blueprintId: 'bp', prompt: { toString: () => 'x' } },
    { name: 'fix', blueprintId: 'bp', error: 'boom' },
    { name: 'fix', blueprintId: 'bp', error: {} },
    { name: 'fix', blueprintId: 'bp', error: { name: 'TypeError' } },
    { name: 'fix', blueprintId: 'bp', error: { message: 7 } },
  ]) {
    assert.equal(readAiAction(bad), null, JSON.stringify(bad))
  }
  // each property is read once
  let reads = 0
  readAiAction({
    get name() {
      reads++
      return 'create'
    },
    blueprintId: 'bp',
    prompt: 'x',
  })
  assert.equal(reads, 1)
})

// The real ServerAI with a provider that answers when the test says
function makeAI(env = {}) {
  const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
    fs: { readFileSync: () => 'docs' },
    path: { join: (...parts) => parts.join('/') },
    __dirname: '.',
    process: { env },
    Anthropic: class {},
    OpenAI: class {},
    toFile: () => {},
    hashFile: async () => 'hash',
    anthropicEffort: () => 'low',
    anthropicRequest: () => ({}),
    readAnthropicText: () => '',
    performance,
    File,
    Buffer,
  })
  const ai = new ServerAI({})
  const waiting = []
  const lines = []
  ai.enabled = true
  for (const name of ['create', 'edit', 'fix']) {
    ai[name] = request =>
      new Promise((resolve, reject) => {
        waiting.push({ name, request, resolve, reject })
      })
  }
  return { ai, waiting, lines }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('ServerAI.onAction: a request is started once, bounded, and its place is given back when it ends or fails', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const { ai, waiting } = makeAI()
  const action = {
    name: 'edit',
    blueprintId: 'bp',
    appId: 'app',
    prompt: 'p'.repeat(AI_TEXT_MAX_LENGTH + 100),
    junk: {},
  }
  assert.equal(ai.onAction(action, 'user:a'), null, 'started')
  await tick()
  assert.equal(waiting.length, 1)
  assert.deepEqual(Object.keys(waiting[0].request).sort(), ['appId', 'blueprintId', 'name', 'prompt'])
  assert.equal(waiting[0].request.prompt.length, AI_TEXT_MAX_LENGTH)
  assert.equal(ai.onAction(action, 'user:a'), AI_REFUSALS.user_busy)
  assert.equal(ai.onAction({ name: 'nope' }, 'user:b'), AI_REFUSALS.invalid)
  assert.equal(ai.onAction(null, 'user:b'), AI_REFUSALS.invalid)
  assert.equal(ai.onAction({ ...action, name: 'toString' }, 'user:b'), AI_REFUSALS.invalid, 'not a method name')
  await tick()
  assert.equal(waiting.length, 1, 'nothing else was started')
  // it ends: the builder may ask again; then it fails: the place is given back all the same
  waiting[0].resolve()
  await tick()
  assert.equal(ai.onAction(action, 'user:a'), null)
  await tick()
  waiting[1].reject(new Error('provider refused'))
  await tick()
  assert.equal(ai.onAction(action, 'user:a'), null)
  assert.equal(ai.budget.stats().running, 1)
})

test('ServerAI.onAction: the world limits hold across builders; with AI off nothing is started or said', async t => {
  t.mock.method(console, 'log', () => {})
  const { ai, waiting } = makeAI({ AI_MAX_CONCURRENT: '2', AI_MAX_PER_HOUR: '3' })
  const action = { name: 'create', blueprintId: 'bp', appId: 'app', prompt: 'a cube' }
  assert.equal(ai.onAction(action, 'user:1'), null)
  assert.equal(ai.onAction(action, 'user:2'), null)
  assert.equal(ai.onAction(action, 'user:3'), AI_REFUSALS.world_busy)
  await tick()
  waiting[0].resolve()
  waiting[1].resolve()
  await tick()
  assert.equal(ai.onAction(action, 'user:3'), null)
  await tick()
  waiting[2].resolve()
  await tick()
  assert.equal(ai.onAction(action, 'user:4'), AI_REFUSALS.world_limit)
  const off = makeAI()
  off.ai.enabled = false
  assert.equal(off.ai.onAction(action, 'user:1'), null)
  await tick()
  assert.equal(off.waiting.length, 0)
  assert.throws(() => makeAI({ AI_MAX_PER_HOUR: 'lots' }), /AI_MAX_PER_HOUR/)
})

test('ServerNetwork.onAi: counted against the user, or the wallet of a builder by token; a refusal is said to that player', () => {
  const wallets = new Map([['token-builder', 'WALLET111']])
  const network = makeNetwork(() => {}, {
    context: { solanaGating: { walletOf: id => wallets.get(id) || null, TOKEN_GATING_ENABLED: false } },
  })
  const asked = []
  network.world.ai = {
    onAction: (action, key) => {
      asked.push([action, key])
      return key === 'user:limited' ? 'You have reached the hourly limit for AI requests. Try again later.' : null
    },
  }
  const socket = (id, { builder = true, tokenGrantedRank = false } = {}) => {
    const sent = []
    return {
      id,
      sent,
      send: (name, data) => sent.push([name, data]),
      player: { data: { id, userId: id, tokenGrantedRank }, isBuilder: () => builder },
    }
  }
  const action = { name: 'create', blueprintId: 'bp', prompt: 'x' }
  const stored = socket('stored-builder')
  network.onAi(stored, action)
  const token = socket('token-builder', { tokenGrantedRank: true })
  network.onAi(token, action)
  assert.deepEqual(
    asked.map(([, key]) => key),
    ['user:stored-builder', 'wallet:WALLET111']
  )
  assert.deepEqual(stored.sent, [], 'a started request says nothing')
  const limited = socket('limited')
  network.onAi(limited, action)
  assert.equal(limited.sent.length, 1)
  assert.equal(limited.sent[0][0], 'chatAdded')
  assert.equal(limited.sent[0][1].kind, 'system')
  assert.match(limited.sent[0][1].body, /hourly limit/)
  // a visitor's request never reaches the AI system
  const visitor = socket('visitor', { builder: false })
  network.onAi(visitor, action)
  assert.equal(asked.length, 3)
  // nor does one made while the server is stopping
  network.stopping = true
  network.onAi(stored, action)
  assert.equal(asked.length, 3)
})
