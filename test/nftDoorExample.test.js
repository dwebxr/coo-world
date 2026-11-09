// docs/scripting/examples/nft-door.js: the OpenPay presets, and the door's client and server scripts run in a
// SES compartment with fake app/world objects (the end-to-end run is in test/e2e/evm-tips-gate.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Euler, Vector3 } from 'three'
import { getAddress, keccak256, toHex } from 'viem'
import 'ses'
await import('../src/core/lockdown.js')

const SOURCE = fs.readFileSync(new URL('../docs/scripting/examples/nft-door.js', import.meta.url), 'utf8')

function constant(name) {
  const match = SOURCE.match(new RegExp(`^const ${name} = '([^']+)'$`, 'm'))
  assert.ok(match, `${name} is declared as a string constant`)
  return match[1]
}

const STORE_URL = constant('COO_WORLD_PASS_URL')

// app.configure fills `initial` into props that are undefined, like Apps.configure
function configureInto(props, sink) {
  return fields => {
    sink.fields = fields
    for (const field of fields) {
      if (field.initial !== undefined && props[field.key] === undefined) props[field.key] = field.initial
    }
  }
}

function run({ isServer = false, props = {}, world = {}, app = {}, now = () => 0 }) {
  const sink = {}
  const fullProps = { ...props }
  const fullApp = { configure: configureInto(fullProps, sink), on() {}, ...app }
  const fullWorld = { isServer, isClient: !isServer, on() {}, ...world }
  let ids = 0
  const uuid = () => `run${++ids}`
  // scripts get a Date with now() only
  const Date = { now }
  new Compartment({ app: fullApp, world: fullWorld, props: fullProps, uuid, Date }).evaluate(SOURCE)
  return { fields: sink.fields, props: fullProps }
}

function client(props = {}) {
  const nodes = new Map()
  const updates = []
  const handlers = new Map()
  const sent = []
  const opened = []
  let sendResult = true
  // the script's clock; update(dt) moves it with the frame
  let clock = 1_000_000
  const node = (id, extra = {}) => {
    const value = { position: new Vector3(0.1, 2, 3), rotation: new Euler(0, 0.2, 0), add() {}, ...extra }
    if (id) nodes.set(id, value)
    return value
  }
  node('Frame')
  const left = node('LeftDoor')
  node('RightDoor')
  run({
    props,
    app: {
      get: id => nodes.get(id),
      create: (type, data) => node(data.id, data),
      add() {},
      on: (name, callback) => {
        if (name === 'update') updates.push(callback)
        else handlers.set(name, callback)
      },
      send: (name, data) => {
        sent.push([name, data])
        return sendResult
      },
    },
    world: { open: (url, newWindow) => opened.push([url, newWindow]) },
    now: () => clock,
  })
  const text = id => nodes.get(id).value
  return {
    sent,
    opened,
    panel: nodes.get('nft-door-pass-panel'),
    sign: () => text('nft-door-status'),
    color: () => nodes.get('nft-door-status').color,
    hint: () => text('nft-door-hint'),
    pass: () => text('nft-door-pass'),
    leftX: () => left.position.x,
    trigger: () => nodes.get('nft-door-open').onTrigger(),
    run: () => sent[0][1].run,
    // an answer from the server; `run` defaults to this build's, `open` to whether that request was an Open
    answer: result =>
      handlers.get('nft-door:result')({
        run: sent[0][1].run,
        open: sent.find(([, data]) => data.nonce === result.nonce)?.[1].open === true,
        ...result,
      }),
    update: dt => {
      clock += dt * 1000
      updates.forEach(fn => fn(dt))
    },
    // time passes without frames, or with frames capped at 1/30 s (a slow device)
    wait: ms => {
      clock += ms
    },
    failSends: () => {
      sendResult = false
    },
  }
}

test('the preset token id is the OpenPay license id of the preset store product', () => {
  const url = new URL(STORE_URL)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.hostname, 'open-pay.jp')
  const product = url.searchParams.get('product')
  assert.match(product, /^h_[0-9a-f]{32}$/)
  assert.equal(constant('COO_WORLD_PASS_TOKEN_ID'), keccak256(toHex(`openpay:license:${product}`)))
  // the comments name the same product
  assert.ok(SOURCE.includes(`keccak256('openpay:license:${product}')`))
})

test('the preset contract is the OpenPay license contract on Polygon', () => {
  const contract = constant('OPENPAY_LICENSE_CONTRACT')
  assert.equal(contract, '0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc')
  assert.equal(getAddress(contract), contract)
})

test('settings: presets fill unset props, and props already set (a pasted script) are kept', () => {
  const settingsOnly = { isClient: false }
  const { props } = run({
    world: settingsOnly,
    props: { type: '1', direction: '1', slideDistance: '1', tokenSymbol: 'COO' },
  })
  assert.deepEqual(props, {
    type: '1',
    direction: '1',
    slideDistance: '1',
    tokenSymbol: 'COO',
    chainId: 137,
    contract: constant('OPENPAY_LICENSE_CONTRACT'),
    tokenId: constant('COO_WORLD_PASS_TOKEN_ID'),
    minBalance: 1,
    passName: 'Coo-World NFT Gate',
    storeUrl: STORE_URL,
    // the old script's fallback for an unset swing angle and direction, now written as initial values
    maxRotation: '45',
  })
  const { props: fresh } = run({ world: settingsOnly })
  assert.equal(fresh.type, '1')
  assert.equal(fresh.slideDistance, '1.8')
  assert.equal(fresh.direction, '2')
})

test('client: the load-time answer shows the status without opening the door', () => {
  const door = client()
  assert.deepEqual(door.sent, [['nft-door:check', { run: door.run(), nonce: 1, open: false }]])
  assert.equal(typeof door.run(), 'string')
  assert.equal(door.pass(), 'Checking pass…')
  const closed = door.leftX()
  // a status answer never opens, even if it were marked open
  door.answer({ verified: true, known: true, holds: true, nonce: 1, open: true })
  door.update(1)
  assert.equal(door.sign(), 'PASS VERIFIED')
  assert.equal(door.pass(), 'Pass: held')
  assert.equal(door.leftX(), closed)
})

test('client: Open asks once, and only the answer to that press opens the door', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  door.trigger()
  assert.deepEqual(
    door.sent.slice(1),
    [['nft-door:check', { run: door.run(), nonce: 2, open: true }]],
    'a second press while waiting is ignored'
  )
  assert.equal(door.sign(), 'CHECKING…')
  // an answer to the earlier request neither opens nor replaces "CHECKING…"
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  door.update(0.25)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'CHECKING…')
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  assert.equal(door.sign(), 'ACCESS GRANTED')
  door.update(0.25)
  assert.notEqual(door.leftX(), closed)
  // the door closes again and the sign shows the newest status
  for (let i = 0; i < 40; i++) door.update(0.25)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'PASS VERIFIED')
})

test('client: an Open answer the server no longer marks open (wallet changed) only shows the status', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  door.answer({ verified: true, known: true, holds: true, nonce: 2, open: false })
  door.update(0.5)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'PASS VERIFIED')
  door.trigger()
  assert.deepEqual(door.sent.at(-1), ['nft-door:check', { run: door.run(), nonce: 3, open: true }], 'not stuck')
})

test('client: answers for an earlier build of the app are ignored', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  // the earlier build had sent more requests: a grant numbered 7 must not open this build's door
  door.answer({ run: 'earlier', verified: true, known: true, holds: true, nonce: 7, open: true })
  door.answer({ run: 'earlier', verified: true, known: true, holds: true, nonce: 2, open: true })
  door.update(0.5)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'CHECKING…')
  // a number this build never sent is ignored too
  door.answer({ verified: true, known: true, holds: true, nonce: 9, open: true })
  door.update(0.5)
  assert.equal(door.leftX(), closed)
})

test('client: an open door is kept open only by a fresh grant', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  // the wallet disconnects while the door is open
  door.answer({ verified: false, known: false, holds: false, nonce: 2, open: false })
  assert.equal(door.sign(), 'CONNECT EVM WALLET')
  // keep pressing Open for 7.5 s, well past the 0.5 s opening + 3 s open + 0.5 s closing; every press that
  // is not ignored asks the server, and every answer refuses
  const before = door.sent.length
  for (let i = 0; i < 30; i++) {
    door.trigger()
    const [, sent] = door.sent.at(-1)
    if (sent.open && sent.nonce > 2) door.answer({ verified: false, known: false, holds: false, nonce: sent.nonce })
    door.update(0.25)
  }
  assert.ok(door.sent.length - before > 1, 'presses while open ask again')
  assert.equal(door.leftX(), closed, 'closed exactly, while the presses go on')
  assert.equal(door.sign(), 'CONNECT EVM WALLET', 'closing keeps the newest status')
})

test('client: a holder press while the door is open keeps it open', () => {
  const holder = client()
  holder.trigger()
  holder.answer({ verified: true, known: true, holds: true, nonce: 2 })
  holder.update(0.5)
  const opened = holder.leftX()
  holder.update(2.5)
  holder.trigger()
  holder.answer({ verified: true, known: true, holds: true, nonce: 3 })
  holder.update(2.5)
  assert.equal(holder.leftX(), opened, 'still fully open 5.5 s after the first grant')
})

test('client: a grant that arrives while the door is closing opens it again', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  door.update(0.5)
  const opened = door.leftX()
  door.update(2.9)
  door.trigger()
  // the open time runs out while the answer is on its way: the door starts closing
  door.update(0.2)
  door.update(0.1)
  const closing = door.leftX()
  assert.ok(closing !== opened && closing !== closed, 'half way')
  assert.equal(door.sign(), 'CHECKING…', 'the pending press keeps its message')
  door.answer({ verified: true, known: true, holds: true, nonce: 3 })
  assert.equal(door.sign(), 'ACCESS GRANTED')
  door.update(0.5)
  assert.equal(door.leftX(), opened, 'open again')
  for (let i = 0; i < 20; i++) door.update(0.25)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'PASS VERIFIED')
})

test('client: an Open answer after the timeout does not open, even before a frame times it out', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  // a long pause without frames; the network delivers the answer before the next frame
  door.wait(15100)
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  door.update(0.25)
  door.update(0.25)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'PASS VERIFIED')
  door.trigger()
  assert.deepEqual(door.sent.at(-1), ['nft-door:check', { run: door.run(), nonce: 3, open: true }])
})

test('client: a wallet without the pass gets the store link, and it goes away for a holder', () => {
  const door = client()
  door.trigger()
  door.answer({ verified: true, known: true, holds: false, nonce: 2 })
  assert.equal(door.sign(), 'NFT PASS REQUIRED')
  assert.equal(door.color(), '#ff0000')
  assert.equal(door.hint(), 'Get the pass: open-pay.jp/@coo')
  assert.equal(door.pass(), 'No pass · Get it here')
  assert.equal(door.panel.cursor, 'pointer')
  door.panel.onPointerDown()
  assert.deepEqual(door.opened, [[STORE_URL, true]], 'opened in a new tab, never in place of the world')
  door.answer({ verified: true, known: true, holds: true, nonce: 2, open: false })
  assert.equal(door.panel.onPointerDown, null)
  assert.equal(door.panel.cursor, null)
})

test('client: without a store URL there is no link', () => {
  const door = client({ storeUrl: '' })
  door.answer({ verified: true, known: true, holds: false, nonce: 1 })
  assert.equal(door.hint(), 'Coo-World NFT Gate')
  assert.equal(door.pass(), 'Pass: not held')
  assert.equal(door.panel.onPointerDown, null)
})

test('client: no verified wallet, and an unknown answer', () => {
  const door = client()
  door.answer({ verified: false, known: false, holds: false, nonce: 1 })
  assert.equal(door.sign(), 'CONNECT EVM WALLET')
  assert.equal(door.pass(), 'EVM wallet not connected')
  door.answer({ verified: true, known: false, holds: false, nonce: 1 })
  assert.equal(door.sign(), 'TRY AGAIN')
  assert.equal(door.pass(), 'Pass: unknown')
})

test('client: an Open answer that never comes gives up after 15 s, and a late answer does not open', () => {
  const door = client()
  door.answer({ verified: true, known: true, holds: true, nonce: 1 })
  const closed = door.leftX()
  door.trigger()
  door.update(14.9)
  assert.equal(door.sign(), 'CHECKING…')
  door.update(0.2)
  assert.equal(door.sign(), 'TRY AGAIN')
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  door.update(0.25)
  assert.equal(door.leftX(), closed)
  assert.equal(door.sign(), 'PASS VERIFIED')
  door.trigger()
  assert.deepEqual(door.sent.at(-1), ['nft-door:check', { run: door.run(), nonce: 3, open: true }], 'asks again')
})

test('client: a load-time check without an answer is sent once more, then shown as unknown', () => {
  const door = client()
  door.update(15.1)
  assert.deepEqual(door.sent.at(-1), ['nft-door:check', { run: door.run(), nonce: 2, open: false }], 'sent again')
  assert.equal(door.pass(), 'Checking pass…')
  door.update(15.1)
  assert.equal(door.sent.length, 2, 'only once')
  assert.equal(door.sign(), 'NFT PASS REQUIRED')
  assert.equal(door.pass(), 'Pass: unknown')
  // the retry is answered late: it still shows
  door.answer({ verified: false, known: false, holds: false, nonce: 2 })
  assert.equal(door.sign(), 'CONNECT EVM WALLET')
})

test('client: the retry of the load-time check is answered', () => {
  const door = client()
  door.update(15.1)
  door.answer({ verified: true, known: true, holds: true, nonce: 2 })
  assert.equal(door.sign(), 'PASS VERIFIED')
  door.update(20)
  assert.equal(door.sent.length, 2)
  assert.equal(door.pass(), 'Pass: held')
})

test('client: the answer timeout follows the clock, not capped frame times', () => {
  const door = client()
  // a slow device: 15.1 s pass, but the frames report the 1/30 s cap
  door.wait(15100)
  door.update(1 / 30)
  assert.deepEqual(door.sent.at(-1), ['nft-door:check', { run: door.run(), nonce: 2, open: false }], 'retried')
  // and frames alone do not time out an answer that is still within 15 s
  const fast = client()
  for (let i = 0; i < 100; i++) fast.update(0)
  assert.equal(fast.sent.length, 1)
})

test('client: a send the network refuses is reported at once', () => {
  const door = client()
  door.failSends()
  door.trigger()
  assert.equal(door.sign(), 'TRY AGAIN')
  door.trigger()
  assert.equal(door.sent.length, 3, 'the press is not stuck waiting')
})

function server(props = {}) {
  const handlers = new Map()
  const worldHandlers = new Map()
  const sent = []
  const reads = []
  const players = new Set(['p1', 'p2'])
  run({
    isServer: true,
    props,
    app: {
      on: (name, callback) => handlers.set(name, callback),
      sendTo: (playerId, name, data) => sent.push([playerId, name, data]),
    },
    world: {
      on: (name, callback) => worldHandlers.set(name, callback),
      getPlayer: id =>
        players.has(id)
          ? {
              getEvmHolding: spec => {
                let resolve
                const promise = new Promise(r => (resolve = r))
                reads.push({ id, spec, resolve })
                return promise
              },
            }
          : null,
    },
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return {
    sent,
    reads,
    check: (playerId, data) => handlers.get('nft-door:check')(data, playerId),
    wallet: playerId => worldHandlers.get('evmWallet')({ playerId, verified: true }),
    leave: playerId => worldHandlers.get('leave')({ playerId }),
    resolve: async (index, result) => {
      reads[index].resolve(result)
      await flush()
      await flush()
    },
  }
}

const HOLDS = { verified: true, known: true, balance: 1, holds: true }
const NONE = { verified: false, known: false, balance: 0, holds: false }

test('server: reads the preset NFT and answers only the asker, echoing its request', async () => {
  const door = server({
    contract: ' 0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc ',
    tokenId: `${constant('COO_WORLD_PASS_TOKEN_ID')}\n`,
  })
  door.check('p1', { run: 'r1', nonce: 3, open: true })
  assert.equal(door.reads.length, 1)
  assert.deepEqual(door.reads[0].spec, {
    chainId: 137,
    contract: constant('OPENPAY_LICENSE_CONTRACT'),
    standard: 'erc1155',
    tokenId: constant('COO_WORLD_PASS_TOKEN_ID'),
    minBalance: 1,
  })
  await door.resolve(0, HOLDS)
  assert.deepEqual(door.sent, [
    ['p1', 'nft-door:result', { verified: true, known: true, holds: true, run: 'r1', nonce: 3, open: true }],
  ])
})

test('server: requests during a read are answered once, with the newest request', async () => {
  const door = server()
  door.check('p1', { run: 'r1', nonce: 1, open: false })
  door.check('p1', { run: 'r1', nonce: 2, open: true })
  assert.equal(door.reads.length, 1, 'one read at a time per player')
  await door.resolve(0, { ...HOLDS, holds: false })
  assert.equal(door.sent.length, 0, 'the stale answer is not sent')
  assert.equal(door.reads.length, 2)
  await door.resolve(1, HOLDS)
  assert.deepEqual(door.sent, [
    ['p1', 'nft-door:result', { verified: true, known: true, holds: true, run: 'r1', nonce: 2, open: true }],
  ])
})

test('server: odd request fields are normalized', async () => {
  for (const [data, expected] of [
    [
      { run: 'r', nonce: '7', open: 'yes' },
      { run: 'r', nonce: 0, open: false },
    ],
    [
      { run: 5, nonce: -1, open: 1 },
      { run: '', nonce: 0, open: false },
    ],
    [
      { run: 'x'.repeat(100), nonce: 1.5 },
      { run: 'x'.repeat(32), nonce: 0, open: false },
    ],
    [{ nonce: 2 ** 53 }, { run: '', nonce: 0, open: false }],
    [null, { run: '', nonce: 0, open: false }],
    [undefined, { run: '', nonce: 0, open: false }],
  ]) {
    const door = server()
    door.check('p1', data)
    await door.resolve(0, HOLDS)
    const { run, nonce, open } = door.sent[0][2]
    assert.deepEqual({ run, nonce, open }, expected, JSON.stringify(data))
  }
})

test('server: a wallet change during an Open read cancels the Open', async () => {
  const door = server()
  door.check('p1', { run: 'r1', nonce: 2, open: true })
  // the player signs in with another wallet while the read runs
  door.wallet('p1')
  await door.resolve(0, NONE)
  assert.equal(door.sent.length, 0, 'the read of the old wallet is not sent')
  await door.resolve(1, HOLDS)
  assert.deepEqual(door.sent, [
    ['p1', 'nft-door:result', { verified: true, known: true, holds: true, run: 'r1', nonce: 2, open: false }],
  ])
})

test('server: a wallet change re-checks players who asked, as a status answer, until they leave', async () => {
  const door = server()
  door.wallet('p2')
  assert.equal(door.reads.length, 0, 'a player who never asked is not read')
  door.check('p1', { run: 'r1', nonce: 4, open: true })
  await door.resolve(0, HOLDS)
  door.wallet('p1')
  assert.equal(door.reads.length, 2)
  await door.resolve(1, NONE)
  assert.deepEqual(door.sent.at(-1), [
    'p1',
    'nft-door:result',
    { verified: false, known: false, holds: false, run: 'r1', nonce: 4, open: false },
  ])
  door.leave('p1')
  door.wallet('p1')
  assert.equal(door.reads.length, 2)
})
