import { isEvmAddress, isEvmSigninSignature, parseEvmChainIds, sameEvmAddress } from '../core/extras/evmChains'
import { encodeTransfer, isTxHash } from '../core/extras/evmAbi'
import { KNOWN_CHAINS, explorerTxUrl, parseTipAmount, parseTipTokens, tipAmountReason } from '../core/extras/evmTokens'
import { WALLET_LINKS, isAppScheme, sameHost } from '../core/extras/walletLinks'
import {
  clearTipMarker,
  readTipMarkers,
  shortTipAddress,
  tipErrorOutcome,
  tipUnknownOutcome,
  writeTipMarker,
} from '../core/extras/tipOutcome'

// EVM ウォレット (EIP-1193 / EIP-6963) の所有証明。依存ライブラリなし。
// 流れと世代管理は solana-integration.js と同じ。状態は Solana と独立で、ビルド権限には関与しない

// nonce / 検証結果を待つ上限 (サーバーのクールダウンは 5 秒)
const NONCE_WAIT_MS = 15000
const ACK_WAIT_MS = 15000
const INTENT_WAIT_MS = 10000
// How long the "not confirming" step's answer can act on the intent it was shown for: 5 minutes of time elapsed
// in this page since the intent arrived (performance.now(), which a change of the wall clock does not move). The
// server keeps the tip request (its ticket) for 10 minutes from when it issued it (TIP_TICKET_TTL_MS = 600_000,
// evm-gating.js), and the intent carries neither that time nor an expiry; half of it leaves the wallet's prompt
// and the report of the hash the rest. A later answer asks nothing of the wallet: the form does not act on a
// request that old, and Send tip asks the server for a new one.
const UNCONFIRMED_ANSWER_MS = 300_000
// 発見したウォレットの保持上限と、受け入れるアイコンの大きさ
const MAX_PROVIDERS = 16
const MAX_ICON_LENGTH = 64 * 1024
const INJECTED_ID = 'injected'
// WalletConnect (Reown): an extra wallet entry, loaded only when picked (src/client/walletconnect.js)
const WALLETCONNECT_ID = 'walletconnect'
const WALLETCONNECT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%233b99fc'/%3E%3Cpath d='M9.6 12.4a9.1 9.1 0 0 1 12.8 0l.4.4a.4.4 0 0 1 0 .6l-1.5 1.5a.2.2 0 0 1-.3 0l-.6-.6a6.4 6.4 0 0 0-8.8 0l-.7.6a.2.2 0 0 1-.3 0l-1.5-1.5a.4.4 0 0 1 0-.6zm15.9 2.9 1.3 1.3a.4.4 0 0 1 0 .6l-6 5.9a.5.5 0 0 1-.6 0l-4.2-4.2a.1.1 0 0 0-.2 0l-4.2 4.2a.5.5 0 0 1-.6 0l-6-5.9a.4.4 0 0 1 0-.6l1.3-1.3a.5.5 0 0 1 .6 0l4.2 4.2a.1.1 0 0 0 .2 0l4.2-4.2a.5.5 0 0 1 .6 0l4.2 4.2a.1.1 0 0 0 .2 0l4.2-4.2a.5.5 0 0 1 .6 0z' fill='%23fff'/%3E%3C/svg%3E"

// solana-integration.js と同じく、ビルド時の process.env と実行時の globalThis.env (/env.js) の両方を見る
const resolveEnv = key => {
  const fromBuild = typeof process !== 'undefined' ? process.env?.[key] : undefined
  const fromRuntime = typeof globalThis !== 'undefined' ? globalThis.env?.[key] : undefined
  return fromBuild ?? fromRuntime
}

const buildConfig = () => {
  const chainIds = parseEvmChainIds(resolveEnv('PUBLIC_EVM_CHAIN_IDS'))
  // 投げゼニのチェーンは SIWE と同じ先頭チェーン
  const tipTokens = chainIds.length ? parseTipTokens(resolveEnv('PUBLIC_EVM_TIP_TOKENS'), chainIds[0]) : []
  // Reown のプロジェクト ID (公開値)。形が違えば WalletConnect は出さない
  const projectId = resolveEnv('PUBLIC_WALLETCONNECT_PROJECT_ID')
  const walletConnectProjectId = typeof projectId === 'string' && /^[0-9a-f]{32}$/i.test(projectId) ? projectId : null
  return { chainIds, tipTokens, walletConnectProjectId }
}

export const isEvmConfigured = () => buildConfig().chainIds.length > 0

// personal_sign には UTF-8 の 16 進表現を渡す (ウォレットは復号して全文を表示する)
const utf8ToHex = text => {
  let hex = '0x'
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

const failureMessage = (reason, error) => {
  if (error?.walletConnectLoad) return 'WalletConnect could not load. Reload the page and try again.'
  if (error?.message === 'relay_unreachable')
    return 'Could not reach WalletConnect. Check your connection and try again.'
  if (error?.code === 4901)
    return 'The wallet did not connect on the sign-in network. Choose it in the wallet and try again.'
  if (error?.code === 4001) return 'Request rejected in the wallet.'
  if (reason === 'nonce_expired') return 'Signature expired. Please sign again.'
  // not an ordinary wallet's signature, and this world cannot check smart-contract wallets (no RPC)
  if (reason === 'contract_unsupported') {
    return 'Signature not accepted. Smart-contract wallets are not supported in this world.'
  }
  if (reason === 'unavailable') return "Could not check the wallet's signature right now. Please try again."
  if (reason === 'signature_invalid') return 'Signature not accepted. Please sign again.'
  return 'Could not verify your EVM wallet. Please sign again.'
}

const isTipTicket = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

// loadWalletConnect: replaced in tests; in the browser it loads src/client/walletconnect.js on demand.
// tipStorage: returns the Storage that keeps the notes of tip requests (tipOutcome.js); replaced in tests.
// pageClock: the time elapsed in this page, in ms (performance.now); replaced in tests
export function createEvmIntegration(
  world,
  { loadWalletConnect = () => import('./walletconnect.js'), tipStorage, pageClock = () => performance.now() } = {}
) {
  const config = buildConfig()
  if (!config.chainIds.length) return null

  const win = typeof window !== 'undefined' ? window : null
  // read on each use: reading localStorage can itself throw (every use is inside tipOutcome.js's try)
  const markerStorage = tipStorage ?? (() => win.localStorage)
  const discovered = new Map()
  let generation = 0
  let nextAttempt = 0
  let active = null
  let provider = null
  let disposed = false
  let status = 'disconnected'
  let address = null
  let verified = false
  // 最後に選ばれたウォレット。パネルが作り直されても再署名は同じウォレットで行う
  let selectedId = null
  let nextIntent = 0
  let tipping = false
  // whether the world confirms tips, as it last said (sign-in, a tip intent, a tip's status); null: not said
  let tipsConfirmed = null
  // WalletConnect: the adapter once loaded, and its last status for the panel ({ state, uri?, qr?, method? })
  let walletConnect = null
  let walletConnectLoading = null
  let walletConnectStatus = null
  // the wallet app the player tapped to connect (a WALLET_LINKS id), for "Open wallet" if the wallet sends no
  // app scheme of its own. Cleared by a new pairing link, and by Copy link or the QR (another wallet may take it)
  let walletConnectChoice = null

  const getState = () => ({ status, address, verified })
  const publish = () => world.emit('evm:state', getState())
  const current = run => !disposed && !world.fatalError && active === run && generation === run.generation
  const send = (name, data) => {
    try {
      return world.network.send(name, data) === true
    } catch {
      return false
    }
  }
  const clearAttempt = () => {
    if (!active) return
    for (const cleanup of active.cleanups) cleanup()
    active.cleanups.clear()
    active = null
  }

  // プロバイダーを待つ前に必ず同期で無効化する
  const invalidate = reason => {
    generation++
    clearAttempt()
    verified = false
    if (reason !== 'attempt' && reason !== 'failure') address = null
    status = address ? 'unverified' : 'disconnected'
  }

  const setWalletConnectStatus = value => {
    walletConnectStatus = value ?? null
    // a new pairing link: the wallet tapped for an earlier one says nothing about who takes this one
    if (walletConnectStatus?.state === 'uri') walletConnectChoice = null
    world.emit('evm:walletconnect', walletConnectStatus)
  }

  const fail = (run, error) => {
    if (!current(run)) return
    const reason = run.reason
    const viaWalletConnect = !!provider?.isWalletConnect || !!error?.walletConnectLoad
    // close the WalletConnect steps whatever stage they reached (also a load that never produced a wallet)
    if (viaWalletConnect || (walletConnectStatus && walletConnectStatus.state !== 'idle')) {
      setWalletConnectStatus({ state: 'idle' })
    }
    invalidate('failure')
    status = address ? 'unverified' : 'disconnected'
    // サーバーとの試行を始めていたら取り下げる。検証結果が待ち時間の後に届いた場合でも、
    // サーバーだけが検証済みのまま残らない (失敗済みならサーバー側は何もしない)
    if (run.id) send('revokeEvmWallet', {})
    publish()
    world.emit('toast', failureMessage(reason, error))
  }

  // EIP-6963: 拡張機能ごとに 1 つずつ名乗り出る。中身は信頼せず、形だけ確かめて保持する
  const onAnnounce = event => {
    const detail = event?.detail
    const info = detail?.info
    const announced = detail?.provider
    if (disposed || !info || typeof info.uuid !== 'string' || !info.uuid || info.uuid.length > 128) return
    if (typeof announced?.request !== 'function') return
    const known = discovered.get(info.uuid)
    // 既知の uuid の名乗り直しはすべて無視する (最初の紐付けを固定する)。同じ provider なら何も変わらず、
    // 別の provider で既存の名前とアイコンを乗っ取る announce は捨てられる
    if (known) return
    if (discovered.size >= MAX_PROVIDERS) return
    const icon =
      typeof info.icon === 'string' && info.icon.startsWith('data:image/') && info.icon.length <= MAX_ICON_LENGTH
        ? info.icon
        : null
    const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 64) : 'Wallet'
    discovered.set(info.uuid, { id: info.uuid, name, icon, provider: announced })
    world.emit('evm:providers')
  }

  const getProviders = () => {
    const list = [...discovered.values()].map(({ id, name, icon }) => ({ id, name, icon }))
    if (!list.length && typeof win?.ethereum?.request === 'function') {
      list.push({ id: INJECTED_ID, name: 'Browser wallet', icon: null })
    }
    if (config.walletConnectProjectId)
      list.push({ id: WALLETCONNECT_ID, name: 'WalletConnect', icon: WALLETCONNECT_ICON })
    return list
  }

  // the adapter is created once and kept: its session survives a new attempt (and a reload, in storage)
  const ensureWalletConnect = async () => {
    if (walletConnect) return walletConnect
    walletConnectLoading ??= (async () => {
      let module
      try {
        module = await loadWalletConnect()
      } catch {
        throw Object.assign(new Error('WalletConnect could not load'), { walletConnectLoad: true })
      }
      return module.createWalletConnectProvider({
        projectId: config.walletConnectProjectId,
        chainId: config.chainIds[0],
        origin: win?.location?.origin,
        onStatus: setWalletConnectStatus,
      })
    })()
    try {
      walletConnect = await walletConnectLoading
      return walletConnect
    } finally {
      walletConnectLoading = null
    }
  }

  const pickProvider = requested => {
    const id = requested ?? selectedId
    if (id && discovered.has(id)) return discovered.get(id).provider
    if (discovered.size === 1 && (!id || id === INJECTED_ID)) return [...discovered.values()][0].provider
    if ((!id || id === INJECTED_ID) && !discovered.size) return win?.ethereum ?? null
    return null
  }

  // クールダウンの再送を含め、nonce 待ちは合計 15 秒まで
  const waitForNonce = run =>
    new Promise(resolve => {
      let retried = false
      let retryTimer
      const finish = value => {
        clearTimeout(timer)
        clearTimeout(retryTimer)
        world.off('evm:nonce', onNonce)
        run.cleanups.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(null)
      const onNonce = data => {
        if (!current(run) || data?.attempt !== run.id) return
        if ('retryAfterMs' in data) {
          if (retried || !Number.isFinite(data.retryAfterMs) || data.retryAfterMs <= 0 || data.retryAfterMs > 5000) {
            return finish(null)
          }
          retried = true
          retryTimer = setTimeout(() => {
            if (!current(run) || !send('requestEvmNonce', { address, attempt: run.id })) finish(null)
          }, data.retryAfterMs)
          return
        }
        if (
          typeof data.nonce !== 'string' ||
          data.nonce.length !== 64 ||
          !/^[a-f0-9]{64}$/.test(data.nonce) ||
          typeof data.message !== 'string'
        ) {
          return finish(null)
        }
        const length = new TextEncoder().encode(data.message).length
        if (!length || length > 1024) return finish(null)
        finish({ nonce: data.nonce, message: data.message })
      }
      const timer = setTimeout(cancel, NONCE_WAIT_MS)
      run.cleanups.add(cancel)
      world.on('evm:nonce', onNonce)
    })

  const waitForAck = run =>
    new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer)
        run.ack = null
        run.cleanups.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(null)
      const timer = setTimeout(cancel, ACK_WAIT_MS)
      run.ack = finish
      run.cleanups.add(cancel)
    })

  // このゲートを通った status だけが状態を変える
  const onWalletStatus = data => {
    if (disposed || world.fatalError || typeof data?.verified !== 'boolean') return
    if (Object.prototype.hasOwnProperty.call(data, 'attempt')) {
      if (!Number.isInteger(data.attempt) || data.attempt < 1 || data.attempt > 0x7fffffff) return
      if (!active || !current(active) || data.attempt !== active.id) return
      // サーバーは EIP-55、ウォレットは小文字のことが多い。大文字小文字を無視して比べる
      if (data.verified && !sameEvmAddress(data.wallet, address)) return
      if (!data.verified && typeof data.reason === 'string') active.reason = data.reason
    } else if (data.verified) {
      return
    }
    verified = data.verified
    if (verified) {
      // 表示はサーバーが付けたチェックサム形にそろえる
      address = data.wallet
      status = 'verified'
      if (typeof data.confirmsTips === 'boolean') tipsConfirmed = data.confirmsTips
    } else if (!active || status === 'verified') {
      status = address ? 'unverified' : 'disconnected'
    }
    active?.ack?.(data)
    publish()
  }

  const onAccountsChanged = accounts => {
    if (disposed || !provider) return
    const next = Array.isArray(accounts) ? accounts[0] : undefined
    // アカウント取得中の通知は覚えておき、取得結果と食い違えば (取り消しの空配列を含む) その試行をやめる
    if (!address) {
      if (active && current(active) && active.id === null) active.accountEvent = isEvmAddress(next) ? next : null
      return
    }
    // 接続直後に同じアカウントで通知するウォレットがある
    if (sameEvmAddress(next, address)) return
    localDisconnect()
    publish()
    world.emit('toast', 'Wallet account changed. Reconnect and sign again.')
  }

  const detachProvider = () => {
    try {
      provider?.removeListener?.('accountsChanged', onAccountsChanged)
    } catch {
      // プロバイダー側の例外でもローカルの破棄を進める
    }
    provider = null
  }

  const localDisconnect = () => {
    invalidate('disconnect')
    send('revokeEvmWallet', {})
    const previous = provider
    detachProvider()
    return previous
  }

  const disconnect = () => {
    const previous = localDisconnect()
    if (previous?.isWalletConnect) setWalletConnectStatus({ state: 'idle' })
    publish()
    // サイトへの接続許可も best effort で取り消す (未対応のウォレットは無視)。await しない
    try {
      Promise.resolve(
        previous?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
      ).catch(() => {})
    } catch {
      // ウォレット側の後始末は best effort
    }
    return true
  }

  const connect = async providerId => {
    if (disposed || world.fatalError) return null
    invalidate('attempt')
    const run = { generation, id: null, cleanups: new Set(), reason: null, accountEvent: undefined }
    active = run
    status = 'connecting'
    publish()
    try {
      detachProvider()
      const wanted = providerId ?? selectedId
      let chosen
      if (wanted === WALLETCONNECT_ID && config.walletConnectProjectId) {
        if (!walletConnect) setWalletConnectStatus({ state: 'loading' })
        chosen = await ensureWalletConnect()
        if (!current(run)) return null
        // a new attempt, a disconnect or dispose stops a connection still waiting for the wallet, and its
        // steps leave the panel (also when the new attempt is another wallet)
        run.cleanups.add(() => {
          chosen.cancel()
          setWalletConnectStatus({ state: 'idle' })
        })
      } else {
        chosen = pickProvider(providerId)
      }
      if (typeof chosen?.request !== 'function') throw new Error('wallet unavailable')
      provider = chosen
      if (providerId) selectedId = providerId
      provider.on?.('accountsChanged', onAccountsChanged)
      const accounts = await chosen.request({ method: 'eth_requestAccounts' })
      if (!current(run)) return null
      const account = Array.isArray(accounts) ? accounts[0] : null
      if (!isEvmAddress(account) || nextAttempt === 0x7fffffff) throw new Error('invalid wallet attempt')
      if (run.accountEvent !== undefined && !sameEvmAddress(run.accountEvent, account)) {
        throw new Error('account changed while connecting')
      }
      address = account
      run.id = ++nextAttempt
      status = 'signing'
      publish()
      const nonceWait = waitForNonce(run)
      if (!send('requestEvmNonce', { address, attempt: run.id })) throw new Error('send refused')
      const challenge = await nonceWait
      if (!current(run)) return null
      if (!challenge) throw new Error('nonce unavailable')
      const signature = await chosen.request({
        method: 'personal_sign',
        params: [utf8ToHex(challenge.message), account],
      })
      if (!current(run)) return null
      if (!isEvmSigninSignature(signature)) throw new Error('invalid signature')
      const ackWait = waitForAck(run)
      if (!send('requestEvmVerify', { address: account, signature, nonce: challenge.nonce, attempt: run.id })) {
        throw new Error('send refused')
      }
      const ack = await ackWait
      if (!current(run)) return null
      if (!ack?.verified || !verified) throw new Error('verification unavailable')
      clearAttempt()
      return address
    } catch (error) {
      fail(run, error)
      return null
    }
  }

  const setReceiveTips = enabled => {
    if (disposed || !verified || !config.tipTokens.length || typeof enabled !== 'boolean') return false
    return send('setEvmTipReceive', { enabled })
  }

  const waitForIntent = id =>
    new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer)
        world.off('evm:tipIntent', onIntent)
        resolve(value)
      }
      const onIntent = data => {
        if (data?.id === id) finish(data)
      }
      const timer = setTimeout(() => finish(null), INTENT_WAIT_MS)
      world.on('evm:tipIntent', onIntent)
    })

  const switchChain = async (wallet, chainId) => {
    const hex = `0x${chainId.toString(16)}`
    const currentChain = await wallet.request({ method: 'eth_chainId' })
    if (typeof currentChain === 'string' && /^0x[0-9a-fA-F]+$/.test(currentChain) && Number(currentChain) === chainId)
      return
    try {
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
    } catch (error) {
      // 4902: ウォレットがこのチェーンを知らない。組み込みのチェーンに限り追加を提案する
      const known = KNOWN_CHAINS[chainId]
      if (error?.code !== 4902 || !known) throw error
      await wallet.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: known.chainId,
            chainName: known.chainName,
            nativeCurrency: { ...known.nativeCurrency },
            rpcUrls: [...known.rpcUrls],
            blockExplorerUrls: [...known.blockExplorerUrls],
          },
        ],
      })
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
    }
    const after = await wallet.request({ method: 'eth_chainId' })
    if (typeof after !== 'string' || !/^0x[0-9a-fA-F]+$/.test(after) || Number(after) !== chainId) {
      throw new Error('wrong chain')
    }
  }

  // 投げゼニ: 受取人のアドレスはサーバーの tip intent から受け取り、ウォレットから直接送る。
  // 送金先は intent の受取人だけ。金額はクライアントでも解析して intent と一致するときだけ送る。
  // 戻り値は { ok: true, txHash, explorerUrl, request } か { ok: false, reason }
  //
  // What the payer is told (tipOutcome.js): `onIntent({ request, confirms })` is called once the intent has
  // arrived and before the wallet is asked anything, with whom the transfer will name (display name and short
  // address) and whether the world says it confirms tips. Once eth_sendTransaction was handed to the wallet,
  // only a transaction hash or an explicit rejection is a known result; anything else is `outcome_unknown`
  // (the transfer may have been sent) and carries the same `request`.
  // When the intent says that the world is not confirming tips and the form had not said so before Send was
  // pressed (`unconfirmedShown`), the send waits before the wallet is asked anything: `onUnconfirmed({ request })`
  // shows that and resolves true when the payer chose "Send anyway". Anything else (no callback, false, a
  // callback that throws) ends the send as `declined`, with nothing asked of the wallet. This does not rely on
  // the screen having been drawn before the wallet's prompt: the prompt cannot come before the payer's choice.
  // "Send anyway" that comes UNCONFIRMED_ANSWER_MS or more (of this page's time) after the intent arrived ends it
  // as `intent_expired`, with nothing asked of the wallet either. The send without that step goes on at once and
  // has no such check.
  const tip = async ({ playerId, token, amount, onIntent, unconfirmedShown = false, onUnconfirmed } = {}) => {
    if (disposed || world.fatalError) return { ok: false, reason: 'unavailable' }
    if (!verified || !address || !provider) return { ok: false, reason: 'not_verified' }
    if (tipping) return { ok: false, reason: 'busy' }
    const info = config.tipTokens.find(entry => entry.symbol === token)
    if (!info || typeof playerId !== 'string') return { ok: false, reason: 'bad_token' }
    let units
    try {
      units = parseTipAmount(amount, info)
    } catch (error) {
      return { ok: false, reason: tipAmountReason(error) }
    }
    tipping = true
    const startedAt = generation
    const wallet = provider
    const from = address
    const stillCurrent = () =>
      !disposed && !world.fatalError && verified && generation === startedAt && provider === wallet
    // 自分の切替の通知が遅れて届くウォレットもあるので、目的のチェーン以外への変更だけを数える
    let chainMoved = false
    const onChainChanged = next => {
      if (typeof next !== 'string' || !/^0x[0-9a-fA-F]+$/.test(next) || Number(next) !== config.chainIds[0]) {
        chainMoved = true
      }
    }
    // what the wallet is asked for, whether it has been asked, and the id of the note of the request (or null)
    let request = null
    let requested = false
    let markerId = null
    try {
      if (nextIntent === 0x7fffffff) nextIntent = 0
      const id = ++nextIntent
      const intentWait = waitForIntent(id)
      if (!send('requestEvmTipIntent', { id, to: playerId, token: info.symbol, amount })) {
        return { ok: false, reason: 'unavailable' }
      }
      const intent = await intentWait
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      if (!intent) return { ok: false, reason: 'timeout' }
      if (intent.ok !== true)
        return { ok: false, reason: typeof intent.reason === 'string' ? intent.reason : 'refused' }
      const chainId = config.chainIds[0]
      if (
        intent.to !== playerId ||
        intent.chainId !== chainId ||
        !isEvmAddress(intent.recipient) ||
        sameEvmAddress(intent.recipient, from) ||
        !sameEvmAddress(intent.token?.address, info.address) ||
        intent.token?.decimals !== info.decimals ||
        intent.units !== units.toString()
      ) {
        return { ok: false, reason: 'mismatch' }
      }
      // サーバーの控え (P2b)。送金後にこれで tx を報告し、確定の結果を受け取る。無い (古いサーバー) なら報告しない
      const ticket = isTipTicket(intent.ticket) ? intent.ticket : null
      if (typeof intent.confirms === 'boolean') tipsConfirmed = intent.confirms
      const name = world.entities?.players?.get(playerId)?.data?.name
      request = Object.freeze({
        name: typeof name === 'string' ? name : '',
        address: shortTipAddress(intent.recipient),
        amount,
        token: info.symbol,
        at: Date.now(),
      })
      try {
        onIntent?.({ request, confirms: tipsConfirmed })
      } catch {
        // the screen's problem, not the send's
      }
      if (intent.confirms === false && unconfirmedShown !== true) {
        // the intent has just arrived (nothing has been awaited since)
        const shownAt = pageClock()
        let go = false
        try {
          go = (await onUnconfirmed?.({ request })) === true
        } catch {
          // no choice was made: nothing is sent
        }
        if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
        if (!go) return { ok: false, reason: 'declined' }
        if (pageClock() - shownAt >= UNCONFIRMED_ANSWER_MS) return { ok: false, reason: 'intent_expired' }
      }
      // ウォレットの今のアカウントが検証済みアドレスであること
      const accounts = await wallet.request({ method: 'eth_accounts' })
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      if (!Array.isArray(accounts) || !sameEvmAddress(accounts[0], from)) return { ok: false, reason: 'wrong_account' }
      await switchChain(wallet, chainId)
      // 確認した後にウォレットがチェーンを変えたら送らない。送る tx にも chainId を入れ、
      // 違うチェーンならウォレット側で拒否させる (EIP-1193 の eth_sendTransaction の chainId)
      wallet.on?.('chainChanged', onChainChanged)
      if (!stillCurrent()) return { ok: false, reason: 'cancelled' }
      if (chainMoved) return { ok: false, reason: 'chain_changed' }
      // the note goes first: a page that is gone when the wallet answers (a reload on the way back from the
      // wallet app, a lost connection) has nothing else left of this request. Its time is now, not when the
      // intent came: the account and network prompts and the "not confirming" step before this can take minutes
      markerId = writeTipMarker(markerStorage, { ...request, at: Date.now() })
      requested = true
      const txHash = await wallet.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from,
            to: info.address,
            data: encodeTransfer(intent.recipient, units),
            value: '0x0',
            chainId: `0x${chainId.toString(16)}`,
          },
        ],
      })
      // not a transaction hash (some smart wallets answer with something else): nothing to report or to link,
      // and no reason to think that nothing was sent
      if (!isTxHash(txHash)) return tipUnknownOutcome(request)
      // 確定の確認はサーバーがチェーンで行う (別のチェーンに出ていれば見つからず、未確認になる)
      const reported = ticket ? send('evmTip', { ticket, txHash }) : false
      // the result reached the world: the note has done its work (if it is still this request's). A hash that
      // could not be handed over (the connection went meanwhile) leaves it, for the page that comes after this one
      if (reported) clearTipMarker(markerStorage, markerId)
      // 送信中に切り替わった場合、どのチェーンに出たか分からないのでリンクは出さない
      if (chainMoved) {
        return { ok: true, txHash, explorerUrl: null, warning: 'chain_changed', ticket, reported, request }
      }
      return { ok: true, txHash, explorerUrl: explorerTxUrl(chainId, txHash), ticket, reported, request }
    } catch (error) {
      const outcome = tipErrorOutcome(error, requested, request)
      // an explicit rejection after the request is a known result too
      if (requested && outcome.reason === 'rejected') clearTipMarker(markerStorage, markerId)
      return outcome
    } finally {
      try {
        wallet.removeListener?.('chainChanged', onChainChanged)
      } catch {
        // プロバイダー側の例外は無視
      }
      tipping = false
      // the notice (TipMarkerNotice) shows what is left of this request, if anything
      if (requested) tellTipMarkers()
    }
  }

  // the notes of requests whose result this world did not get, newest first, each for ten minutes
  // (tipOutcome.js); [] when there are none
  const getTipMarkers = () => readTipMarkers(markerStorage, Date.now())
  const tellTipMarkers = () => {
    try {
      world.emit('evm:tipMarkers', getTipMarkers())
    } catch {
      // a listener's error must not turn a tip's result into a failure
    }
  }
  // Dismiss of one note: the key of the note with the id the notice shows it beside, and no other note's
  const dismissTipMarker = id => {
    clearTipMarker(markerStorage, id)
    tellTipMarkers()
  }

  // サーバーから届いた投げゼニの状態をチケットごとに控える (表示が購読する前に届いても失わない)
  const tipStatuses = new Map()
  const onTipStatus = data => {
    if (!isTipTicket(data?.ticket) || typeof data.state !== 'string') return
    // a tip of this player's that the world could not confirm for want of an RPC or of finality: the next
    // confirmation step says so before the server is asked again
    if (data.state === 'unverified' && (data.reason === 'no_rpc' || data.reason === 'no_finality')) {
      tipsConfirmed = false
    }
    tipStatuses.delete(data.ticket)
    if (tipStatuses.size >= 32) tipStatuses.delete(tipStatuses.keys().next().value)
    tipStatuses.set(data.ticket, Object.freeze({ ...data }))
  }
  const getTipStatus = ticket => tipStatuses.get(ticket) ?? null

  // 確認できなかった投げゼニを 1 回だけ報告し直す (サーバー側も 1 回まで)
  const rechecked = new Set()
  const recheckTip = (ticket, txHash) => {
    if (disposed || !isTipTicket(ticket) || !isTxHash(txHash) || rechecked.has(ticket)) return false
    if (rechecked.size >= 64) rechecked.clear()
    rechecked.add(ticket)
    return send('evmTip', { ticket, txHash })
  }

  // the panel's Cancel while WalletConnect waits for the wallet: stop this attempt, without a toast
  const cancelConnect = () => {
    if (disposed || !active || !current(active)) return false
    const run = active
    invalidate('attempt')
    // given up while signing: withdraw the server attempt too, as a failure would. The wallet stays attached
    // then (as after a failure), so Sign uses it again and Disconnect ends its session.
    if (run.id) send('revokeEvmWallet', {})
    if (!address) detachProvider()
    setWalletConnectStatus({ state: 'idle' })
    publish()
    return true
  }

  // the link that opens the connected wallet app, for "Open wallet": the wallet's own app scheme (validated by
  // the adapter), else the scheme of the listed wallet the player tapped to connect, else the wallet's own
  // universal link. A scheme opens the installed app; a universal link can end on the App Store instead. The
  // tapped wallet's scheme stands in only when the connected wallet sent no link or a link on that wallet's
  // host: another wallet may have taken the pairing link.
  const getWalletConnectRedirect = () => {
    const own = walletConnect?.walletRedirect() ?? null
    if (isAppScheme(own)) return own
    const tapped = WALLET_LINKS.find(wallet => wallet.id === walletConnectChoice)
    if (tapped && (!own || sameHost(own, tapped.universal))) return tapped.native
    return own
  }
  const setWalletConnectChoice = id => {
    walletConnectChoice = WALLET_LINKS.some(wallet => wallet.id === id) ? id : null
  }

  const dispose = reason => {
    if (disposed) return
    disposed = true
    invalidate(reason)
    detachProvider()
    world.off('evm:walletStatus', onWalletStatus)
    world.off('evm:tipStatus', onTipStatus)
    tipStatuses.clear()
    win?.removeEventListener?.('eip6963:announceProvider', onAnnounce)
    discovered.clear()
    // 接続が終わったことを表示にも伝える (パネルが検証済みのまま残らないように)
    publish()
  }

  world.on('evm:walletStatus', onWalletStatus)
  world.on('evm:tipStatus', onTipStatus)
  win?.addEventListener?.('eip6963:announceProvider', onAnnounce)
  try {
    win?.dispatchEvent?.(new Event('eip6963:requestProvider'))
  } catch {
    // 発見できなくても window.ethereum へのフォールバックが残る
  }

  world.evm = {
    getConfig: () => ({ chainIds: [...config.chainIds] }),
    getTipTokens: () =>
      config.tipTokens.map(({ symbol, decimals, min, max }) =>
        max === undefined ? { symbol, decimals, min } : { symbol, decimals, min, max }
      ),
    setReceiveTips,
    tip,
    recheckTip,
    getTipStatus,
    getTipsConfirmed: () => tipsConfirmed,
    getTipMarkers,
    dismissTipMarker,
    getState,
    getProviders,
    connect,
    cancelConnect,
    disconnect,
    getWalletConnectStatus: () => walletConnectStatus,
    getWalletConnectRedirect,
    setWalletConnectChoice,
    dispose,
    isConnected: () => !!address,
    isVerified: () => verified,
    getAddress: () => address,
  }
  return world.evm
}
