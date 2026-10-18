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

const isWalletAddress = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)

// Solana統合ファイル (named export)
export function createSolanaIntegration(world) {
  const config = buildConfig()

  // feature-flag: tokenMint 未設定なら統合を初期化しない (world.solana も生やさない)
  if (!config.tokenMint) {
    console.log('[Solana] tokenMint 未設定のため統合を無効化')
    return null
  }

  console.log('[Solana] Config loaded:', config)

  // 接続状態を追跡
  let isConnected = false
  let walletAddress = null
  let noncePending = false
  // サーバーはクールダウン中の nonce 要求に返事をしないので、待ちっぱなしにしない
  let nonceTimer = null
  const clearNonceWait = () => {
    clearTimeout(nonceTimer)
    nonceTimer = null
  }
  const refuse = () => {
    clearNonceWait()
    noncePending = false
    world.emit('toast', 'ウォレットのリクエストを送信できませんでした')
    return false
  }

  // ウォレット所有証明フロー:
  // 1) サーバーに nonce を要求 2) 署名 3) 署名付きで権限リクエスト
  // 実際のビルダー権限付与はサーバーが on-chain 残高を検証して行う
  const requestBuilderAccess = () => {
    if (!world.network || !walletAddress || noncePending) return
    if (!isWalletAddress(walletAddress)) return refuse()
    noncePending = true
    if (!world.network.send('requestBuilderNonce', { walletAddress })) return refuse()
    nonceTimer = setTimeout(() => {
      nonceTimer = null
      noncePending = false
    }, NONCE_WAIT_MS)
  }

  const onBuilderNonce = async nonce => {
    if (!noncePending) return
    clearNonceWait()
    if (typeof nonce !== 'string' || !nonce.length || nonce.length > 128) return refuse()
    if (!isWalletAddress(walletAddress)) return refuse()
    const address = walletAddress
    try {
      if (typeof window === 'undefined' || !window.solana?.signMessage) {
        world.emit('toast', 'ウォレットがメッセージ署名に対応していません')
        return
      }
      const message = new TextEncoder().encode(nonce)
      const signed = await window.solana.signMessage(message, 'utf8')
      // Phantom等は { signature: Uint8Array } を返す。生の Uint8Array の場合も許容
      const sigBytes = signed?.signature ?? signed
      if (!(sigBytes instanceof Uint8Array) && !Array.isArray(sigBytes)) return refuse()
      if (!sigBytes.length || sigBytes.length > 128) return refuse()
      if (!sigBytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return refuse()
      if (address !== walletAddress) return refuse()
      const signature = uint8ToBase64(sigBytes instanceof Uint8Array ? sigBytes : Uint8Array.from(sigBytes))
      if (!world.network.send('requestBuilderByToken', { walletAddress, signature, nonce })) return refuse()
    } catch (error) {
      console.error('[Solana] 署名エラー:', error)
      world.emit('toast', 'ウォレット署名に失敗しました')
    } finally {
      noncePending = false
    }
  }
  world.on('solana:builderNonce', onBuilderNonce)

  // Solanaオブジェクトをワールドに追加
  world.solana = {
    getConfig: () => ({ ...config }),

    connect: async () => {
      try {
        if (typeof window === 'undefined' || !window.solana) {
          console.error('Solanaプロバイダーが見つかりません')
          world.emit('toast', 'Solanaウォレットが見つかりません')
          return null
        }
        await window.solana.connect()
        const publicKey = window.solana.publicKey.toString()
        if (!isWalletAddress(publicKey)) {
          refuse()
          return null
        }
        isConnected = true
        walletAddress = publicKey
        console.log('Solanaウォレット接続成功:', publicKey)
        world.emit('solana:connected', publicKey)
        // サーバーに所有証明+権限リクエスト
        requestBuilderAccess()
        return publicKey
      } catch (error) {
        noncePending = false
        console.error('Solanaウォレット接続エラー:', error)
        world.emit('toast', 'ウォレット接続に失敗しました')
        return null
      }
    },

    disconnect: async () => {
      try {
        if (typeof window !== 'undefined' && window.solana) {
          await window.solana.disconnect()
        }
        // サーバーに権限剥奪をリクエスト (自己降格)
        if (world.network) {
          if (!world.network.send('revokeBuilderByToken', {})) refuse()
        }
        isConnected = false
        walletAddress = null
        clearNonceWait()
        noncePending = false
        console.log('Solanaウォレット切断完了')
        world.emit('solana:disconnected')
        return true
      } catch (error) {
        clearNonceWait()
        noncePending = false
        console.error('Solanaウォレット切断エラー:', error)
        world.emit('toast', 'ウォレット切断に失敗しました')
        return false
      }
    },

    isConnected: () => isConnected,
    getAddress: () => walletAddress,
    // ブラウザでは残高を取得しない。null は取得不可を表す
    getTokenBalance: () => null,
    getRequiredTokenAmount: () => config.requiredTokenAmount,

    // サーバーへ所有証明とビルダー権限を再リクエスト
    refreshBalance: async () => {
      requestBuilderAccess()
    },
  }

  return world.solana
}
