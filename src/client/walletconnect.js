// WalletConnect (Reown) as an EIP-1193 provider for evm-integration.js. Loaded only with import(), when the
// player picks WalletConnect, so its code (and the relay connection) never touch other page loads.
// Design: goals/phase5-walletconnect-design.md (§3, §11, §12).
//
// Built on SignClient, not UniversalProvider: UniversalProvider keeps one shared session that its own
// listeners clear asynchronously (also when the SDK drops an expired session), and reports every pairing link
// through one shared event. Here each pairing has its own link and approval, and the adapter keeps the one
// session it uses (`current`); everything else is ended by topic.
//
// The adapter owns every difference from the injected wallets the integration was written for:
// - eth_requestAccounts / eth_accounts / eth_chainId / wallet_switchEthereumChain are answered here;
// - accounts are the sign-in chain's only: the wallet's latest accountsChanged for that chain (within the
//   session's accounts), else the session's list with the account handed out first;
// - accountsChanged fires only when that list changes, and [] when the session is gone;
// - chainChanged is not forwarded: requests always name the sign-in chain, whatever the wallet shows;
// - rejections come back as code 4001.

import { SignClient as DefaultSignClient } from '@walletconnect/sign-client'
import { renderSVG as defaultRenderSVG } from 'uqr'
import { safeRedirect } from '../core/extras/walletLinks.js'

const RELAY_WAIT_MS = 20_000
// how long ending a session may wait for the relay (SignClient's unsubscribe has no timeout of its own)
const END_WAIT_MS = 10_000
const METHODS = ['personal_sign', 'eth_sendTransaction', 'wallet_switchEthereumChain']
const EVENTS = ['accountsChanged', 'chainChanged']
const REJECTED = new Set([4001, 5000, 5001, 5002, 5003])
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const MAX_ACCOUNTS = 32
const USER_DISCONNECTED = Object.freeze({ code: 6000, message: 'User disconnected.' })

const rpcError = (code, message) => Object.assign(new Error(message), { code })
const ignore = () => {}

export async function createWalletConnectProvider({
  SignClient = DefaultSignClient,
  renderSVG = defaultRenderSVG,
  projectId,
  chainId,
  origin,
  onStatus = () => {},
  relayWaitMs = RELAY_WAIT_MS,
  endWaitMs = END_WAIT_MS,
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const chain = `eip155:${chainId}`
  const prefix = `${chain}:`
  const client = await SignClient.init({
    projectId,
    // the Verify API checks this against the dashboard's allowed domains
    metadata: { name: 'coo-world', description: 'coo-world', url: origin, icons: [] },
    telemetryEnabled: false,
  })
  const listeners = { accountsChanged: new Set() }
  // the session this adapter uses, by topic; the accounts it handed out and last reported for it
  let current = null
  let handedOut = null
  let lastAccounts = []
  // the wallet's own word on the sign-in chain's accounts (its accountsChanged event), active one first;
  // null until it says anything. An empty list means it withdrew them.
  let exposed = null
  // the caller-facing connection (concurrent eth_requestAccounts share it) and the pairing behind it
  let connecting = null
  let attempt = null
  // whose status the panel shows: a request or connection that was superseded cannot change it any more
  let statusOwner = null
  // sessions this page ended: never used again, even when the relay could not be told
  const ended = new Set()

  const status = (owner, value) => {
    if (owner !== statusOwner) return
    try {
      onStatus(Object.freeze(value))
    } catch {
      // the screen's problem, not the connection's
    }
  }
  const claimStatus = (owner, value) => {
    statusOwner = owner
    status(owner, value)
  }
  const emit = accounts => {
    for (const listener of [...listeners.accountsChanged]) {
      try {
        listener([...accounts])
      } catch {
        // a listener's error does not stop the others
      }
    }
  }

  const getSession = topic => {
    if (!topic) return null
    try {
      return client.session.get(topic) ?? null
    } catch {
      return null
    }
  }
  const alive = topic => {
    if (!topic || ended.has(topic) || !client.session.keys.includes(topic)) return false
    const session = getSession(topic)
    return !!session && !(typeof session.expiry === 'number' && session.expiry * 1000 <= now())
  }
  const unique = addresses => {
    const seen = new Set()
    const out = []
    for (const address of addresses) {
      if (!address || seen.has(address.toLowerCase())) continue
      seen.add(address.toLowerCase())
      out.push(address)
    }
    return out
  }
  // a CAIP-10 account on the sign-in chain, or (in a wallet event) a plain address
  const parseAccount = (entry, plain) => {
    if (typeof entry !== 'string') return null
    const address = entry.startsWith(prefix) ? entry.slice(prefix.length) : plain ? entry : null
    return address && ADDRESS.test(address) ? address : null
  }
  // a session's accounts on the sign-in chain: the eip155 namespace and a chain-scoped "eip155:<id>" one
  const sessionAccounts = topic => {
    const namespaces = getSession(topic)?.namespaces
    const listed = [namespaces?.eip155?.accounts, namespaces?.[chain]?.accounts]
      .filter(Array.isArray)
      .flat()
      .slice(0, MAX_ACCOUNTS * 2)
    return unique(listed.map(entry => parseAccount(entry, false)))
  }
  const chainAccounts = () => {
    if (!current) return []
    const accounts = sessionAccounts(current)
    if (exposed) {
      const listed = new Set(accounts.map(a => a.toLowerCase()))
      return exposed.filter(a => listed.has(a.toLowerCase()))
    }
    // the account handed out by eth_requestAccounts comes first (the integration compares accounts[0])
    if (handedOut) {
      const index = accounts.findIndex(a => a.toLowerCase() === handedOut.toLowerCase())
      if (index > 0) accounts.unshift(...accounts.splice(index, 1))
    }
    return accounts
  }
  const usable = () => alive(current) && chainAccounts().length > 0

  const adopt = topic => {
    current = topic
    handedOut = null
    exposed = null
    lastAccounts = []
  }
  // the session is gone: the integration hears [] once
  const lost = () => {
    current = null
    handedOut = null
    exposed = null
    if (!lastAccounts.length) return
    lastAccounts = []
    emit([])
  }
  // emit only when the sign-in chain's accounts change; a network switch in the wallet changes nothing here
  const sync = () => {
    if (!alive(current)) return lost()
    const accounts = chainAccounts()
    const same =
      accounts.length === lastAccounts.length &&
      accounts.every((account, i) => account.toLowerCase() === lastAccounts[i].toLowerCase())
    if (same) return
    lastAccounts = accounts
    emit(accounts)
  }

  // End one session: at once here, then on the relay, for at most endWaitMs. If the relay cannot be told
  // (offline, or no answer), the session is also dropped from this browser's storage, so neither a new
  // attempt nor a reload brings it back. Nothing waits on that storage write.
  const endSession = async topic => {
    if (!topic || ended.has(topic)) return
    ended.add(topic)
    let timer
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => client.disconnect({ topic, reason: USER_DISCONNECTED }))
        .then(
          () => 'done',
          () => 'failed'
        ),
      new Promise(resolve => {
        timer = setTimeout(() => resolve('timeout'), endWaitMs)
      }),
    ])
    clearTimeout(timer)
    if (outcome === 'done') return
    Promise.resolve()
      .then(() => client.session.delete(topic, USER_DISCONNECTED))
      .catch(ignore)
  }
  const disconnect = async () => {
    const topic = current
    lost()
    await endSession(topic)
  }
  const pairingTopicOf = uri => (typeof uri === 'string' && uri.startsWith('wc:') ? uri.slice(3, uri.indexOf('@')) : '')
  // sessions a pairing left behind that are not the one in use: one it settled after it was given up, or one
  // the SDK stored although the settlement then failed (its approval never resolves)
  const endLeftovers = pairing => {
    if (!pairing) return
    for (const session of client.session.getAll()) {
      if (session?.pairingTopic === pairing && session.topic !== current) endSession(session.topic).catch(ignore)
    }
  }
  // a pairing given up: its proposal expires now (the SDK's wait for the wallet ends instead of running out
  // its five minutes), and what it settled is ended. The pairing topic itself is left to the SDK's own
  // five-minute expiry.
  const endPairing = uri => {
    const topic = pairingTopicOf(uri)
    if (!topic) return
    try {
      for (const proposal of client.proposal.getAll()) {
        if (proposal.pairingTopic === topic) client.core.expirer.set(proposal.id, 0)
      }
    } catch {
      // the SDK gives up on it by itself later
    }
    endLeftovers(topic)
  }
  const normalize = err => {
    const message = typeof err?.message === 'string' ? err.message : String(err ?? '')
    if (REJECTED.has(err?.code) || /reject|denied|cancel/i.test(message)) {
      return rpcError(4001, 'The request was rejected in the wallet.')
    }
    if (!alive(current)) {
      lost()
      return rpcError(4100, 'The WalletConnect session ended.')
    }
    return err instanceof Error ? err : rpcError(err?.code ?? -32603, message || 'WalletConnect request failed')
  }

  // Only the session in use counts. The wallet reports account changes as session events, per chain (the
  // session's namespaces stay as they were); only the sign-in chain's count.
  client.on('session_event', args => {
    const params = args?.params
    if (args?.topic !== current || !alive(current)) return
    if (params?.event?.name !== 'accountsChanged' || params.chainId !== chain) return
    if (!Array.isArray(params.event.data)) return
    exposed = unique(params.event.data.slice(0, MAX_ACCOUNTS).map(entry => parseAccount(entry, true)))
    sync()
  })
  // SignClient has already stored the new namespaces
  client.on('session_update', args => {
    if (args?.topic === current) sync()
  })
  for (const name of ['session_delete', 'session_expire']) {
    client.on(name, args => {
      if (args?.topic === current) lost()
    })
  }

  // a session from this browser's storage that can still sign in: reused without a new QR
  {
    const stored = client.session
      .getAll()
      .filter(session => session?.topic && sessionAccounts(session.topic).length && alive(session.topic))
      .sort((a, b) => (b.expiry ?? 0) - (a.expiry ?? 0))
    if (stored.length) adopt(stored[0].topic)
  }

  async function pair() {
    // the session in use is reused as long as it can sign in
    if (usable()) {
      handedOut = chainAccounts()[0]
      lastAccounts = chainAccounts()
      return [...lastAccounts]
    }
    // one that cannot (expired, ended, no account on the sign-in chain) goes, in the background. Quietly: the
    // caller asked for accounts, and an [] now would read as the wallet withdrawing them mid-connect.
    const stale = current
    adopt(null)
    endSession(stale).catch(ignore)

    const mine = {}
    let abandoned = false
    let uri = null
    let stop
    const stopped = new Promise((resolve, reject) => {
      stop = reject
    })
    stopped.catch(ignore)
    mine.abandon = error => {
      if (abandoned) return
      abandoned = true
      // a wallet may already have the link: end it now (otherwise as soon as the link comes)
      if (uri) endPairing(uri)
      stop(error)
    }
    attempt = mine
    const until = promise => Promise.race([promise, stopped])
    claimStatus(mine, { state: 'connecting' })
    // the link comes only once the relay answers; without it the wait would never end
    const relayTimer = setTimeout(() => mine.abandon(rpcError(-32000, 'relay_unreachable')), relayWaitMs)
    try {
      const proposed = Promise.resolve()
        .then(() =>
          client.connect({ optionalNamespaces: { eip155: { chains: [chain], methods: METHODS, events: EVENTS } } })
        )
        .then(result => {
          // start waiting for the wallet at once: an expiry before that wait began would be lost in the SDK
          const approval = Promise.resolve(result.approval())
          // what a given-up or failed pairing still brings: its link is ended, a session it settles is closed
          approval
            .then(
              session => (abandoned ? endSession(session?.topic) : undefined),
              () => endLeftovers(pairingTopicOf(result.uri))
            )
            .catch(ignore)
          if (abandoned) endPairing(result.uri)
          return { uri: result.uri, approval }
        })
      proposed.catch(ignore)
      const proposal = await until(proposed)
      uri = proposal.uri
      clearTimeout(relayTimer)
      let qr = null
      try {
        qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(uri, { border: 2 }))}`
      } catch {
        // the links still work without the QR
      }
      status(mine, { state: 'uri', uri, qr })
      const session = await until(proposal.approval)
      adopt(session?.topic ?? null)
      const accounts = chainAccounts()
      if (!accounts.length) {
        const topic = current
        adopt(null)
        endSession(topic).catch(ignore)
        throw rpcError(4901, 'The wallet did not connect on the sign-in network.')
      }
      handedOut = accounts[0]
      lastAccounts = chainAccounts()
      status(mine, { state: 'connected' })
      return [...lastAccounts]
    } catch (err) {
      // our own outcomes pass as they are; the wallet's and the relay's are normalised
      if (err?.code === 4901 || err?.message === 'relay_unreachable') throw err
      throw normalize(err)
    } finally {
      clearTimeout(relayTimer)
      if (attempt === mine) attempt = null
    }
  }

  async function connect() {
    if (connecting) return connecting
    const mine = pair()
    connecting = mine
    try {
      return await mine
    } finally {
      if (connecting === mine) connecting = null
    }
  }

  async function request({ method, params } = {}) {
    switch (method) {
      case 'eth_requestAccounts':
        return connect()
      case 'eth_accounts':
        return alive(current) ? chainAccounts() : []
      case 'eth_chainId':
        return usable() ? `0x${chainId.toString(16)}` : '0x0'
      case 'wallet_switchEthereumChain': {
        const target = Array.isArray(params) ? params[0]?.chainId : undefined
        if (typeof target === 'string' && Number(target) === chainId && usable()) return null
        throw rpcError(4902, 'The chain is not part of this WalletConnect session.')
      }
      case 'wallet_addEthereumChain':
        throw rpcError(4200, 'Not supported over WalletConnect.')
      case 'wallet_revokePermissions':
        await disconnect()
        return null
      case 'personal_sign':
      case 'eth_sendTransaction': {
        if (!alive(current)) {
          lost()
          throw rpcError(4100, 'The WalletConnect session ended.')
        }
        const mine = {}
        claimStatus(mine, { state: 'request', method })
        try {
          return await client.request({ topic: current, chainId: chain, request: { method, params } })
        } catch (err) {
          throw normalize(err)
        } finally {
          status(mine, { state: 'idle' })
        }
      }
      default:
        throw rpcError(4200, `${method} is not supported over WalletConnect.`)
    }
  }

  return {
    isWalletConnect: true,
    request,
    on(name, listener) {
      listeners[name]?.add(listener)
    },
    removeListener(name, listener) {
      listeners[name]?.delete(listener)
    },
    // give up a connection that is still waiting (Cancel, another wallet, the page going away)
    cancel() {
      if (!attempt) return
      attempt.abandon(rpcError(4001, 'Connection cancelled.'))
      // a connection asked for right after this starts afresh instead of joining the cancelled one
      connecting = null
    },
    disconnect,
    hasSession: usable,
    // the connected wallet's own link (validated), for the "Open wallet" button
    walletRedirect: () => (alive(current) ? safeRedirect(getSession(current)?.peer?.metadata?.redirect) : null),
  }
}
