import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createWalletConnectProvider } from '../src/client/walletconnect.js'
import { WALLET_LINKS, isWalletConnectUri, safeRedirect, walletConnectLink } from '../src/core/extras/walletLinks.js'

const A = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const B = '0x1563915e194D8CfBA1943570603F7606A3115508'
const OTHER = '0x' + 'ab'.repeat(20)
const pairingTopic = n => n.toString(16).padStart(64, '0')
const uriFor = n => `wc:${pairingTopic(n)}@2?relay-protocol=irn&symKey=${'2'.repeat(64)}`
const URI = uriFor(1)

const session = (topic, accounts, { expiry = 2_000_000_000, namespaces, redirect, pairing } = {}) => ({
  topic,
  pairingTopic: pairing,
  expiry,
  namespaces: namespaces ?? { eip155: { accounts } },
  peer: { metadata: redirect ? { redirect } : {} },
})

// A fake SignClient shaped like 2.26.0 where the adapter depends on it:
// - every connect() is its own proposal (client.proposal, with its pairing topic) and resolves with its own
//   { uri, approval } once the relay took it (at once, or when the test says, with holdUri);
// - approval() starts the wait for the wallet. An expiry (client.core.expirer.set(id, 0)) rejects that wait a
//   moment later, but one set before approval() was called is lost (createDelayedPromise);
// - sessions live in client.session (get throws for an unknown topic); events carry their topic;
// - account changes come as session_event (with the chain), and session namespaces stay as they were;
// - disconnect({ topic }) ends that topic only, and can fail (offline) or never answer.
function fakeSignClient({ stored = [] } = {}) {
  const instances = []
  class FakeClient extends EventEmitter {
    static async init(options) {
      const client = new FakeClient(options)
      instances.push(client)
      return client
    }
    constructor(options) {
      super()
      this.options = options
      this.attempts = []
      this.requests = []
      this.disconnects = []
      // every expirer key the adapter set (proposal ids only: pairing topics are left to the SDK)
      this.expired = []
      this.deleted = []
      this.failDisconnect = false
      this.hangDisconnect = false
      this.hung = []
      this.holdUri = false
      this.handler = null
      const map = new Map(stored.map(s => [s.topic, s]))
      this.map = map
      const fake = this
      this.session = {
        get keys() {
          return [...map.keys()]
        },
        get: topic => {
          if (!map.has(topic)) throw new Error(`No matching key. session: ${topic}`)
          return map.get(topic)
        },
        getAll: () => [...map.values()],
        delete: async topic => {
          fake.deleted.push(topic)
          map.delete(topic)
        },
      }
      this.proposal = {
        getAll: () => fake.attempts.filter(a => a.open).map(a => ({ id: a.id, pairingTopic: a.pairingTopic })),
      }
      this.core = {
        expirer: {
          set: (key, expiry) => {
            fake.expired.push(key)
            assert.equal(expiry, 0)
            if (typeof key !== 'number') return
            const attempt = fake.attempts.find(a => a.id === key)
            if (!attempt?.open) return
            attempt.open = false
            attempt.expiredEarly = !attempt.armed
            queueMicrotask(() => {
              if (attempt.armed) attempt.reject(Object.assign(new Error('Proposal expired'), { code: 0 }))
            })
          },
        },
      }
    }
    connect(params) {
      const n = this.attempts.length + 1
      const attempt = { id: 1000 + n, params, open: true, armed: false, settled: false }
      attempt.pairingTopic = pairingTopic(n)
      attempt.uri = uriFor(n)
      this.attempts.push(attempt)
      let resolveApproval
      let rejectApproval
      const waiting = new Promise((resolve, reject) => {
        resolveApproval = resolve
        rejectApproval = reject
      })
      attempt.resolve = value => {
        if (attempt.settled || !attempt.armed) return
        attempt.settled = true
        resolveApproval(value)
      }
      attempt.reject = error => {
        if (attempt.settled || !attempt.armed) return
        attempt.settled = true
        rejectApproval(error)
      }
      const approval = () => {
        attempt.armed = true
        return waiting
      }
      return new Promise((resolve, reject) => {
        attempt.showUri = () => resolve({ uri: attempt.uri, approval })
        attempt.fail = reject
        if (!this.holdUri) queueMicrotask(attempt.showUri)
      })
    }
    // the wallet approves a pairing (the latest by default)
    approve(accounts, { topic = 'topic-1', attempt = this.attempts.at(-1), namespaces, redirect } = {}) {
      const value = session(topic, accounts, { namespaces, redirect, pairing: attempt.pairingTopic })
      this.map.set(topic, value)
      attempt.open = false
      attempt.resolve(value)
    }
    // the SDK stores the session and deletes the proposal, then fails to send its answer: the approval stays
    // pending until its own timer (reject: true stands in for that timer)
    settleAndFail(accounts, { topic = 'partial', attempt = this.attempts.at(-1), reject = false } = {}) {
      this.map.set(topic, session(topic, accounts, { pairing: attempt.pairingTopic }))
      attempt.open = false
      if (reject) attempt.reject(new Error('Proposal expired'))
    }
    // the wallet reports its accounts for a chain
    walletEvent(topic, chainId, data) {
      this.emit('session_event', { topic, params: { chainId, event: { name: 'accountsChanged', data } } })
    }
    async request(params) {
      this.requests.push(params)
      if (this.handler) return this.handler(params)
      return '0x' + 'cd'.repeat(65)
    }
    async disconnect({ topic, reason }) {
      this.disconnects.push(topic)
      assert.equal(reason.code, 6000)
      if (this.failDisconnect) throw new Error('offline')
      if (this.hangDisconnect) await new Promise(resolve => this.hung.push(resolve))
      if (!this.map.has(topic)) throw new Error(`Session or pairing topic not found: ${topic}`)
      this.map.delete(topic)
    }
  }
  return { FakeClient, instances }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

async function setup({ stored, relayWaitMs = 20_000, endWaitMs = 10_000 } = {}) {
  const { FakeClient, instances } = fakeSignClient({ stored })
  const statuses = []
  const timers = []
  const adapter = await createWalletConnectProvider({
    SignClient: FakeClient,
    renderSVG: uri => `<svg data-uri="${uri.length}"/>`,
    projectId: 'f'.repeat(32),
    chainId: 137,
    origin: 'https://play.example',
    onStatus: status => statuses.push(status),
    relayWaitMs,
    endWaitMs,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: timer => timer && (timer.cleared = true),
  })
  const accountEvents = []
  adapter.on('accountsChanged', accounts => accountEvents.push(accounts))
  const client = instances[0]
  const alive = topic => client.session.keys.includes(topic)
  const requestAccounts = () => adapter.request({ method: 'eth_requestAccounts' })
  return { adapter, client, statuses, timers, accountEvents, alive, requestAccounts }
}

const connected = async (accounts = [`eip155:137:${A}`]) => {
  const ctx = await setup()
  const pending = ctx.requestAccounts()
  await flush()
  ctx.client.approve(accounts)
  ctx.handedOut = await pending
  return ctx
}

test('walletconnect: init names this origin, turns telemetry off and asks for the sign-in chain as optional', async () => {
  const { client, statuses, requestAccounts } = await setup()
  assert.equal(client.options.projectId, 'f'.repeat(32))
  assert.equal(client.options.metadata.url, 'https://play.example')
  assert.deepEqual(client.options.metadata.icons, [])
  assert.equal(client.options.telemetryEnabled, false)
  const pending = requestAccounts()
  await flush()
  assert.deepEqual(client.attempts[0].params, {
    optionalNamespaces: {
      eip155: {
        chains: ['eip155:137'],
        methods: ['personal_sign', 'eth_sendTransaction', 'wallet_switchEthereumChain'],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
  })
  // the screen gets the URI and a QR (SVG data URL)
  const uri = statuses.find(s => s.state === 'uri')
  assert.equal(uri.uri, URI)
  assert.match(uri.qr, /^data:image\/svg\+xml;charset=utf-8,/)
  client.approve([`eip155:1:${OTHER}`, `eip155:137:${A}`, `eip155:137:${B}`])
  assert.deepEqual(await pending, [A, B], 'only accounts on the sign-in chain')
  assert.deepEqual(
    statuses.map(s => s.state),
    ['connecting', 'uri', 'connected']
  )
  assert.ok(Object.isFrozen(statuses[0]))
})

test('walletconnect: the sign-in chain, accounts and network switches are answered from the session', async () => {
  const { adapter, client, requestAccounts } = await setup()
  assert.deepEqual(await adapter.request({ method: 'eth_accounts' }), [])
  assert.equal(await adapter.request({ method: 'eth_chainId' }), '0x0')
  const pending = requestAccounts()
  await flush()
  client.approve([`eip155:137:${B}`, `eip155:137:${A}`])
  await pending
  // the account handed out stays first, even if the session lists them the other way round
  client.map.get('topic-1').namespaces.eip155.accounts = [`eip155:137:${A}`, `eip155:137:${B}`]
  assert.deepEqual(await adapter.request({ method: 'eth_accounts' }), [B, A])
  assert.equal(await adapter.request({ method: 'eth_chainId' }), '0x89')
  assert.equal(await adapter.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] }), null)
  await assert.rejects(adapter.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), {
    code: 4902,
  })
  await assert.rejects(adapter.request({ method: 'wallet_addEthereumChain', params: [{}] }), { code: 4200 })
  await assert.rejects(adapter.request({ method: 'eth_signTypedData_v4', params: [] }), { code: 4200 })
  assert.equal(client.requests.length, 0, 'none of these reach the wallet')
})

test('walletconnect: accounts under a chain-scoped namespace ("eip155:137") count too', async () => {
  const { client, requestAccounts } = await setup()
  const pending = requestAccounts()
  await flush()
  client.approve([], {
    namespaces: {
      'eip155:137': { accounts: [`eip155:137:${A}`, `eip155:137:${A.toLowerCase()}`] },
      eip155: { accounts: [`eip155:1:${OTHER}`] },
    },
  })
  assert.deepEqual(await pending, [A], 'found only there, and listed once')
  assert.deepEqual(client.disconnects, [])
})

test('walletconnect: signatures and transfers go to the wallet on the sign-in chain; rejections are 4001', async () => {
  const { adapter, client, statuses } = await connected()
  const signature = await adapter.request({ method: 'personal_sign', params: ['0x68', A] })
  assert.equal(signature, '0x' + 'cd'.repeat(65))
  assert.deepEqual(client.requests[0], {
    topic: 'topic-1',
    chainId: 'eip155:137',
    request: { method: 'personal_sign', params: ['0x68', A] },
  })
  assert.deepEqual(
    statuses.slice(-2).map(s => [s.state, s.method]),
    [
      ['request', 'personal_sign'],
      ['idle', undefined],
    ]
  )
  for (const rejection of [
    { code: 5000, message: 'User rejected.' },
    { code: 4001, message: 'x' },
    new Error('User denied'),
  ]) {
    client.handler = () => {
      throw rejection
    }
    await assert.rejects(adapter.request({ method: 'eth_sendTransaction', params: [{}] }), { code: 4001 })
  }
})

test('walletconnect: a wallet that does not connect on the sign-in chain is disconnected with 4901', async () => {
  const { adapter, client, accountEvents, alive, requestAccounts } = await setup()
  const pending = requestAccounts()
  await flush()
  client.approve([`eip155:1:${A}`])
  await assert.rejects(pending, { code: 4901 })
  await flush()
  assert.deepEqual(client.disconnects, ['topic-1'])
  assert.equal(alive('topic-1'), false)
  assert.equal(adapter.hasSession(), false)
  assert.deepEqual(accountEvents, [])
})

test('walletconnect: no relay answer in time fails as relay_unreachable; connects are serialised', async () => {
  const { client, timers, statuses, requestAccounts } = await setup()
  client.holdUri = true
  const first = requestAccounts()
  const second = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 1, 'one connect for both')
  timers.find(t => t.ms === 20_000).fn()
  await assert.rejects(first, { message: 'relay_unreachable' })
  await assert.rejects(second, { message: 'relay_unreachable' })
  // the relay answers after all: that link is ended, after the SDK began waiting on it, and never shown
  client.attempts[0].showUri()
  await flush()
  assert.equal(client.attempts[0].expiredEarly, false)
  assert.equal(client.attempts[0].settled, true, 'its wait ended instead of running five minutes')
  assert.ok(!statuses.some(s => s.state === 'uri'))
})

test('walletconnect: Cancel after the link ends that proposal, and a retry gets its own link', async () => {
  const { adapter, client, statuses, accountEvents, requestAccounts } = await setup()
  const first = requestAccounts()
  await flush()
  adapter.cancel()
  await assert.rejects(first, { code: 4001 })
  await flush()
  assert.equal(client.attempts[0].settled, true, 'the old proposal expired instead of waiting five minutes')
  const second = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 2)
  assert.equal(statuses.at(-1).uri, uriFor(2), 'the new link')
  client.approve([`eip155:137:${A}`])
  assert.deepEqual(await second, [A])
  assert.deepEqual(accountEvents, [])
  assert.equal(adapter.hasSession(), true)
})

test('walletconnect: Cancel and an immediate retry give a fresh pairing, not the cancelled one', async () => {
  const { adapter, client, requestAccounts } = await setup()
  const first = requestAccounts()
  await flush()
  adapter.cancel()
  const retry = requestAccounts()
  await assert.rejects(first, { code: 4001 })
  await flush()
  assert.equal(client.attempts.length, 2)
  // the cancelled call finishing does not free the retry's slot: a third caller joins the retry
  const third = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 2, 'no third pairing')
  client.approve([`eip155:137:${A}`])
  assert.deepEqual(await retry, [A])
  assert.deepEqual(await third, [A])
  assert.ok(
    client.expired.every(key => typeof key === 'number'),
    'only proposals were expired, never a pairing topic'
  )
  assert.deepEqual(client.expired, [client.attempts[0].id])
})

test('walletconnect: a session stored by a settlement that then failed is ended, not left for a reload', async () => {
  const { adapter, client, alive, requestAccounts } = await setup()
  // the approval is left pending (as in the SDK); Cancel ends the session it stored
  const pending = requestAccounts()
  await flush()
  client.settleAndFail([`eip155:137:${A}`])
  await flush()
  assert.equal(alive('partial'), true)
  adapter.cancel()
  await assert.rejects(pending, { code: 4001 })
  await flush()
  assert.deepEqual(client.disconnects, ['partial'])
  assert.equal(alive('partial'), false)
  assert.equal(adapter.hasSession(), false)
  // the same when the SDK's own timer finally rejects the approval
  const again = requestAccounts()
  await flush()
  client.settleAndFail([`eip155:137:${A}`], { topic: 'partial-2', reject: true })
  await assert.rejects(again)
  await flush()
  assert.equal(alive('partial-2'), false)
  assert.equal(adapter.hasSession(), false)
})

test('walletconnect: a pairing given up before its link does not hold up the next one', async () => {
  const { adapter, client, statuses, requestAccounts } = await setup()
  client.holdUri = true
  const first = requestAccounts()
  await flush()
  adapter.cancel()
  await assert.rejects(first, { code: 4001 })
  const second = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 2, 'the retry pairs at once')
  // the old link comes late: it is never shown, and it ends at once
  client.attempts[0].showUri()
  await flush()
  assert.equal(client.attempts[0].settled, true)
  assert.ok(!statuses.some(s => s.uri === uriFor(1)), 'the old link never reached the screen')
  client.attempts[1].showUri()
  await flush()
  assert.equal(statuses.at(-1).uri, uriFor(2))
  client.approve([`eip155:137:${A}`])
  assert.deepEqual(await second, [A])
})

test('walletconnect: a session that settles after Cancel is closed on its own topic; the retry keeps its own', async () => {
  const { adapter, client, accountEvents, alive, requestAccounts } = await setup()
  const first = requestAccounts()
  await flush()
  const late = client.attempts[0]
  adapter.cancel()
  // the wallet approved the first link just before it ran out
  client.approve([`eip155:137:${B}`], { topic: 'late', attempt: late })
  await assert.rejects(first, { code: 4001 })
  const retry = requestAccounts()
  await flush()
  client.approve([`eip155:137:${A}`], { topic: 'fresh' })
  assert.deepEqual(await retry, [A])
  await flush()
  assert.deepEqual(client.disconnects, ['late'])
  assert.equal(alive('late'), false)
  assert.equal(alive('fresh'), true)
  assert.deepEqual(await adapter.request({ method: 'eth_accounts' }), [A])
  // events of the closed session do not count
  client.walletEvent('late', 'eip155:137', [B])
  client.emit('session_delete', { topic: 'late' })
  assert.deepEqual(accountEvents, [])
  assert.equal(adapter.hasSession(), true)
  // cancel with nothing pending does nothing
  adapter.cancel()
})

test('walletconnect: a stored session on the wrong network is not adopted and does not block pairing', async () => {
  const stale = session('stale', [`eip155:1:${A}`])
  const { adapter, client, alive, requestAccounts } = await setup({ stored: [stale] })
  assert.equal(adapter.hasSession(), false)
  const pending = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 1)
  client.approve([`eip155:137:${A}`], { topic: 'fresh' })
  assert.deepEqual(await pending, [A])
  assert.equal(alive('fresh'), true)
})

test('walletconnect: an expired session in use is replaced without waiting for its close', async () => {
  const { adapter, client, alive, accountEvents, requestAccounts } = await connected()
  client.map.get('topic-1').expiry = 1
  client.hangDisconnect = true
  const pending = requestAccounts()
  await flush()
  assert.deepEqual(client.disconnects, ['topic-1'])
  assert.equal(client.attempts.length, 2, 'pairing at once')
  client.hangDisconnect = false
  client.approve([`eip155:137:${B}`], { topic: 'fresh' })
  assert.deepEqual(await pending, [B])
  // the old close finishes late: it touches its own topic only
  client.hung.shift()()
  await flush()
  assert.equal(alive('fresh'), true)
  assert.equal(adapter.hasSession(), true)
  assert.deepEqual(accountEvents, [], 'replacing the expired session is not an account change')
})

test('walletconnect: closing a session waits at most a while, then forgets it here', async () => {
  const { adapter, client, timers, alive } = await connected()
  client.hangDisconnect = true
  let done = false
  const closing = adapter.disconnect().then(() => (done = true))
  await flush()
  assert.equal(done, false)
  assert.equal(adapter.hasSession(), false, 'unusable at once')
  timers.find(t => t.ms === 10_000 && !t.cleared).fn()
  await closing
  await flush()
  assert.deepEqual(client.deleted, ['topic-1'])
  assert.equal(alive('topic-1'), false)
})

test('walletconnect: account events fire only on real changes; a lost session clears the accounts once', async () => {
  const { client, accountEvents } = await connected()
  // the wallet switches network: its notice for the other chain does not count
  client.walletEvent('topic-1', 'eip155:1', [OTHER])
  client.emit('session_event', { topic: 'topic-1', params: { chainId: 'eip155:1', event: { name: 'chainChanged' } } })
  assert.deepEqual(accountEvents, [], 'no change for a network switch')
  // the wallet adds an account on the sign-in chain (SignClient stores it before the event)
  client.map.get('topic-1').namespaces.eip155.accounts = [`eip155:137:${A}`, `eip155:137:${B}`]
  client.emit('session_update', { topic: 'topic-1' })
  assert.deepEqual(accountEvents, [[A, B]])
  client.emit('session_update', { topic: 'someone-else' })
  client.emit('session_delete', { topic: 'someone-else' })
  assert.deepEqual(accountEvents, [[A, B]])
  // the wallet ends the session
  client.map.delete('topic-1')
  client.emit('session_delete', { topic: 'topic-1' })
  assert.deepEqual(accountEvents, [[A, B], []])
})

test('walletconnect: the wallet switching account on the sign-in chain is reported (namespaces unchanged)', async () => {
  const { adapter, client, accountEvents, requestAccounts } = await connected([`eip155:137:${A}`, `eip155:137:${B}`])
  client.walletEvent('topic-1', 'eip155:137', [B, A])
  assert.deepEqual(accountEvents, [[B, A]], 'the integration sees the new active account')
  assert.deepEqual(await adapter.request({ method: 'eth_accounts' }), [B, A])
  client.walletEvent('topic-1', 'eip155:137', [`eip155:137:${B}`, 'nonsense', `eip155:1:${A}`])
  assert.deepEqual(accountEvents.at(-1), [B], 'CAIP-10 for this chain or plain addresses only')
  client.walletEvent('topic-1', 'eip155:137', [B])
  assert.equal(accountEvents.length, 2, 'same list, no event')
  assert.deepEqual(await requestAccounts(), [B], 'a reconnect hands out the active account')
  // an account outside the session does not count; once the session lists it, it does
  client.walletEvent('topic-1', 'eip155:137', [OTHER])
  assert.deepEqual(accountEvents.at(-1), [])
  client.map.get('topic-1').namespaces.eip155.accounts.push(`eip155:137:${OTHER}`)
  client.emit('session_update', { topic: 'topic-1' })
  assert.deepEqual(accountEvents.at(-1), [OTHER])
})

test('walletconnect: the wallet withdrawing its accounts is an empty list, and a reconnect pairs anew', async () => {
  const { adapter, client, accountEvents, requestAccounts } = await connected()
  client.walletEvent('topic-1', 'eip155:137', [])
  assert.deepEqual(accountEvents, [[]])
  assert.equal(adapter.hasSession(), false)
  assert.equal(await adapter.request({ method: 'eth_chainId' }), '0x0')
  const pending = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 2, 'not handed the old session again')
  client.approve([`eip155:137:${A}`], { topic: 'topic-2' })
  assert.deepEqual(await pending, [A])
})

test('walletconnect: a disconnect the relay never heard of still ends the session here and in storage', async () => {
  const { adapter, client, accountEvents, requestAccounts } = await connected()
  client.failDisconnect = true
  await adapter.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
  assert.equal(adapter.hasSession(), false)
  assert.deepEqual(accountEvents, [[]])
  await flush()
  assert.deepEqual(client.deleted, ['topic-1'], 'dropped from storage, so a reload does not restore it')
  assert.deepEqual(await adapter.request({ method: 'eth_accounts' }), [])
  await assert.rejects(adapter.request({ method: 'personal_sign', params: ['0x68', A] }), { code: 4100 })
  // a new connect pairs again instead of reusing it
  client.failDisconnect = false
  const pending = requestAccounts()
  await flush()
  assert.equal(client.attempts.length, 2)
  client.approve([`eip155:137:${B}`], { topic: 'topic-2' })
  assert.deepEqual(await pending, [B])
})

test('walletconnect: a request that ends after a new pairing started does not hide its link', async () => {
  const { adapter, client, statuses, requestAccounts } = await connected()
  let answer
  client.handler = () => new Promise(resolve => (answer = resolve))
  const signing = adapter.request({ method: 'personal_sign', params: ['0x68', A] })
  await flush()
  assert.equal(statuses.at(-1).state, 'request')
  await adapter.disconnect()
  const pairing = requestAccounts()
  await flush()
  assert.equal(statuses.at(-1).state, 'uri')
  answer('0x' + 'ef'.repeat(65))
  await signing.catch(() => {})
  await flush()
  assert.equal(statuses.at(-1).state, 'uri', 'the old request no longer owns the panel')
  client.approve([`eip155:137:${A}`], { topic: 'topic-2' })
  await pairing
})

test('walletconnect: a request after the session vanished (another tab disconnected) clears the accounts', async () => {
  const { adapter, client, accountEvents } = await connected()
  client.map.delete('topic-1')
  await assert.rejects(adapter.request({ method: 'personal_sign', params: ['0x68', A] }), { code: 4100 })
  assert.deepEqual(accountEvents, [[]])
  assert.equal(client.requests.length, 0)
})

test('walletconnect: only this session expiring clears the accounts', async () => {
  const { client, accountEvents } = await connected()
  client.emit('session_expire', { topic: 'some-other' })
  assert.deepEqual(accountEvents, [])
  client.emit('session_expire', { topic: 'topic-1' })
  assert.deepEqual(accountEvents, [[]])
})

test('walletconnect: a stored session is reused without a QR; an expired one is replaced', async () => {
  const redirect = { universal: 'https://wallet.example/app', native: 'javascript:alert(1)' }
  const stored = [
    session('old', [`eip155:137:${B}`], { expiry: 1_900_000_000 }),
    session('wrong-chain', [`eip155:1:${A}`], { expiry: 2_100_000_000 }),
    session('stored', [`eip155:137:${A}`], { redirect }),
  ]
  const { adapter, client } = await setup({ stored })
  assert.equal(adapter.hasSession(), true, 'the latest one that can sign in')
  assert.deepEqual(await adapter.request({ method: 'eth_requestAccounts' }), [A])
  assert.equal(client.attempts.length, 0, 'no new pairing')
  assert.equal(adapter.walletRedirect(), 'https://wallet.example/app')
  // disconnect closes it
  await adapter.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
  assert.deepEqual(client.disconnects, ['stored'])
  assert.equal(adapter.hasSession(), false)
  assert.equal(adapter.walletRedirect(), null)

  const expired = await setup({ stored: [session('stored', [`eip155:137:${A}`], { expiry: 1 })] })
  assert.equal(expired.adapter.hasSession(), false)
  const pending = expired.requestAccounts()
  await flush()
  assert.equal(expired.client.attempts.length, 1, 'a new pairing')
  expired.client.approve([`eip155:137:${B}`])
  assert.deepEqual(await pending, [B])
  assert.deepEqual(expired.accountEvents, [])
})

test('wallet links: the wallet-supplied link back is validated before it reaches an href', () => {
  assert.equal(safeRedirect({ universal: 'https://metamask.app.link' }), 'https://metamask.app.link/')
  assert.equal(safeRedirect({ native: 'metamask://' }), 'metamask://')
  assert.equal(safeRedirect({ universal: 'http://wallet.example', native: 'rainbow://' }), 'rainbow://')
  for (const bad of [
    { universal: 'javascript:alert(1)' },
    { universal: 'https://user:pass@wallet.example' },
    { native: 'javascript:alert(1)' },
    { native: 'JavaScript:alert(1)' },
    { native: 'data:text/html,x' },
    { native: 'https://wallet.example' },
    { native: 'wallet://a b' },
    { native: 'x'.repeat(201) + ':' },
    { native: '//no-scheme' },
    null,
    'https://wallet.example',
  ]) {
    assert.equal(safeRedirect(bad), null, JSON.stringify(bad))
  }
  assert.equal(
    walletConnectLink('https://metamask.app.link', URI),
    `https://metamask.app.link/wc?uri=${encodeURIComponent(URI)}`
  )
  assert.deepEqual(
    WALLET_LINKS.map(w => w.universal),
    ['https://metamask.app.link', 'https://link.wallet.hashport.com', 'https://prd-api.mynawallet.jp/deeplink']
  )
  assert.equal(isWalletConnectUri(URI), true)
  for (const bad of ['wc:short@2?x', 'https://x', `wc:${'1'.repeat(64)}@1?x`, 1])
    assert.equal(isWalletConnectUri(bad), false)
})
