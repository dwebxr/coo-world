import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'ses'
await import('../src/core/lockdown.js')
import { createTokenBalanceClient } from '../src/core/extras/tokenBalanceClient.js'
import { walletPanelText } from '../src/client/components/walletPanelText.js'
import { callForScript } from '../src/core/extras/scriptValues.js'
import { internalEvents } from '../src/core/extras/internalEvents.js'
import { clientWorld, loadClient } from './lib/clientHarness.mjs'

const unknown = { verified: true, known: false, balance: 0 }
const unavailable = { verified: false, known: false, balance: 0 }
const rich = { verified: true, known: true, balance: 12345 }
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function balanceSetup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1000
  const tick = ms => {
    now += ms
    t.mock.timers.tick(ms)
  }
  let verified = true
  const sent = []
  const client = createTokenBalanceClient({
    send: (name, data) => {
      sent.push([name, data])
      return true
    },
    isVerified: () => verified,
    now: () => now,
  })
  t.after(() => client.dispose())
  return {
    client,
    sent,
    tick,
    setVerified: value => {
      verified = value
    },
  }
}

test('balance: correlation, sharing, timeout and cache invalidation', async t => {
  const { client, sent, setVerified, tick } = balanceSetup(t)
  const first = client.get()
  assert.equal(first, client.get())
  client.onTokenBalance({ id: 100, ...rich })
  client.onTokenBalance({ id: 1, verified: true, known: true, balance: Infinity })
  let settled = false
  first.then(() => {
    settled = true
  })
  await flush()
  assert.equal(settled, false)
  client.onTokenBalance({ id: 1, ...rich })
  assert.deepEqual(await first, rich)
  tick(4999)
  assert.deepEqual(await client.get(), rich)
  assert.equal(sent.length, 1)
  tick(1)
  const second = client.get()
  client.onTokenBalance({ id: 1, ...rich })
  tick(9999)
  assert.equal(client.get(), second)
  tick(1)
  assert.deepEqual(await second, unknown)
  assert.deepEqual(await client.get(), unknown)
  assert.equal(sent.length, 2)
  client.invalidate()
  const third = client.get()
  client.invalidate()
  assert.deepEqual(await third, unknown)
  const fourth = client.get()
  client.onTokenBalance({ id: 3, ...rich })
  assert.equal(client.get(), fourth)
  client.onTokenBalance({ id: 4, ...rich })
  assert.deepEqual(await fourth, rich)
  client.invalidate()
  const fifth = client.get()
  setVerified(false)
  tick(10000)
  assert.deepEqual(await fifth, unavailable, 'timeout reads current verification')
  assert.deepEqual(
    sent.map(([, data]) => data.id),
    [1, 2, 3, 4, 5]
  )
})

test('balance: refused sends and disposal resolve unknown', async t => {
  for (const send of [
    () => false,
    () => undefined,
    () => {
      throw Error('closed')
    },
  ]) {
    const client = createTokenBalanceClient({ send, isVerified: () => true })
    assert.deepEqual(await client.get(), unknown)
    client.dispose()
  }
  const { client, sent, setVerified, tick } = balanceSetup(t)
  const pending = client.get()
  setVerified(false)
  client.dispose()
  assert.deepEqual(await pending, unavailable)
  client.onTokenBalance({ id: 1, ...rich })
  assert.deepEqual(await client.get(), unavailable)
  tick(10000)
  assert.equal(sent.length, 1)
})

test('panel: every row and open-build hint', () => {
  const rows = [
    [{ status: 'disconnected' }, 'ウォレット未接続'],
    [{ status: 'connecting' }, '接続中…'],
    [{ status: 'signing' }, '署名を確認中…'],
    [{ status: 'unverified' }, '未確認 (署名する)'],
    [{ status: 'verified', known: false }, '確認済み・残高を取得できません'],
    [{ status: 'verified', known: true, balance: 12345 }, '確認済み・残高 12,345 COO'],
    [{ status: 'verified', known: true, balance: 1e21 }, '確認済み・残高 1,000,000,000,000,000,000,000 COO'],
    [{ status: 'verified', known: true, balance: 1234.5678 }, '確認済み・残高 1,234.57 COO'],
    [{ status: 'verified', known: true, balance: 1.005 }, '確認済み・残高 1.01 COO'],
    [{ status: 'verified', known: true, balance: 0 }, '確認済み・残高 0 COO'],
  ]
  for (const [state, wallet] of rows) {
    for (const effectiveBuilder of [false, true]) {
      for (const rawRank of [0, 1, 2]) {
        const hint = state.status === 'verified' && state.known && state.balance >= 10000 && rawRank === 0
        assert.deepEqual(walletPanelText(state, { effectiveBuilder, rawRank, threshold: 10000 }), {
          wallet,
          build:
            (effectiveBuilder ? 'ビルド権限あり' : 'ビルド権限なし') + (hint ? '・更新ボタンで権限を確認できます' : ''),
        })
      }
    }
  }
  assert.match(
    walletPanelText(
      { status: 'verified', known: true, balance: 0 },
      { effectiveBuilder: true, rawRank: 0, threshold: 0 }
    ).build,
    /更新ボタン/
  )
})

const warnings = []
const createProxy = loadClient('core/extras/createPlayerProxy.js', 'createPlayerProxy', {
  callForScript,
  console: { warn: message => warnings.push(message) },
})
function scriptSetup() {
  const world = {
    network: { id: 'local', isClient: true, tokenBalance: { get: () => Promise.resolve(rich) } },
    solana: { isVerified: () => true },
  }
  const entity = {
    world,
    hook: { dead: false },
    getDeadHook() {
      return this.hook
    },
  }
  const player = { world, data: { id: 'local' } }
  const proxy = createProxy(entity, player)
  const compartment = new Compartment({ player: proxy })
  return { world, entity, player, proxy, compartment }
}

test('script: fresh frozen fields and intrinsic Promise', async () => {
  const { compartment, world } = scriptSetup()
  assert.equal(compartment.evaluate('player.getTokenBalance() instanceof Promise'), true)
  const first = await compartment.evaluate('player.getTokenBalance()')
  const second = await compartment.evaluate('player.getTokenBalance()')
  assert.notEqual(first, second)
  assert.notEqual(first, rich)
  assert.equal(Object.getPrototypeOf(first), compartment.evaluate('Object.prototype'))
  assert.ok(Object.isFrozen(first))
  assert.deepEqual(Reflect.ownKeys(first), ['verified', 'known', 'balance'])
  assert.deepEqual(first, rich)
  assert.deepEqual(
    Object.values(first).map(value => typeof value),
    ['boolean', 'boolean', 'number']
  )
  world.network.tokenBalance.get = () => Promise.reject(new DOMException('operational'))
  assert.deepEqual(await compartment.evaluate('player.getTokenBalance()'), unknown)
})

test('script: unavailable and one warning per app', async () => {
  for (const mode of ['remote', 'server', 'disabled']) {
    const { world, entity, player } = scriptSetup()
    if (mode === 'remote') player.data.id = 'remote'
    if (mode === 'server') {
      world.network.isClient = false
      world.network.isServer = true
    }
    if (mode === 'disabled') delete world.solana
    world.network.tokenBalance.get = () => assert.fail('unavailable must not request')
    const before = warnings.length
    for (let i = 0; i < 3; i++) {
      const compartment = new Compartment({ player: createProxy(entity, player) })
      assert.deepEqual(await compartment.evaluate('player.getTokenBalance()'), unavailable)
    }
    assert.equal(warnings.length - before, mode === 'disabled' ? 0 : 1)
    const next = { ...entity }
    await createProxy(next, player).getTokenBalance()
    assert.equal(warnings.length - before, mode === 'disabled' ? 0 : 2)
  }
})

test('script: crash, rebuild, destroy and fatal suppress settlement', async () => {
  for (const mode of ['crash', 'rebuild', 'destroy', 'fatal']) {
    const { world, entity, compartment } = scriptSetup()
    let finish
    world.network.tokenBalance.get = () =>
      new Promise(resolve => {
        finish = resolve
      })
    const pending = compartment.evaluate('player.getTokenBalance()')
    let settled = false
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    if (mode === 'crash') entity.crashed = true
    if (mode === 'rebuild') {
      entity.hook.dead = true
      entity.hook = { dead: false }
    }
    if (mode === 'destroy') entity.destroyed = true
    if (mode === 'fatal') world.fatalError = 'fatal'
    finish(rich)
    await flush()
    assert.equal(settled, false, mode)
  }
})

test('script: stopped app throws synchronously', () => {
  for (const mode of ['crashed', 'fatal', 'latched']) {
    const { world, entity, compartment } = scriptSetup()
    if (mode === 'fatal') world.fatalError = 'fatal'
    else {
      entity.crashed = true
      if (mode === 'latched') entity.nativeFailure = true
    }
    assert.throws(
      () => compartment.evaluate('player.getTokenBalance()'),
      mode === 'latched' ? /disabled for this app/ : /\[app\] this app has stopped/
    )
  }
})

test('event: scripts cannot forge wallet; direction is enforced', () => {
  const world = clientWorld()
  const Events = loadClient('core/systems/Events.js', 'Events')
  world.events = new Events(world)
  const errors = []
  const Apps = loadClient('core/systems/Apps.js', 'Apps', {
    internalEvents,
    console: { error: value => errors.push(value) },
  })
  const apps = new Apps(world)
  const entity = { world, data: { id: 'app' }, blueprint: { version: 1 } }
  let events = 0
  for (const name of ['wallet', 'enter', 'leave', 'chat', 'command', 'health', 'normal']) {
    world.events.on(name, () => events++)
  }
  const compartment = new Compartment({
    app: {
      emit: (...args) => apps.appMethods.emit(entity, ...args),
      send: (...args) => apps.appMethods.send(entity, ...args),
      sendTo: (...args) => apps.appMethods.sendTo(entity, ...args),
    },
    world: { emit: (...args) => apps.worldMethods.emit(entity, ...args) },
  })
  compartment.evaluate(
    `app.emit('wallet', { playerId: 'player', verified: true }); world.emit('wallet', {}); app.send('wallet', {}); app.sendTo('player', 'wallet', {})`
  )
  assert.equal(events, 0)
  assert.equal(world.packets.length, 0)
  assert.equal(errors.length, 4)
  compartment.evaluate(`
    for (const event of ['wallet', 'enter', 'leave', 'chat', 'command', 'health', 'normal']) {
      for (const name of [[event], { toString: () => event }]) {
        app.emit(name, {})
        world.emit(name, {})
        app.send(name, {})
        app.sendTo('player', name, {})
      }
    }
  `)
  assert.equal(events, 0)
  assert.equal(world.packets.length, 0)
  assert.equal(errors.length, 60)
  for (const method of [
    'onTokenBalanceRequest',
    'onRequestBuilderRecheck',
    'onRequestBuilderNonce',
    'onRequestBuilderByToken',
    'onRevokeBuilderByToken',
  ]) {
    assert.equal(world.network[method], undefined)
    world.network.enqueue(method, {})
  }
  world.network.flush()
  assert.equal(world.packets.length, 0)
  world.network.ws = null
  world.network.destroy()
})
