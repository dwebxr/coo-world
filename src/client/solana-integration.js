import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'

// デフォルト設定
const DEFAULT_CONFIG = {
  rpcUrl: 'https://api.devnet.solana.com',
  // HYPERトークンのミントアドレス (例: devnetのテストトークン)
  tokenMint: null,
  // ビルダー権限に必要な最小トークン量
  requiredTokenAmount: 10000,
  // トークンのデシマル (通常は6か9)
  tokenDecimals: 6,
}

// Solana統合ファイル
export default function createSolanaIntegration(world) {
  // 接続状態を追跡
  let isConnected = false
  let walletAddress = null
  let tokenBalance = 0
  let hasBuilderAccess = false

  // 設定を環境変数から読み込み
  const config = {
    ...DEFAULT_CONFIG,
    rpcUrl: process.env.PUBLIC_RPC_URL || DEFAULT_CONFIG.rpcUrl,
    tokenMint: process.env.PUBLIC_TOKEN_MINT || null,
    requiredTokenAmount: Number(process.env.PUBLIC_REQUIRED_TOKEN_AMOUNT) || DEFAULT_CONFIG.requiredTokenAmount,
    tokenDecimals: Number(process.env.PUBLIC_TOKEN_DECIMALS) || DEFAULT_CONFIG.tokenDecimals,
  }

  // Solana RPC接続
  let connection = null
  try {
    connection = new Connection(config.rpcUrl, 'confirmed')
  } catch (error) {
    console.error('Solana RPC接続の初期化に失敗:', error)
  }

  // トークン残高を取得する関数
  const fetchTokenBalance = async walletAddr => {
    if (!connection || !config.tokenMint || !walletAddr) {
      return 0
    }

    try {
      const walletPubkey = new PublicKey(walletAddr)
      const mintPubkey = new PublicKey(config.tokenMint)

      // 関連トークンアカウントのアドレスを取得
      const ataAddress = await getAssociatedTokenAddress(mintPubkey, walletPubkey)

      // トークンアカウントの情報を取得
      const tokenAccount = await getAccount(connection, ataAddress)

      // 残高を計算 (decimalsを考慮)
      const balance = Number(tokenAccount.amount) / Math.pow(10, config.tokenDecimals)
      return balance
    } catch (error) {
      // トークンアカウントが存在しない場合は0を返す
      if (error.name === 'TokenAccountNotFoundError') {
        return 0
      }
      console.error('トークン残高取得エラー:', error)
      return 0
    }
  }

  // ビルダー権限をチェックして更新する関数
  const checkAndUpdateBuilderAccess = async () => {
    if (!walletAddress || !config.tokenMint) {
      hasBuilderAccess = false
      world.emit('solana:builderAccessChanged', false, tokenBalance)
      return false
    }

    const balance = await fetchTokenBalance(walletAddress)
    tokenBalance = balance
    const newHasAccess = balance >= config.requiredTokenAmount

    if (newHasAccess !== hasBuilderAccess) {
      hasBuilderAccess = newHasAccess
      world.emit('solana:builderAccessChanged', hasBuilderAccess, tokenBalance)

      if (hasBuilderAccess) {
        world.emit('toast', `ビルダー権限が付与されました (${balance.toLocaleString()} tokens)`)
        // サーバーにビルダー権限をリクエスト
        requestBuilderRank()
      } else {
        world.emit('toast', `トークンが不足しています (${balance.toLocaleString()} / ${config.requiredTokenAmount.toLocaleString()})`)
      }
    }

    return hasBuilderAccess
  }

  // サーバーにビルダー権限をリクエストする関数
  const requestBuilderRank = () => {
    if (!world.network || !walletAddress) return

    // サーバーにウォレット認証とビルダー権限リクエストを送信
    world.network.send('requestBuilderByToken', {
      walletAddress,
      tokenBalance,
    })
  }

  // Solanaオブジェクトをワールドに追加
  world.solana = {
    // 設定を取得
    getConfig: () => ({ ...config }),

    // ウォレット接続メソッド
    connect: async () => {
      try {
        // ブラウザでSolanaウォレットが利用可能か確認
        if (typeof window === 'undefined' || !window.solana) {
          console.error('Solanaプロバイダーが見つかりません')
          world.emit('toast', 'Solanaウォレットが見つかりません')
          return null
        }

        // ウォレットに接続をリクエスト
        await window.solana.connect()

        // 接続後のアドレスを取得
        const publicKey = window.solana.publicKey.toString()

        // 接続状態を更新
        isConnected = true
        walletAddress = publicKey

        console.log('Solanaウォレット接続成功:', publicKey)

        // カスタムイベントを発火
        world.emit('solana:connected', publicKey)

        // トークン残高をチェックしてビルダー権限を確認
        await checkAndUpdateBuilderAccess()

        return publicKey
      } catch (error) {
        console.error('Solanaウォレット接続エラー:', error)
        world.emit('toast', 'ウォレット接続に失敗しました')
        return null
      }
    },

    // ウォレット切断メソッド
    disconnect: async () => {
      try {
        if (typeof window !== 'undefined' && window.solana) {
          await window.solana.disconnect()
        }

        // 接続状態をリセット
        isConnected = false
        walletAddress = null
        tokenBalance = 0
        hasBuilderAccess = false

        console.log('Solanaウォレット切断完了')

        // カスタムイベントを発火
        world.emit('solana:disconnected')
        world.emit('solana:builderAccessChanged', false, 0)

        return true
      } catch (error) {
        console.error('Solanaウォレット切断エラー:', error)
        return false
      }
    },

    // 接続状態を確認
    isConnected: () => isConnected,

    // 接続されているアドレスを取得
    getAddress: () => walletAddress,

    // トークン残高を取得
    getTokenBalance: () => tokenBalance,

    // ビルダーアクセス権を確認
    hasBuilderAccess: () => hasBuilderAccess,

    // 必要なトークン量を取得
    getRequiredTokenAmount: () => config.requiredTokenAmount,

    // トークン残高を再取得してビルダー権限を更新
    refreshBalance: async () => {
      return await checkAndUpdateBuilderAccess()
    },

    // トークン残高を直接取得
    fetchBalance: async (address = walletAddress) => {
      return await fetchTokenBalance(address)
    },
  }

  return world.solana
}
