// src/server/aiBudget.js: how many AI generations run and for whom, what an `ai` request may hold, and the real
// ServerAI and ServerNetwork entry points that use it.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AI_ERROR_FALLBACK,
  AI_LIMIT_DEFAULTS,
  AI_REFUSALS,
  AI_TEXT_MAX_LENGTH,
  createAiBudget,
  readAiAction,
  readAiLimitsEnv,
} from '../src/server/aiBudget.js'
import { serializeError } from '../src/core/extras/serializeError.js'
import { writeClientPacket } from '../src/core/packets.js'
import { readInboundPacket } from '../src/server/inboundDecode.js'
import { loadClient } from './lib/clientHarness.mjs'
import { makeNetwork } from './lib/networkHarness.mjs'

const HOUR = 60 * 60 * 1000

function budget(limits) {
  let time = 0
  return { b: createAiBudget(limits, { now: () => time }), advance: ms => (time += ms) }
}

test('limits from the environment: defaults, whole numbers of at least 1, anything else refuses to start', () => {
  assert.deepEqual(readAiLimitsEnv({}), { ...AI_LIMIT_DEFAULTS })
  assert.equal(AI_LIMIT_DEFAULTS.maxSeconds, 600, 'ten minutes for one action, by default')
  assert.deepEqual(
    readAiLimitsEnv({
      AI_MAX_PER_USER_PER_HOUR: '5',
      AI_MAX_PER_HOUR: '9',
      AI_MAX_CONCURRENT: '3',
      AI_MAX_SECONDS: '30',
    }),
    { perUserConcurrent: 1, perUserPerHour: 5, concurrent: 3, perHour: 9, maxSeconds: 30 }
  )
  assert.deepEqual(readAiLimitsEnv({ AI_MAX_PER_HOUR: '' }), { ...AI_LIMIT_DEFAULTS }, 'blank is unset')
  for (const bad of ['0', '-1', '1.5', 'many', 'Infinity', ' ']) {
    assert.throws(() => readAiLimitsEnv({ AI_MAX_PER_HOUR: bad }), /AI_MAX_PER_HOUR must be a whole number/, bad)
    assert.throws(() => readAiLimitsEnv({ AI_MAX_SECONDS: bad }), /AI_MAX_SECONDS must be a whole number/, bad)
  }
  // a longer timer would fire at once in Node.js
  assert.equal(readAiLimitsEnv({ AI_MAX_SECONDS: '86400' }).maxSeconds, 86400)
  assert.throws(() => readAiLimitsEnv({ AI_MAX_SECONDS: '86401' }), /AI_MAX_SECONDS .* at most 86400/)
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

test('the table of builders is bounded: keys an hour old are forgotten as new ones come', () => {
  const { b, advance } = budget({ perUserPerHour: 1, concurrent: 1, perHour: 1e9 })
  let started = 0
  for (let i = 0; i < 6000; i++) {
    const place = b.start(`user-${i}`)
    if (place.ok) started++
    place.done?.()
    advance(1000)
  }
  assert.equal(started, 6000, 'over 100 minutes, every new builder had a place')
  assert.ok(b.stats().users <= 4096, `users kept: ${b.stats().users}`)
})

test('the table of builders is bounded within one hour too: a new key is refused, none is forgotten early', () => {
  // a world that allows more starts an hour than the table holds keys
  const { b, advance } = budget({ perUserPerHour: 5, concurrent: 10000, perHour: 10000 })
  const reasons = {}
  for (let i = 0; i < 6000; i++) {
    const place = b.start(`user-${i}`)
    if (place.ok) place.done()
    else reasons[place.reason] = (reasons[place.reason] || 0) + 1
    advance(100)
  }
  assert.deepEqual(reasons, { world_full: 6000 - 4096 })
  assert.equal(AI_REFUSALS.world_full, 'The AI is busy with other requests. Try again later.')
  assert.equal(b.stats().users, 4096)
  assert.equal(b.stats().lastHour, 4096, 'a refused key is not charged')
  assert.equal(b.stats().sweeps, 1, 'the full table was scanned once, not on every arrival')
  // a key already counted keeps its place and its hour (it is not forgotten to make room)
  b.start('user-0').done()
  assert.equal(b.stats().users, 4096)
  // user-0 started again; user-1 (0.1 s) is the first key whose hour can pass
  advance(HOUR - 6000 * 100)
  assert.equal(b.start('late-1').reason, 'world_full', 'user-1 has 0.1 s left')
  assert.equal(b.start('late-1').reason, 'world_full')
  assert.equal(b.stats().sweeps, 2, 'one scan at the time a key could have been forgotten, none after it')
  advance(100)
  assert.equal(b.start('late-2').ok, true, 'user-1 is forgotten')
  assert.equal(b.stats().sweeps, 3)
  assert.equal(b.stats().users, 4096)
})

test('a key that ran past the end of its hour is forgotten when it ends', () => {
  const { b, advance } = budget({ perUserPerHour: 5, concurrent: 5, perHour: 100 })
  const place = b.start('user:slow')
  b.start('user:other').done()
  advance(HOUR + 1)
  assert.equal(b.stats().users, 2)
  place.done()
  assert.equal(b.stats().users, 1, 'user:slow has nothing left to count')
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
        lineNumber: 'x',
        extra: 'dropped',
      },
    }),
    {
      name: 'fix',
      blueprintId: 'bp',
      appId: 'app',
      error: { name: 'TypeError', message: 'boom', stack: 's'.repeat(AI_TEXT_MAX_LENGTH), code: 7 },
    }
  )
  // a crashed script's error needs nothing in it: what says nothing is described by a fixed text
  for (const [given, error] of [
    [{}, { message: AI_ERROR_FALLBACK }],
    [{ name: 'TypeError' }, { name: 'TypeError', message: AI_ERROR_FALLBACK }],
    [{ message: 7 }, { message: AI_ERROR_FALLBACK }],
    [{ message: '' }, { message: AI_ERROR_FALLBACK }],
    [
      { message: '', stack: 'at x' },
      { message: '', stack: 'at x' },
    ],
    [
      { code: { nested: 1 }, lineNumber: NaN, columnNumber: 4, fileName: 'f.js' },
      { fileName: 'f.js', columnNumber: 4, message: AI_ERROR_FALLBACK },
    ],
    // one level of cause; the cause's own cause is dropped
    [
      { message: 'a', cause: { message: 'b', code: 'E_B', cause: { message: 'c' } } },
      { message: 'a', cause: { message: 'b', code: 'E_B' } },
    ],
  ]) {
    assert.deepEqual(readAiAction({ name: 'fix', blueprintId: 'bp', error: given }).error, error, JSON.stringify(given))
  }
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
    { name: 'fix', blueprintId: 'bp', error: null },
    { name: 'fix', blueprintId: 'bp', error: [] },
    { name: 'fix', blueprintId: 'bp' },
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

// what an `ai` packet holds once the server has decoded it (the client's encoder, the server's strict decoder)
const throughNetwork = action => readInboundPacket(writeClientPacket('ai', action))[1]

test('a fix of what a script really throws is read: serializeError output, through the packet codec', () => {
  const fix = error => readAiAction(throughNetwork({ name: 'fix', blueprintId: 'bp', appId: 'app', error }))
  const thrown = [
    '',
    'boom',
    0,
    null,
    undefined,
    {},
    { code: 'E_BAD' },
    new Error(''),
    Object.assign(new Error('bad'), { code: 'E_X', lineNumber: 3 }),
    new Error('outer', { cause: new Error('inner', { cause: new Error('deepest') }) }),
  ]
  for (const value of thrown) {
    const request = fix(serializeError(value))
    assert.ok(request, `${typeof value} ${String(value)}`)
    assert.ok(request.error.message || request.error.stack, `${typeof value} ${String(value)}: described`)
  }
  assert.deepEqual(fix(serializeError('')).error, { message: AI_ERROR_FALLBACK })
  assert.deepEqual(fix(serializeError({ code: 'E_BAD' })).error, {
    name: 'Error',
    code: 'E_BAD',
    message: AI_ERROR_FALLBACK,
  })
  assert.deepEqual(fix(serializeError('boom')).error, { message: 'boom' })
  const coded = fix(serializeError(Object.assign(new Error('bad'), { code: 'E_X', lineNumber: 3 }))).error
  assert.equal(coded.code, 'E_X')
  assert.equal(coded.lineNumber, 3)
  const chained = fix(serializeError(new Error('outer', { cause: new Error('inner', { cause: new Error('x') }) })))
  assert.equal(chained.error.cause.message, 'inner')
  assert.equal(chained.error.cause.cause, undefined, 'one level of cause')
})

test("a fix in ClientAI's cut-down form (an error too large for the packet) is read", async t => {
  t.mock.method(console, 'log', () => {})
  const ClientAI = loadClient('core/systems/ClientAI.js', 'ClientAI')
  const sent = []
  let entity
  const world = {
    builder: { canBuild: () => true, getEntityAtReticle: () => entity },
    network: {
      // the client's own check: the packet fits the server's limit for `ai`
      fits: (name, data) => writeClientPacket(name, data).length <= 64 * 1024,
      send: (name, data) => sent.push([name, data]),
    },
  }
  const ai = new ClientAI(world)
  ai.enabled = true
  const huge = 'x'.repeat(200000)
  for (const value of [
    Object.assign(new Error(''), { stack: huge }),
    huge,
    // nothing but a large code: the cut-down form keeps name, message and stack only, so { name: 'Error' }
    { code: huge },
  ]) {
    entity = {
      isApp: true,
      blueprint: { scene: false },
      data: { blueprint: 'bp', id: 'app' },
      scriptError: serializeError(value),
    }
    sent.length = 0
    await ai.fix()
    assert.equal(sent.length, 1)
    const request = readAiAction(throughNetwork(sent[0][1]))
    assert.ok(request, 'read')
    assert.ok(request.error.message || request.error.stack, 'described')
  }
  assert.deepEqual(readAiAction(throughNetwork(sent[0][1])).error, { name: 'Error', message: AI_ERROR_FALLBACK })
})

test('/create without a description places nothing (the server would refuse it and its placeholder would stay)', async t => {
  t.mock.method(console, 'error', () => {})
  const ClientAI = loadClient('core/systems/ClientAI.js', 'ClientAI')
  const added = []
  const sent = []
  const world = {
    builder: { canBuild: () => true },
    blueprints: { add: blueprint => added.push(blueprint) },
    network: { send: (name, data) => sent.push([name, data]) },
  }
  const ai = new ClientAI(world)
  ai.enabled = true
  for (const value of ['', '   ']) await ai.create({ value })
  assert.deepEqual(added, [])
  assert.deepEqual(sent, [])
})

// A world of stand-ins for ServerAI: blueprints and apps by id, what is sent, changed, removed and uploaded
function makeWorld() {
  const blueprints = new Map()
  const apps = new Map()
  const sent = []
  const modified = []
  const removed = []
  const world = {
    blueprints: {
      get: id => blueprints.get(id),
      canFit: () => true,
      modify: change => {
        modified.push(change)
        blueprints.set(change.id, { ...blueprints.get(change.id), ...change })
      },
    },
    entities: {
      items: apps,
      get: id => apps.get(id),
      remove: id => {
        removed.push(id)
        apps.delete(id)
      },
    },
    network: { stopping: false, markBlueprintDirty() {}, send: (name, data) => sent.push([name, data]) },
    loader: { get: () => ({ code: 'old()' }) },
  }
  return { world, blueprints, apps, sent, modified, removed }
}

// The real ServerAI in that world, with a provider client that answers when the test says and a deadline timer
// the test fires. With `stub`, create, edit and fix themselves wait for the test instead.
function makeAI(env = {}, { stub = false } = {}) {
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
  const stage = makeWorld()
  const timers = []
  const ai = new ServerAI(stage.world, {
    now: () => 0,
    setTimer: (fire, ms) => {
      const timer = { fire, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => {
      if (timer) timer.cleared = true
    },
  })
  ai.enabled = true
  const uploads = []
  ai.assets = { upload: async file => uploads.push(file) }
  // provider requests: { name, args, signal, resolve, reject }
  const asks = []
  ai.client = {}
  for (const name of ['create', 'edit', 'fix', 'classify']) {
    ai.client[name] = (...args) =>
      new Promise((resolve, reject) => asks.push({ name, args, signal: args.at(-1)?.signal, resolve, reject }))
  }
  const waiting = []
  if (stub) {
    for (const name of ['create', 'edit', 'fix']) {
      ai[name] = request => new Promise((resolve, reject) => waiting.push({ name, request, resolve, reject }))
    }
  }
  // how many times a place was given back
  const given = { back: 0 }
  const start = ai.budget.start
  ai.budget.start = key => {
    const place = start(key)
    if (!place.ok) return place
    return {
      ok: true,
      done: () => {
        given.back++
        place.done()
      },
    }
  }
  return { ai, asks, waiting, timers, uploads, given, ...stage }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick()
}
const ask = (asks, name) => asks.find(entry => entry.name === name)

test('ServerAI.onAction: a request is started once, bounded, and its place is given back when it ends or fails', async t => {
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  t.mock.method(console, 'error', () => {})
  const { ai, waiting } = makeAI({}, { stub: true })
  const action = {
    name: 'edit',
    blueprintId: 'bp',
    appId: 'app',
    prompt: 'secret prompt '.repeat(AI_TEXT_MAX_LENGTH),
    junk: {},
  }
  assert.equal(ai.onAction(action, 'user:a'), null, 'started')
  // the accepted request is logged with what it is and who it is counted against, and nothing of the prompt
  assert.deepEqual(lines, ['[ai] edit for "user:a"'])
  await tick()
  assert.equal(waiting.length, 1)
  assert.deepEqual(Object.keys(waiting[0].request).sort(), ['appId', 'blueprintId', 'name', 'prompt'])
  assert.equal(waiting[0].request.prompt.length, AI_TEXT_MAX_LENGTH)
  assert.equal(ai.onAction(action, 'user:a'), AI_REFUSALS.user_busy)
  assert.equal(ai.onAction({ name: 'nope' }, 'user:b'), AI_REFUSALS.invalid)
  assert.equal(ai.onAction(null, 'user:b'), AI_REFUSALS.invalid)
  assert.equal(ai.onAction({ ...action, name: 'toString' }, 'user:b'), AI_REFUSALS.invalid, 'not a method name')
  assert.equal(lines.length, 1, 'a refused request is not logged as started')
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
  assert.ok(lines.every(line => !line.includes('secret')))
})

test('ServerAI.onAction: the world limits hold across builders; with AI off nothing is started or said', async t => {
  t.mock.method(console, 'log', () => {})
  const { ai, waiting } = makeAI({ AI_MAX_CONCURRENT: '2', AI_MAX_PER_HOUR: '3' }, { stub: true })
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
  const off = makeAI({}, { stub: true })
  off.ai.enabled = false
  assert.equal(off.ai.onAction(action, 'user:1'), null)
  await tick()
  assert.equal(off.waiting.length, 0)
  assert.throws(() => makeAI({ AI_MAX_PER_HOUR: 'lots' }), /AI_MAX_PER_HOUR/)
})

test('ServerAI create: the place is held until both the script and its name have settled, whichever fails', async t => {
  t.mock.method(console, 'log', () => {})
  const errors = []
  t.mock.method(console, 'error', line => errors.push(line))
  const action = { name: 'create', blueprintId: 'bp', appId: 'app', prompt: 'a cube' }
  // [which settles first, how, then the other, how]
  for (const [first, firstEnds, second, secondEnds] of [
    ['create', 'resolve', 'classify', 'resolve'],
    ['create', 'reject', 'classify', 'resolve'],
    ['classify', 'reject', 'create', 'resolve'],
    ['classify', 'resolve', 'create', 'reject'],
  ]) {
    const label = `${first} ${firstEnds}s, then ${second} ${secondEnds}s`
    const { ai, asks, blueprints, given } = makeAI()
    blueprints.set('bp', { id: 'bp', version: 0, script: null })
    errors.length = 0
    assert.equal(ai.onAction(action, 'user:a'), null)
    await settle()
    assert.deepEqual(asks.map(entry => entry.name).sort(), ['classify', 'create'], label)
    ask(asks, first)[firstEnds](firstEnds === 'resolve' ? 'Cube()' : new Error('overloaded'))
    await settle()
    assert.equal(ai.budget.stats().running, 1, `${label}: still running`)
    assert.equal(ai.onAction(action, 'user:a'), AI_REFUSALS.user_busy, label)
    ask(asks, second)[secondEnds](secondEnds === 'resolve' ? 'Cube()' : new Error('overloaded'))
    await settle()
    assert.equal(ai.budget.stats().running, 0, `${label}: given back`)
    assert.equal(given.back, 1, label)
    const failed = [first, second].filter((name, i) => [firstEnds, secondEnds][i] === 'reject')
    assert.deepEqual(
      errors,
      failed.map(name => `[ai] ${name} failed: overloaded`),
      label
    )
  }
})

test('ServerAI: an action has a deadline; at it the requests are aborted, the place given back once, a late reply ignored', async t => {
  t.mock.method(console, 'log', () => {})
  const errors = []
  t.mock.method(console, 'error', line => errors.push(line))
  assert.equal(makeAI().ai.deadlineMs, 600000, 'ten minutes by default')
  const { ai, asks, timers, blueprints, modified, sent, uploads, given } = makeAI({ AI_MAX_SECONDS: '30' })
  blueprints.set('bp', { id: 'bp', version: 0, script: null })
  assert.equal(ai.onAction({ name: 'create', blueprintId: 'bp', appId: 'app', prompt: 'a cube' }, 'user:a'), null)
  await settle()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 30000)
  assert.equal(asks.length, 2, 'the script and its name')
  assert.ok(asks.every(entry => entry.signal && !entry.signal.aborted))
  // a provider that never finishes its reply: the deadline ends the action
  timers[0].fire()
  await settle()
  assert.equal(ai.budget.stats().running, 0)
  assert.equal(given.back, 1)
  assert.ok(
    asks.every(entry => entry.signal.aborted),
    'both requests aborted'
  )
  assert.deepEqual(errors, ['[ai] create stopped: it ran past its deadline (30 s)'])
  // the replies come after it: nothing is uploaded, changed or announced
  for (const entry of asks) entry.resolve('Late()')
  await settle()
  assert.equal(uploads.length, 0)
  assert.deepEqual(modified, [])
  assert.deepEqual(sent, [])
  assert.equal(given.back, 1, 'given back once')
  assert.equal(errors.length, 1)

  // an edit whose script read ends after the deadline asks the provider nothing
  blueprints.set('bp2', { id: 'bp2', version: 0, script: 'asset://old.js' })
  let read
  ai.world.loader = { get: () => null, load: () => new Promise(resolve => (read = resolve)) }
  assert.equal(ai.onAction({ name: 'edit', blueprintId: 'bp2', appId: 'app', prompt: 'spin' }, 'user:b'), null)
  await settle()
  timers[1].fire()
  await settle()
  read({ code: 'old()' })
  await settle()
  assert.equal(asks.length, 2, 'no edit request')
  assert.equal(ai.budget.stats().running, 0)

  // an action that ends in time clears its deadline and is applied
  ai.world.loader = { get: () => ({ code: 'old()' }) }
  assert.equal(ai.onAction({ name: 'fix', blueprintId: 'bp2', appId: 'app', error: { message: 'x' } }, 'user:c'), null)
  await settle()
  ask(asks, 'fix').resolve('Fixed()')
  await settle()
  assert.equal(timers[2].cleared, true)
  assert.equal(uploads.length, 1)
  assert.deepEqual(modified, [{ id: 'bp2', version: 1, script: 'asset://hash.js' }])
  assert.equal(ai.budget.stats().running, 0)
})

test('ServerAI: a create that is refused, fails or runs out of time removes its placeholder app, and nothing else', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  // what ClientAI.create made before asking: a blueprint of its own running the placeholder script, and an app
  const placeholder = ({ blueprints, apps }, bp = 'ph', app = 'ph-app') => {
    blueprints.set(bp, { id: bp, version: 0, script: 'asset://ai.js' })
    apps.set(app, { isApp: true, data: { id: app, blueprint: bp } })
  }
  const create = { name: 'create', blueprintId: 'ph', appId: 'ph-app', prompt: 'a cube' }
  // a refused create (the builder is busy with another action)
  {
    const stage = makeAI()
    placeholder(stage)
    stage.blueprints.set('other', { id: 'other', version: 0, script: null })
    stage.ai.onAction({ name: 'edit', blueprintId: 'other', prompt: 'x' }, 'user:a')
    assert.equal(stage.ai.onAction(create, 'user:a'), AI_REFUSALS.user_busy)
    assert.deepEqual(stage.removed, ['ph-app'])
    assert.deepEqual(stage.sent, [['entityRemoved', 'ph-app']], 'announced to everyone, the requester included')
    assert.ok(stage.blueprints.get('ph'), 'the blueprint stays (there is no way to remove one)')
  }
  // refusals that name what is not this request's placeholder remove nothing
  for (const [label, prepare, action] of [
    ['an edit', placeholder, { ...create, name: 'edit' }],
    [
      'an app of another blueprint',
      stage => {
        placeholder(stage)
        placeholder(stage, 'ph2', 'ph2-app')
      },
      { ...create, appId: 'ph2-app' },
    ],
    [
      'a blueprint whose script was replaced',
      stage => {
        placeholder(stage)
        stage.blueprints.get('ph').script = 'asset://made.js'
      },
      create,
    ],
    ['a missing app', stage => stage.blueprints.set('ph', { id: 'ph', version: 0, script: 'asset://ai.js' }), create],
    [
      'a server that is stopping',
      stage => {
        placeholder(stage)
        stage.world.network.stopping = true
      },
      create,
    ],
  ]) {
    const stage = makeAI()
    prepare(stage)
    stage.blueprints.set('other', { id: 'other', version: 0, script: null })
    stage.ai.onAction({ name: 'edit', blueprintId: 'other', prompt: 'x' }, 'user:a')
    assert.equal(stage.ai.onAction(action, 'user:a'), AI_REFUSALS.user_busy, label)
    assert.deepEqual(stage.removed, [], label)
    assert.deepEqual(stage.sent, [], label)
  }
  // a refused create cannot take away the placeholder of one that runs (another builder names its ids)
  {
    const stage = makeAI({ AI_MAX_CONCURRENT: '1' })
    placeholder(stage)
    assert.equal(stage.ai.onAction(create, 'user:a'), null)
    assert.equal(stage.ai.onAction(create, 'user:b'), AI_REFUSALS.world_busy)
    assert.deepEqual(stage.removed, [])
  }
  // after the action: a failed script, the deadline, or a world without room leave no placeholder; a script that
  // arrived keeps the app. (None of it needs the requester: it may have left.)
  for (const [label, end, kept] of [
    ['the script request fails', stage => ask(stage.asks, 'create').reject(new Error('overloaded')), false],
    ['the deadline passes', stage => stage.timers[0].fire(), false],
    [
      'the world has no room for the script',
      stage => {
        stage.world.blueprints.canFit = change => !change.script
        stage.world.blueprints.budgetRefusal = () => 'blueprint'
        t.mock.method(console, 'warn', () => {})
        ask(stage.asks, 'create').resolve('Cube()')
      },
      false,
    ],
    ['the script arrives', stage => ask(stage.asks, 'create').resolve('Cube()'), true],
  ]) {
    const stage = makeAI()
    placeholder(stage)
    assert.equal(stage.ai.onAction(create, 'user:a'), null)
    await settle()
    ask(stage.asks, 'classify').resolve('Cube')
    await settle()
    assert.deepEqual(stage.removed, [], `${label}: not while it runs`)
    end(stage)
    await settle()
    assert.deepEqual(stage.removed, kept ? [] : ['ph-app'], label)
    assert.equal(stage.ai.budget.stats().running, 0, label)
  }
  // another builder's edit runs on the placeholder's blueprint when the create fails: the removal waits for the
  // edit, and is decided when the edit ends: removed when it left the placeholder script, kept when it made one
  for (const [label, editEnds, kept] of [
    ['the edit fails too', 'reject', false],
    ['the edit makes a script', 'resolve', true],
  ]) {
    const stage = makeAI()
    placeholder(stage)
    stage.ai.world.loader = { get: () => ({ code: 'old()' }) }
    assert.equal(stage.ai.onAction(create, 'user:a'), null)
    assert.equal(
      stage.ai.onAction({ name: 'edit', blueprintId: 'ph', appId: 'ph-app', prompt: 'spin' }, 'user:b'),
      null
    )
    await settle()
    ask(stage.asks, 'classify').resolve('Cube')
    ask(stage.asks, 'create').reject(new Error('overloaded'))
    await settle()
    assert.equal(stage.ai.budget.stats().running, 1, `${label}: the edit still runs`)
    assert.deepEqual(stage.removed, [], `${label}: not while the edit runs`)
    ask(stage.asks, 'edit')[editEnds](editEnds === 'resolve' ? 'Spun()' : new Error('overloaded'))
    await settle()
    assert.deepEqual(stage.removed, kept ? [] : ['ph-app'], label)
    assert.equal(stage.ai.waiting.size, 0, `${label}: nothing left waiting`)
    assert.equal(stage.ai.budget.stats().running, 0, label)
  }
  // a refused create that named a running blueprint waits the same way: only apps of that blueprint, and at most
  // a few of them
  {
    const stage = makeAI({ AI_MAX_CONCURRENT: '1' })
    placeholder(stage)
    placeholder(stage, 'ph2', 'ph2-app')
    for (let i = 0; i < 9; i++) placeholder(stage, 'ph', `copy-${i}`)
    stage.ai.world.loader = { get: () => ({ code: 'old()' }) }
    const edit = { name: 'edit', blueprintId: 'ph', appId: 'ph-app', prompt: 'spin' }
    assert.equal(stage.ai.onAction(edit, 'user:a'), null)
    for (const appId of ['missing', 'ph2-app']) {
      assert.equal(stage.ai.onAction({ ...create, appId }, 'user:b'), AI_REFUSALS.world_busy)
    }
    assert.equal(stage.ai.waiting.size, 0, 'what is not an app of the blueprint does not wait')
    assert.equal(stage.ai.onAction(create, 'user:b'), AI_REFUSALS.world_busy)
    for (let i = 0; i < 9; i++) {
      assert.equal(stage.ai.onAction({ ...create, appId: `copy-${i}` }, 'user:b'), AI_REFUSALS.world_busy)
    }
    assert.equal(stage.ai.waiting.get('ph').size, 8)
    assert.deepEqual(stage.removed, [])
    await settle()
    ask(stage.asks, 'edit').reject(new Error('overloaded'))
    await settle()
    assert.deepEqual(stage.removed, ['ph-app', ...Array.from({ length: 7 }, (_, i) => `copy-${i}`)])
    assert.equal(stage.ai.waiting.size, 0)
  }
})

// The provider clients with fake SDKs and a fake fetch: what each request asks for and what a cut-off reply does
function makeClient(provider, reply) {
  const calls = []
  class OpenAI {
    constructor() {
      this.responses = {
        create: async (params, options) => {
          calls.push({ body: params, signal: options?.signal })
          return reply
        },
      }
    }
  }
  const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
    fs: { readFileSync: () => 'docs' },
    path: { join: (...parts) => parts.join('/') },
    __dirname: '.',
    process: { env: { AI_PROVIDER: provider, AI_MODEL: 'model', AI_API_KEY: 'key' } },
    Anthropic: class {},
    OpenAI,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), signal: init.signal })
      return { json: async () => reply }
    },
    anthropicEffort: () => 'low',
    anthropicRequest: () => ({}),
    readAnthropicText: () => '',
  })
  return { client: new ServerAI({}).client, calls }
}

test('every provider client sets an output limit: 16,000 tokens for a script, 4,096 for a name', async () => {
  const cases = [
    ['openai', { status: 'completed', output_text: 'Ok()' }, body => body.max_output_tokens],
    ['xai', { choices: [{ finish_reason: 'stop', message: { content: 'Ok()' } }] }, body => body.max_completion_tokens],
    [
      'google',
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Ok()' }] } }] },
      body => body.generationConfig.maxOutputTokens,
    ],
  ]
  for (const [provider, reply, limit] of cases) {
    const { client, calls } = makeClient(provider, reply)
    const signal = new AbortController().signal
    assert.equal(await client.create('a cube', { signal }), 'Ok()', provider)
    assert.equal(await client.edit('old()', 'spin', { signal }), 'Ok()', provider)
    assert.equal(await client.fix('old()', { message: 'x' }, { signal }), 'Ok()', provider)
    assert.equal(await client.classify('a cube', { signal }), 'Ok()', provider)
    assert.deepEqual(
      calls.map(call => limit(call.body)),
      [16000, 16000, 16000, 4096],
      provider
    )
    assert.ok(
      calls.every(call => call.signal === signal),
      `${provider}: the job's signal is passed on`
    )
  }
  // a reply cut off at the limit is an error, not a script
  const cutOff = [
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'app.on(' }],
    ['xai', { choices: [{ finish_reason: 'length', message: { content: 'app.on(' } }] }],
    ['google', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'app.on(' }] } }] }],
  ]
  for (const [provider, reply] of cutOff) {
    const { client } = makeClient(provider, reply)
    await assert.rejects(client.create('a cube'), /the AI reply was cut off/, provider)
  }
})

test('ServerNetwork.onAi: counted against the user, or the wallet of a builder by token; a refusal is said to that player', () => {
  const wallets = new Map([['token-builder', 'WALLET111']])
  const network = makeNetwork(() => {}, {
    context: { solanaGating: { walletOf: id => wallets.get(id) || null, TOKEN_GATING_ENABLED: false } },
  })
  const asked = []
  network.world.ai = {
    onAction: (...args) => {
      asked.push(args)
      return args[1] === 'user:limited' ? 'You have reached the hourly limit for AI requests. Try again later.' : null
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
  // the packet as it came, and the key, and nothing else
  assert.deepEqual(asked, [
    [action, 'user:stored-builder'],
    [action, 'wallet:WALLET111'],
  ])
  assert.equal(asked[0][0], action)
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
