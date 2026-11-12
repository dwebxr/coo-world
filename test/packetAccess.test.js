// Who may send what, at the level of names (test/lib/packetAccess.mjs): every packet of the registry has a rule, and
// the rules agree with which handlers the server has. This is the one part of the rules read from source text (the
// inventory of `on<Name>` methods); what each handler does with a sender below the rank is asked of the handlers
// themselves in test/packetRefusals.test.js, and of a running server in test/e2e/access-control.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { packetMethodById, packetNameById } from '../src/core/packets.js'
import { BUILDER_ONLY_PACKETS } from '../src/core/extras/inboundPolicy.js'
import { ADMIN_SETTING_KEYS, BUILDER_SETTING_KEYS } from '../src/core/extras/settingsPolicy.js'
import { fixture, settle } from './lib/joinFixture.mjs'
import {
  CLASSES,
  HANDLED,
  OTHER_COVER,
  PACKET_RULES,
  WORLD_CONFIG,
  checkPacketRules,
  isHandled,
  namedCases,
  namesOfClass,
  rulesOf,
} from './lib/packetAccess.mjs'

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const source = read('src/core/systems/ServerNetwork.js')

// the registry, through its own lookups: ids count up from 0 without a gap
const registry = []
for (let id = 0; packetNameById(id) !== undefined; id++)
  registry.push({ name: packetNameById(id), method: packetMethodById(id) })
const names = registry.map(entry => entry.name)

// a method of the ServerNetwork class, as written (the same cut test/lib/networkHarness.mjs makes)
const methodSource = method => source.match(new RegExp(`^  (?:async )?${method}(?:\\(| = )[^]*?^  }`, 'm'))?.[0] ?? null
const handlers = registry.filter(entry => methodSource(entry.method)).map(entry => entry.name)

test('the registry was read, and a packet goes to the method of its name and nowhere else', async () => {
  assert.equal(names.length, 41, 'a packet was added or removed: give it a rule in test/lib/packetAccess.mjs')
  assert.equal(new Set(names).size, names.length)
  assert.ok(handlers.length > 25, `handlers found (${handlers.length})`)
  // so a name is handled exactly when the server has its `on<Name>`: each name, sent by a builder (whom the inbound
  // gate lets through), reaches the method the registry gives it
  const f = fixture()
  const reached = []
  for (const { name, method } of registry) f.network[method] = () => reached.push(name)
  for (const name of names) f.send(name, null)
  await settle()
  assert.deepEqual(reached, names)
})

test('every packet name has a rule, and the rules agree with the handlers the server has', () => {
  assert.deepEqual(checkPacketRules({ names, handlers }), [])
  // spelled out for the two directions
  for (const name of names) {
    assert.equal(isHandled(name), handlers.includes(name), `${name}: the table and the server disagree about a handler`)
  }
  assert.deepEqual(
    namesOfClass('no-handler'),
    names.filter(name => !handlers.includes(name)),
    'the names without a handler'
  )
})

test('every `on…` method of the server is a packet handler or one of the three that are not', () => {
  const methods = [...source.matchAll(/^ {2}(?:async )?(on[A-Z]\w*)(?:\(| = )/gm)].map(match => match[1])
  const byPacket = new Set(registry.map(entry => entry.method))
  const others = methods.filter(method => !byPacket.has(method))
  // none of these is the method of a registered name, so no packet can call them
  assert.deepEqual(others.sort(), ['onConnection', 'onDisconnect', 'onTipResult'])
})

test('the check itself: a new name, a stale rule, a handler without a rule and a rule without a handler all fail', () => {
  const rules = { ping: PACKET_RULES.ping, pong: PACKET_RULES.pong }
  const ok = { names: ['ping', 'pong'], handlers: ['ping'] }
  assert.deepEqual(checkPacketRules(ok, rules), [])
  assert.deepEqual(checkPacketRules({ names: ['ping', 'pong', 'newPacket'], handlers: ['ping'] }, rules), [
    'newPacket is in the registry and has no rule',
  ])
  assert.deepEqual(checkPacketRules({ names: ['ping'], handlers: ['ping'] }, rules), [
    'pong has a rule and is not in the registry',
  ])
  assert.deepEqual(checkPacketRules({ names: ['ping', 'pong'], handlers: ['ping', 'pong'] }, rules), [
    'pong has a handler on the server and no rule for it',
  ])
  assert.deepEqual(checkPacketRules({ names: ['ping', 'pong'], handlers: [] }, rules), [
    'ping is said to be handled and the server has no handler',
  ])
  assert.deepEqual(checkPacketRules(ok, { ...rules, pong: [] }), ['pong has no rule'])
  assert.deepEqual(checkPacketRules(ok, { ...rules, pong: [{ class: 'everyone', what: 'x', e2e: 'y' }] }), [
    'pong: everyone is not a class',
  ])
  assert.deepEqual(checkPacketRules(ok, { ...rules, pong: [{ class: 'no-handler', what: 'x' }] }), [
    'pong: a rule that no case and no test tries',
  ])
  assert.deepEqual(
    checkPacketRules(ok, { ...rules, ping: [...rules.ping, { class: 'no-handler', what: 'x', e2e: 'y' }] }),
    ['ping is said to be handled and to have no handler']
  )
  // a name that is a property of every object is not a rule
  assert.equal(rulesOf('constructor'), null)
  assert.equal(isHandled('toString'), false)
})

test('builder: the inbound gate refuses three of them before a handler runs, and only names every rule of which is a builder rule', () => {
  assert.deepEqual([...BUILDER_ONLY_PACKETS].sort(), ['ai', 'blueprintAdded', 'blueprintModified'])
  for (const name of BUILDER_ONLY_PACKETS) {
    assert.deepEqual(
      PACKET_RULES[name].map(rule => rule.class),
      ['builder'],
      `${name} is refused at the gate for everyone but builders: it can have no rule that lets anyone else send it`
    )
  }
})

test("the settings the table names for builders and for admins are the policy's", () => {
  assert.deepEqual([...ADMIN_SETTING_KEYS].sort(), ['customAvatars', 'rank'])
  assert.deepEqual([...BUILDER_SETTING_KEYS].sort(), ['ao', 'avatar', 'desc', 'image', 'playerLimit', 'title', 'voice'])
  const rule = kind => PACKET_RULES.settingsModified.find(entry => entry.class === kind).what
  assert.deepEqual(rule('admin-setting').split(', ').sort(), [...ADMIN_SETTING_KEYS].sort())
  assert.deepEqual(rule('builder').split(', ').sort(), [...BUILDER_SETTING_KEYS].sort())
})

test('the cases and tests the rules name exist', () => {
  const all = [...Object.values(PACKET_RULES).flat(), ...WORLD_CONFIG, ...OTHER_COVER]
  for (const rule of all) {
    assert.ok(Object.prototype.hasOwnProperty.call(CLASSES, rule.class), rule.what)
    if (!rule.cover) continue
    const { file, has: text } = rule.cover
    assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `${file} (${rule.what})`)
    assert.ok(read(file).includes(text), `${file} no longer contains ${JSON.stringify(text)} (${rule.what})`)
  }
  // every case the tables name is a case the suite runs: `await run('<id>', …)` (the suite checks the other
  // direction itself when it ends, and that each one ran)
  const suite = read('test/e2e/access-control.mjs')
  const ran = [...suite.matchAll(/await run\(\s*'([a-z-]+)'/g)].map(match => match[1])
  assert.deepEqual([...new Set(ran)].sort(), namedCases())
  assert.equal(HANDLED.includes('no-handler'), false)
  assert.equal(HANDLED.length, Object.keys(CLASSES).length - 1)
})
