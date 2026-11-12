// Who may send what, at the level of names (test/lib/packetAccess.mjs): every packet of the registry has a rule,
// the rules agree with which handlers the server has, and each handler's text names the check its rule says it
// makes. That last part reads source text: it shows that the check is written in the handler, not that it holds.
// Whether a visitor's packet is really refused is asked of a running server by test/e2e/access-control.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { packetMethodById, packetNameById } from '../src/core/packets.js'
import { BUILDER_ONLY_PACKETS } from '../src/core/extras/inboundPolicy.js'
import { ADMIN_SETTING_KEYS, BUILDER_SETTING_KEYS } from '../src/core/extras/settingsPolicy.js'
import { internalEvents } from '../src/core/extras/internalEvents.js'
import {
  CLASSES,
  HANDLED,
  OTHER_COVER,
  PACKET_RULES,
  REFUSED_EVENT_NAMES,
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
const handler = name => methodSource(registry.find(entry => entry.name === name).method)

test('the registry was read, and the dispatch is the one this table is about', () => {
  assert.equal(names.length, 41, 'a packet was added or removed: give it a rule in test/lib/packetAccess.mjs')
  assert.equal(new Set(names).size, names.length)
  // a decoded packet reaches `this[method]` and nothing else: a name is handled exactly when the class has the method
  assert.match(source, /const result = this\[method\]\?\.\(socket, data, meta\)/)
  assert.ok(handlers.length > 25, `handlers found (${handlers.length})`)
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

// ---- what each handler's text says ----

const has = (name, pattern, why) => assert.match(handler(name), pattern, `${name}: ${why}`)

test('builder: the handler asks for the rank before anything else it does', () => {
  for (const [name, action] of [
    ['blueprintAdded', 'add blueprint'],
    ['blueprintModified', 'modify blueprint'],
    ['entityAdded', 'add entity'],
    ['settingsModified', 'modify settings'],
    ['spawnModified', 'modify spawn'],
    ['ai', 'use ai'],
  ]) {
    assert.ok(namesOfClass('builder').includes(name), name)
    // the first statement after the stopping check
    const text = handler(name)
    const body = text.slice(text.indexOf('{') + 1)
    assert.match(
      body,
      new RegExp(
        `^\\s*if \\(this\\.stopping\\) return\\s*if \\(!this\\.requireBuilder\\(socket, '${action}'\\)\\) return`
      ),
      name
    )
  }
  // an app is changed or removed by a builder, or by the connection that holds it (the holder rule)
  has(
    'entityModified',
    /if \(socket\.player\.isBuilder\(\)\) \{\s*safe = sanitizeAppModify\(/,
    'a builder changes an app'
  )
  has(
    'entityModified',
    /if \(!mover && !uploader\) \{\s*this\.requireBuilder\(socket, 'modify entity'\)\s*return\s*\}\s*safe = sanitizeAppRelease\(/,
    'anyone else is refused, but for the app it holds, which it may only let go'
  )
  has(
    'entityRemoved',
    /const uploader = entity\.data\.uploader === socket\.id\s*if \(!uploader && !this\.requireBuilder\(socket, 'remove entity'\)\) return/,
    'a builder, or the uploader of that app'
  )
  // the three commands of a builder
  has('command', /if \(cmd === 'spawn'\) \{\s*const op = arg1\s*this\.onSpawnModified\(socket, op, meta\)/, '/spawn')
  has(
    'command',
    /if \(op === 'clear' && socket\.player\.isBuilder\(\)\) \{\s*this\.world\.chat\.clear\(true\)/,
    '/chat clear'
  )
  has('command', /if \(op === 'stats' && socket\.player\.isBuilder\(\)\) \{/, '/server stats')
  // requireBuilder is the rank and a log line, nothing else
  assert.match(
    methodSource('requireBuilder'),
    /^ {2}requireBuilder\(socket, action\) \{\s*if \(socket\.player\.isBuilder\(\)\) return true\s*this\.logOnce\(/
  )
  assert.match(methodSource('requireBuilder'), /return false\s*\}$/)
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

test('admin, and the settings only an admin may change', () => {
  has(
    'modifyRank',
    /^ {2}onModifyRank = async \(socket, data, meta\) => \{\s*if \(!socket\.player\.isAdmin\(\)\) return/,
    'an admin'
  )
  has(
    'settingsModified',
    /const result = this\.settingAllowed\(socket, key, value\)\s*if \(!result\) return/,
    'asked of settingAllowed'
  )
  const allowed = methodSource('settingAllowed')
  assert.match(allowed, /if \(!this\.requireBuilder\(socket, 'modify settings'\)\) return null/)
  assert.match(allowed, /if \(isAdminOnlySettingKey\(key\) && !socket\.player\.isAdmin\(\)\) \{[^}]*return null\s*\}/)
  // asked again when a held value is applied
  assert.match(
    methodSource('releaseSettings'),
    /const result = this\.settingAllowed\(socket, key, held\.value\)\s*if \(!result\) \{/
  )
  // the keys the table and the suite name are the ones the policy has
  assert.deepEqual([...ADMIN_SETTING_KEYS].sort(), ['customAvatars', 'rank'])
  assert.deepEqual([...BUILDER_SETTING_KEYS].sort(), ['ao', 'avatar', 'desc', 'image', 'playerLimit', 'title', 'voice'])
  const rule = kind => PACKET_RULES.settingsModified.find(entry => entry.class === kind).what
  assert.deepEqual(rule('admin-setting').split(', ').sort(), [...ADMIN_SETTING_KEYS].sort())
  assert.deepEqual(rule('builder').split(', ').sort(), [...BUILDER_SETTING_KEYS].sort())
})

test('kick and mute: the target is a player the sender outranks', () => {
  assert.deepEqual(namesOfClass('outranks').sort(), ['kick', 'mute'])
  has(
    'kick',
    /^ {2}onKick = \(socket, playerId, meta\) => \{\s*const player = this\.moderated\(socket, playerId\)\s*if \(!player\) return/,
    'moderated'
  )
  has('mute', /const player = this\.moderated\(socket, data\.playerId\)\s*if \(!player\) return/, 'moderated')
  assert.match(
    methodSource('moderated'),
    /const player = this\.world\.entities\.getPlayer\(playerId\)\s*if \(!player \|\| !socket\.player\.outranks\(player\)\) return null\s*return player/
  )
})

test('/admin: the code is asked of the gate, and a socket that keeps trying is closed', () => {
  has('command', /const adminCommand = isAdminCommand\(args\)/, 'the admin command is recognised')
  has('command', /const attempt = this\.admin\(\)\.gate\.attempt\(/, 'the code goes to the gate')
  has(
    'command',
    /if \(attempt\.reason === 'closed'\) \{\s*socket\.send\('kick', 'admin_attempts'\)\s*socket\.disconnect\(\)\s*return/,
    'closed'
  )
  // the rank is given only for an attempt the gate accepted, and the code never becomes a command event
  has(
    'command',
    /if \(attempt\.ok\) \{\s*const id = player\.data\.id\s*const granted = !player\.isAdmin\(\)/,
    'granted on ok'
  )
  has('command', /if \(!adminCommand\) \{[^}]*this\.world\.events\.emit\('command'/, 'no event for the admin command')
  // no other handler closes the sender for what it sent
  for (const name of handlers.filter(name => name !== 'command')) {
    assert.doesNotMatch(handler(name), /\bsocket\.disconnect\(\)/, `${name} closes its sender`)
  }
})

test('the wallet flows: each handler returns at once where the world does not have the feature', () => {
  const solana = [
    'requestBuilderNonce',
    'requestBuilderByToken',
    'requestBuilderRecheck',
    'tokenBalanceRequest',
    'revokeBuilderByToken',
  ]
  const evm = ['requestEvmNonce', 'requestEvmVerify', 'revokeEvmWallet']
  const tips = ['setEvmTipReceive', 'requestEvmTipIntent', 'evmTip']
  assert.deepEqual(namesOfClass('feature').sort(), [...solana, ...evm, ...tips].sort())
  const opening = name => handler(name).split('\n').slice(1, 4).join('\n')
  for (const name of solana) assert.match(opening(name), /if \(!solanaGating\.TOKEN_GATING_ENABLED\b/, name)
  for (const name of evm) assert.match(opening(name), /if \(!evmGating\.EVM_ENABLED\b/, name)
  for (const name of tips) {
    assert.match(opening(name), /if \(!evmGating\.EVM_ENABLED \|\| !evmGating\.EVM_TIP_TOKENS\.length\b/, name)
  }
})

test('relays: the handler drops the packet and does nothing else', () => {
  const relays = namesOfClass('relay')
  assert.deepEqual(relays.sort(), ['playerPush', 'playerSessionAvatar', 'playerTeleport'])
  for (const name of relays) {
    const method = registry.find(entry => entry.name === name).method
    assert.equal(
      handler(name).replace(/\s+/g, ' ').trim(),
      `${method} = socket => { this.dropRelay(socket, '${name}') }`,
      name
    )
  }
})

test('refused whoever sends it: another player, a player as an app, an engine event name', () => {
  has(
    'entityModified',
    /if \(entity\.isPlayer\) \{[^}]*if \(entity !== socket\.player\) \{\s*return this\.logOnce\(socket, 'player-modify-other'/,
    'own player only'
  )
  has('entityRemoved', /if \(!entity\.isApp\) \{\s*return this\.logOnce\(socket, 'entity-remove-player'/, 'apps only')
  has('entityEvent', /if \(typeof name !== 'string' \|\| internalEvents\.includes\(name\)\) return/, 'no internal name')
  for (const name of REFUSED_EVENT_NAMES) assert.ok(internalEvents.includes(name), `${name} is an internal event`)
  // a client cannot add a player either: an added entity is an app (entityModifyPolicy.js sanitizeEntityAdd)
  has('entityAdded', /const safe = sanitizeEntityAdd\(data, socket\.id, \{/, 'apps only')
})

test('any connection: these handlers ask for no rank at all', () => {
  for (const name of ['chatAdded', 'appChat', 'ping']) {
    assert.deepEqual(
      PACKET_RULES[name].map(rule => rule.class),
      ['any'],
      name
    )
    assert.doesNotMatch(handler(name), /isBuilder|isAdmin|requireBuilder|outranks|moderated/, name)
  }
  // an event goes to the app, which decides what it takes; the server refuses internal names and counts the rest
  assert.doesNotMatch(handler('entityEvent'), /isBuilder|isAdmin|requireBuilder|outranks|moderated/)
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
  assert.ok(namedCases().length > 20)
  assert.equal(HANDLED.includes('no-handler'), false)
  assert.equal(HANDLED.length, Object.keys(CLASSES).length - 1)
})
