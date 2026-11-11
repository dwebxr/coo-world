import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  FALLBACK_BETA,
  anthropicEffort,
  anthropicRequest,
  readAnthropicText,
} from '../src/core/extras/anthropicRequest.js'
import { loadClient } from './lib/clientHarness.mjs'

test('anthropic request: current models get the default fallback and an effort; older models get neither', () => {
  const base = { effort: 'high', maxTokens: 16000, system: 'S', content: 'C' }
  assert.deepEqual(anthropicRequest({ ...base, model: 'claude-opus-5-5' }), {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    system: 'S',
    messages: [{ role: 'user', content: 'C' }],
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'high' },
  })
  for (const model of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5']) {
    assert.equal(anthropicRequest({ ...base, model }).fallbacks, 'default', model)
  }
  for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'e2e-mock']) {
    const params = anthropicRequest({ ...base, model })
    assert.equal('fallbacks' in params || 'betas' in params || 'output_config' in params, false, model)
  }
  assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01')
})

test('anthropic request: AI_EFFORT values the API does not take fall back to medium', () => {
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(anthropicEffort(value), value)
  for (const value of ['minimal', '', undefined, 'HIGH', 'none']) assert.equal(anthropicEffort(value), 'medium')
  assert.deepEqual(anthropicRequest({ model: 'claude-opus-5-5', effort: 'minimal', maxTokens: 1 }).output_config, {
    effort: 'medium',
  })
})

test('anthropic response: text is read by block type, past thinking and fallback blocks', () => {
  const response = {
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      { type: 'text', text: 'app.on(' },
      { type: 'text', text: '"update", () => {})' },
    ],
  }
  assert.equal(readAnthropicText(response), 'app.on("update", () => {})')
})

test('anthropic response: refusals, cut-off replies and replies without text are errors', () => {
  const text = [{ type: 'text', text: 'partial' }]
  assert.throws(() => readAnthropicText({ stop_reason: 'refusal', content: [] }), /declined/)
  assert.throws(() => readAnthropicText({ stop_reason: 'max_tokens', content: text }), /cut off/)
  assert.throws(
    () => readAnthropicText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] }),
    /no text/
  )
  for (const bad of [null, {}, { content: 'x' }, { content: [{ type: 'text', text: '   ' }] }]) {
    assert.throws(() => readAnthropicText(bad), /no text/)
  }
})

// ServerAI with a fake SDK: the Anthropic client sends the built request and reads the reply past thinking.
function makeAI({ env, reply, fail } = {}) {
  const calls = []
  const options = []
  const errors = []
  class Anthropic {
    constructor() {
      this.beta = {
        messages: {
          create: async (params, given) => {
            calls.push(params)
            options.push(given)
            if (fail) throw new Error(fail)
            return reply
          },
        },
      }
    }
  }
  const ServerAI = loadClient('core/systems/ServerAI.js', 'ServerAI', {
    fs: { readFileSync: () => 'DOCS' },
    path,
    __dirname: '.',
    hashFile: async () => 'hash',
    console: { log() {}, error: line => errors.push(line) },
    process: { env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', ...env } },
    Anthropic,
    OpenAI: class {},
    anthropicEffort,
    anthropicRequest,
    readAnthropicText,
  })
  return { ai: new ServerAI({}), calls, options, errors }
}

test('server ai: Claude Opus 5.5 requests carry the fallback and effort, and the script is read past thinking', async () => {
  const { ai, calls, options } = makeAI({
    env: { AI_MODEL: 'claude-opus-5-5', AI_EFFORT: 'medium' },
    reply: {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'CODE' },
      ],
    },
  })
  assert.equal(ai.enabled, true)
  const signal = new AbortController().signal
  assert.equal(await ai.client.create('a cube', { signal }), 'CODE')
  assert.equal(options[0].signal, signal, 'the request can be aborted (ServerAI.run)')
  assert.equal(calls[0].model, 'claude-opus-5-5')
  assert.equal(calls[0].max_tokens, 16000)
  assert.deepEqual(calls[0].betas, ['server-side-fallback-2026-07-01'])
  assert.equal(calls[0].fallbacks, 'default')
  assert.deepEqual(calls[0].output_config, { effort: 'medium' })
  assert.match(calls[0].system, /DOCS/)
  assert.match(calls[0].messages[0].content, /a cube/)
  // naming is a small task: low effort and a smaller limit
  assert.equal(await ai.client.classify('a cube', { signal }), 'CODE')
  assert.deepEqual(calls[1].output_config, { effort: 'low' })
  assert.equal(calls[1].max_tokens, 4096)
  assert.equal(options[1].signal, signal)
  await ai.client.edit('old()', 'spin', { signal })
  await ai.client.fix('old()', { message: 'x' }, { signal })
  assert.deepEqual(
    calls.map(call => call.max_tokens),
    [16000, 4096, 16000, 16000]
  )
  assert.ok(options.every(given => given.signal === signal))
})

test('server ai: a failed AI call is logged, not left as an unhandled rejection', async () => {
  const { ai, errors } = makeAI({ env: { AI_MODEL: 'claude-opus-5-5' }, fail: 'model not found' })
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    ai.world = { blueprints: { get: () => null } }
    await ai.onAction({ name: 'create', blueprintId: 'bp', appId: 'app', prompt: 'p' })
    for (let i = 0; i < 20 && errors.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(errors.sort(), ['[ai] classify failed: model not found', '[ai] create failed: model not found'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('server ai: edit and fix failures are logged too, with no unhandled rejection', async () => {
  const { ai, errors } = makeAI({ env: { AI_MODEL: 'claude-opus-5-5' }, fail: 'overloaded' })
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const blueprint = { id: 'bp', version: 1, script: 'asset://old.js' }
    ai.world = {
      blueprints: { get: () => blueprint },
      loader: { get: () => ({ code: 'app.on("update", () => {})' }) },
    }
    // (two builders: one builder's second request waits for the first to end, aiBudget.js)
    ai.onAction({ name: 'edit', blueprintId: 'bp', appId: 'app', prompt: 'p' }, 'user:a')
    ai.onAction({ name: 'fix', blueprintId: 'bp', appId: 'app', error: { message: 'x' } }, 'user:b')
    for (let i = 0; i < 20 && errors.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(errors.sort(), ['[ai] edit failed: overloaded', '[ai] fix failed: overloaded'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('server ai: a refused or cut-off reply replaces no script; the next request still works', async () => {
  const replies = [
    { stop_reason: 'refusal', content: [] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'app.on("upd' }] },
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'OK()' },
      ],
    },
  ]
  const { ai, calls, errors } = makeAI({ env: { AI_MODEL: 'claude-opus-5-5' } })
  ai.client.client.beta.messages.create = async params => {
    calls.push(params)
    return replies.shift()
  }
  const blueprint = { id: 'bp', version: 1, script: 'asset://old.js' }
  const uploads = []
  const modified = []
  ai.assets = { upload: async file => uploads.push(file) }
  ai.world = {
    blueprints: { get: () => blueprint, canFit: () => true, modify: change => modified.push(change) },
    loader: { get: () => ({ code: 'app.on("update", () => {})' }) },
    network: { stopping: false, markBlueprintDirty() {}, send() {} },
  }
  for (const name of ['edit', 'edit', 'edit']) {
    await ai.onAction({ name, blueprintId: 'bp', appId: 'app', prompt: 'p' })
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(errors, [
    '[ai] edit failed: the AI declined this request',
    '[ai] edit failed: the AI reply was cut off (max_tokens)',
  ])
  assert.equal(uploads.length, 1, 'only the good reply was saved')
  assert.match(await uploads[0].text(), /OK\(\)/)
  assert.equal(modified.length, 1)
  assert.equal(calls.length, 3)
})
