import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'
import { chatEnvelope, cutText, CHAT_BODY_MAX_LENGTH } from '../src/core/extras/chatPolicy.js'
import { sanitizeName, sanitizePlayerSelfModify } from '../src/core/extras/entityModifyPolicy.js'
import { normalizeSettingValue } from '../src/core/extras/settingsPolicy.js'
import { writeClientPacket } from '../src/core/packets.js'
import { strictDecode } from '../src/core/extras/strictDecode.js'

const decode = packet => strictDecode(packet, { maxNodes: 8192, build: true }).value[1]

test('chatEnvelope: bounded known fields, object bodies refused, number bodies converted', () => {
  assert.equal(chatEnvelope({ body: {} }), null)
  assert.equal(chatEnvelope({ body: ['text'] }), null)
  assert.equal(chatEnvelope({ body: null }), null)
  assert.equal(chatEnvelope({ body: '   ' }), null)
  assert.deepEqual(chatEnvelope({ body: 42 }), { body: '42' })
  assert.deepEqual(chatEnvelope({ body: 0 }), { body: '0' })
  const msg = {
    body: '界'.repeat(10000),
    id: '界'.repeat(10000),
    fromId: '界'.repeat(10000),
    from: '界'.repeat(10000),
    createdAt: '界'.repeat(10000),
    extra: 'x'.repeat(10000),
  }
  const safe = chatEnvelope(msg)
  assert.equal(safe.body.length, 500)
  for (const key of ['id', 'fromId', 'from', 'createdAt']) assert.equal(safe[key].length, 64)
  assert.equal(Object.hasOwn(safe, 'extra'), false)
  assert.ok(writeClientPacket('chatAdded', safe).length < 3 * 1024)
  assert.deepEqual(chatEnvelope({ body: 'hi', from: {}, id: 1, fromId: null, createdAt: [] }), { body: 'hi' })
})

test('Chat.add: listeners, storage, bubble, events and broadcast all receive the same bounded envelope', () => {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const world = clientWorld()
  const emitted = []
  const bubbles = []
  const listened = []
  world.events = { emit: (...args) => emitted.push(args) }
  world.entities.getPlayer = () => ({ chat: text => bubbles.push(text) })
  const chat = new Chat(world)
  chat.listeners.add(msgs => listened.push(msgs))
  const msg = { id: 'id', createdAt: 'now', body: ' x '.repeat(1000), from: 'n'.repeat(100), fromId: 'p', secret: true }
  const expected = chatEnvelope(msg)
  chat.add(msg, true)
  assert.deepEqual(chat.msgs, [expected])
  assert.deepEqual(listened, [[expected]])
  assert.deepEqual(bubbles, [expected.body])
  assert.deepEqual(emitted, [['chat', expected]])
  assert.ok(Object.isFrozen(emitted[0][1]))
  assert.deepEqual(decode(world.packets[0]), expected)
  assert.equal(msg.body.length, 3000, 'input is not mutated')
  chat.add({ body: { bad: true } }, true)
  assert.equal(chat.msgs.length, 1)
  assert.equal(listened.length, 1)
  assert.equal(emitted.length, 1)
  assert.equal(bubbles.length, 1)
  assert.equal(world.packets.length, 1)
  chat.add({ body: 0 }, true)
  assert.equal(chat.msgs[1].body, '0')
  assert.ok(chat.msgs[1].id && chat.msgs[1].createdAt)
})

test('Chat.command: text is cut before callbacks, parsing, events and sending', () => {
  const Chat = loadClient('core/systems/Chat.js', 'Chat')
  const world = clientWorld()
  const emitted = []
  world.events = { emit: (...args) => emitted.push(args) }
  const chat = new Chat(world)
  const text = '/echo ' + '😀'.repeat(1000)
  chat.command(text)
  const data = decode(world.packets[0])
  assert.equal(data.value, cutText(text, CHAT_BODY_MAX_LENGTH).slice(6))
  assert.deepEqual(emitted[0], ['command', { playerId: 'player', ...data }])
  let called
  chat.bindCommand('echo', action => {
    called = action
  })
  chat.command(text)
  assert.equal(called.value, data.value)
  assert.equal(world.packets.length, 1)
})

test('PlayerLocal: name and effects match the server policy before any local effect or send', () => {
  const Player = loadClient('core/entities/PlayerLocal.js', 'PlayerLocal')
  const world = clientWorld()
  const player = Object.assign(Object.create(Player.prototype), {
    world,
    data: { id: 'p', name: 'old', effect: null },
    modify(data) {
      Object.assign(this.data, data)
    },
  })
  player.setName('n'.repeat(100))
  assert.equal(player.data.name, sanitizeName('n'.repeat(100)))
  assert.equal(decode(world.packets[0]).name, player.data.name)
  player.setName({ bad: true })
  assert.equal(world.packets.length, 1)
  let ended = 0
  const effect = { duration: 4, emote: 'asset://emote-float.glb', freeze: true }
  const safe = sanitizePlayerSelfModify({ ef: effect }, 'p')
  player.setEffect(effect, () => ended++)
  assert.deepEqual(player.data.effect, safe.ef)
  assert.deepEqual(decode(world.packets[1]), safe)
  for (const invalid of [{ duration: Infinity }, { text: 'x'.repeat(9000) }, { fn() {} }]) player.setEffect(invalid)
  assert.equal(ended, 0)
  assert.equal(player.data.effect, effect)
  assert.equal(world.packets.length, 2)
  player.setEffect(null)
  assert.equal(player.data.effect, null)
  assert.equal(ended, 1)
})

test('player proxy: invalid effect fields cannot apply or replace an active effect', () => {
  const createProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy')
  const world = clientWorld()
  const effects = []
  const player = { world, data: { id: 'p' }, setEffect: (...args) => effects.push(args) }
  const proxy = createProxy({}, player)
  const effect = { freeze: true, duration: 5 }
  const active = proxy.applyEffect(effect)
  assert.equal(active.active, true)
  assert.deepEqual(effects[0][0], sanitizePlayerSelfModify({ ef: effect }, 'p').ef)
  for (const opts of [{ snare: Infinity }, { emote: 'x'.repeat(9000) }, { turn: () => {} }]) {
    assert.equal(proxy.applyEffect(opts), undefined)
  }
  assert.equal(active.active, true)
  assert.equal(effects.length, 1)
})

test('Settings.set: client values exactly match the shared settings normalizer before mutation/broadcast', () => {
  const Settings = loadClient('core/systems/Settings.js', 'Settings')
  const world = clientWorld()
  const settings = new Settings(world)
  for (const [key, value] of [
    ['title', 'x'.repeat(300)],
    ['desc', 'x'.repeat(3000)],
    ['image', { type: 'texture', name: 'x'.repeat(300), url: 'x'.repeat(3000), extra: true }],
    ['avatar', { type: 'avatar', name: 'x', url: 'x'.repeat(3000) }],
    ['customAvatars', false],
  ]) {
    settings.set(key, value, true)
    assert.deepEqual(settings[key], normalizeSettingValue(key, value).value)
    assert.deepEqual(decode(world.packets.at(-1)), { key, value: settings[key] })
  }
  const count = world.packets.length
  assert.equal(settings.set('title', {}, true), false)
  assert.equal(settings.title.length, 256)
  assert.equal(world.packets.length, count)
})
