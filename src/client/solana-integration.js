import { PublicKey } from '@solana/web3.js'
import { Ranks } from '../core/extras/ranks'

// デフォルト設定
// nonce の返事を待つ上限 (サーバーのクールダウンは 5 秒)
const NONCE_WAIT_MS = 15000

const DEFAULT_CONFIG = {
  // HYPERトークンのミントアドレス (未設定なら機能無効)
  tokenMint: null,
  // ビルダー権限に必要な最小トークン量
  requiredTokenAmount: 10000,
}

// 実行時に環境変数を解決する。
// ビルド時に焼き込まれる process.env.PUBLIC_* だけでなく、コンテナ起動時に
// /env.js が注入する globalThis.env も見る (Layers.js と同じ慣習)。
// これが無いと Docker/Fly デプロイ経路では PUBLIC_* がビルド時に存在せず設定不能になる。
const resolveEnv = key => {
  const fromBuild = typeof process !== 'undefined' ? process.env?.[key] : undefined
  const fromRuntime = typeof globalThis !== 'undefined' ? globalThis.env?.[key] : undefined
  return fromBuild ?? fromRuntime
}

// 数値env解決 (0 を明示的に設定できるよう Number.isFinite を使う)
const resolveNum = (key, fallback) => {
  const raw = resolveEnv(key)
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const buildConfig = () => ({
  ...DEFAULT_CONFIG,
  tokenMint: resolveEnv('PUBLIC_TOKEN_MINT') ?? DEFAULT_CONFIG.tokenMint,
  requiredTokenAmount: resolveNum('PUBLIC_REQUIRED_TOKEN_AMOUNT', DEFAULT_CONFIG.requiredTokenAmount),
})

// Solana統合が設定済み (=有効) かどうか
export const isSolanaConfigured = () => !!buildConfig().tokenMint

const uint8ToBase64 = bytes => {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

const isWalletAddress = value => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  try {
    return new PublicKey(value).toBase58() === value
  } catch {
    return false
  }
}

// サーバーの確認状態とビルド権限は独立して扱う
export function createSolanaIntegration(world) {
  const config = buildConfig()
  if (!config.tokenMint) return null

  const balances = world.network.tokenBalance
  let generation = 0
  let nextAttempt = 0
  let active = null
  let provider = null
  let disposed = false
  let status = 'disconnected'
  let address = null
  let verified = false

  const getState = () => ({ status, address, ...balances.peek(), verified })
  const publish = () => world.emit('solana:state', getState())
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
    balances.invalidate()
  }

  const fail = run => {
    if (!current(run)) return
    invalidate('failure')
    status = 'unverified'
    publish()
    world.emit('toast', 'ウォレットを確認できませんでした。もう一度署名してください')
  }

  // クールダウンの再送を含め、nonce 待ちは合計 15 秒まで
  const waitForNonce = run =>
    new Promise(resolve => {
      let retried = false
      let retryTimer
      const finish = value => {
        clearTimeout(timer)
        clearTimeout(retryTimer)
        world.off('solana:builderNonce', onNonce)
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
            if (!current(run) || !send('requestBuilderNonce', { walletAddress: address, attempt: run.id })) finish(null)
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
        const bytes = new TextEncoder().encode(data.message)
        if (!bytes.length || bytes.length > 1024) return finish(null)
        finish({ nonce: data.nonce, bytes })
      }
      const timer = setTimeout(cancel, NONCE_WAIT_MS)
      run.cleanups.add(cancel)
      world.on('solana:builderNonce', onNonce)
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
      const timer = setTimeout(cancel, 15000)
      run.ack = finish
      run.cleanups.add(cancel)
    })

  // このゲートを通った status だけがキャッシュとスクリプトイベントに影響する
  const onWalletStatus = data => {
    if (disposed || world.fatalError || typeof data?.verified !== 'boolean') return
    if (Object.prototype.hasOwnProperty.call(data, 'attempt')) {
      if (!Number.isInteger(data.attempt) || data.attempt < 1 || data.attempt > 0x7fffffff) return
      if (!active || !current(active) || data.attempt !== active.id) return
      if (data.verified && (data.wallet !== address || !isWalletAddress(data.wallet))) return
    } else if (data.verified) {
      return
    }
    verified = data.verified
    if (verified) status = 'verified'
    else if (!active || status === 'verified') status = address ? 'unverified' : 'disconnected'
    balances.invalidate()
    active?.ack?.(data)
    if (world.network.isClient && world.entities.player) {
      world.events.emit('wallet', Object.freeze({ playerId: world.entities.player.data.id, verified }))
    }
    if (verified) void balances.get()
  }

  const detachProvider = () => {
    try {
      if (typeof provider?.off === 'function') provider.off('accountChanged', onAccountChanged)
      else provider?.removeListener?.('accountChanged', onAccountChanged)
    } catch {
      // プロバイダー側の例外でもローカルの破棄を進める
    }
    provider = null
  }
  const disconnect = () => {
    invalidate('disconnect')
    send('revokeBuilderByToken', {})
    const previous = provider
    detachProvider()
    // 切断の拒否・永久待ちがローカル状態を保持しないよう、await しない
    try {
      Promise.resolve(previous?.disconnect?.()).catch(() => {})
    } catch {
      // ウォレット側の後始末は best effort
    }
    return true
  }
  const onAccountChanged = () => {
    if (disposed || !provider) return
    disconnect()
    world.emit('toast', 'ウォレットが変更されました。再接続して署名してください')
  }

  const connect = async () => {
    if (disposed || world.fatalError) return null
    invalidate('attempt')
    const run = { generation, id: null, cleanups: new Set() }
    active = run
    status = 'connecting'
    publish()
    try {
      detachProvider()
      provider = typeof window !== 'undefined' ? window.solana : null
      if (!provider?.connect || !provider?.signMessage) throw new Error('wallet unavailable')
      const wallet = provider
      provider.on?.('accountChanged', onAccountChanged)
      await wallet.connect()
      if (!current(run)) return null
      const publicKey = wallet.publicKey?.toString()
      if (!isWalletAddress(publicKey) || nextAttempt === 0x7fffffff) throw new Error('invalid wallet attempt')
      address = publicKey
      run.id = ++nextAttempt
      status = 'signing'
      publish()
      const nonceWait = waitForNonce(run)
      if (!send('requestBuilderNonce', { walletAddress: address, attempt: run.id })) throw new Error('send refused')
      const challenge = await nonceWait
      if (!current(run)) return null
      if (!challenge) throw new Error('nonce unavailable')
      const signed = await wallet.signMessage(challenge.bytes, 'utf8')
      if (!current(run)) return null
      const signature = signed?.signature ?? signed
      if (!(signature instanceof Uint8Array) && !Array.isArray(signature)) throw new Error('invalid signature')
      if (signature.length !== 64) throw new Error('invalid signature')
      for (const byte of signature) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('invalid signature')
      }
      const ackWait = waitForAck(run)
      if (
        !send('requestBuilderByToken', {
          walletAddress: address,
          signature: uint8ToBase64(signature),
          nonce: challenge.nonce,
          attempt: run.id,
        })
      )
        throw new Error('send refused')
      const ack = await ackWait
      if (!current(run)) return null
      if (!ack?.verified || !verified) throw new Error('verification unavailable')
      clearAttempt()
      return address
    } catch {
      fail(run)
      return null
    }
  }

  const dispose = reason => {
    if (disposed) return
    disposed = true
    invalidate(reason)
    detachProvider()
    world.off('solana:walletStatus', onWalletStatus)
    world.off('solana:balance', publish)
  }
  world.on('solana:walletStatus', onWalletStatus)
  world.on('solana:balance', publish)
  world.solana = {
    getConfig: () => ({ ...config }),
    getState,
    connect,
    disconnect,
    invalidate,
    dispose,
    isConnected: () => !!address,
    isVerified: () => verified,
    getAddress: () => address,
    getTokenBalance: () => balances.get(),
    getRequiredTokenAmount: () => config.requiredTokenAmount,
    refreshBalance: () => {
      if (verified && world.entities.player?.data.rank < Ranks.BUILDER) send('requestBuilderRecheck', {})
      return balances.get({ refresh: true })
    },
  }
  return world.solana
}
