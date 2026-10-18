import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCwIcon, CheckCircleIcon, AlertCircleIcon, WalletIcon, XIcon, LoaderIcon } from 'lucide-react'
import { storage } from '../../core/storage'
import { ControlPriorities } from '../../core/extras/ControlPriorities'
import { cls } from '../utils'
import { useRank } from './useRank'

// 開閉状態の記憶 (ブラウザごと)。world.prefs は使わない
const STORAGE_KEY = 'solanaWalletUI'
const PANEL_ID = 'solana-wallet-panel'

// storage.get は `value || defaultValue` を返すので裸の false は既定値に化ける。
// { collapsed } のオブジェクト形で保存する
const readCollapsed = () => {
  try {
    return !!storage.get(STORAGE_KEY, null)?.collapsed
  } catch {
    return false
  }
}

// ポインタ由来の click の後はフォーカスを外す (e.detail はマウス/タッチで 1 以上、キーボード由来の click では 0)。
// <button> にフォーカスが残ると ClientControls (window の keydown) と二重発火し、
// Space でジャンプ + 切替、Enter でチャット + 切替になる。await の前に同期で呼ぶこと
const blurIfPointer = e => {
  if (e.detail > 0) e.currentTarget.blur()
}

// トグルの title / 読み上げ文
const STATUS_LABELS = {
  connecting: 'Wallet: connecting…',
  disconnected: 'Wallet: not connected',
  builder: 'Wallet: connected · can build',
  nobuild: 'Wallet: connected · no build access',
}

export function SolanaWalletButton({ world }) {
  const [connected, setConnected] = useState(false)
  const [address, setAddress] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // サーバーが実際に付与した権限 (= 今ビルドできるか)。ドット・枠・ステータス文の正はこれ。
  const { isBuilder } = useRank(world, world.entities.player)
  // ポインタロック中は ui.active が false になる → ウィジェットごと隠す (A-3)。
  // 'ui' イベントは変化時にしか飛ばないので初期値は直接読む
  const [active, setActive] = useState(() => world.ui.state.active)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const collapsedRef = useRef(collapsed)

  useEffect(() => {
    collapsedRef.current = collapsed
  }, [collapsed])

  // 開閉を変えて記憶する。storage.set は try/catch 無しで setItem を呼ぶので、
  // quota 超過や無効化環境でも UI 操作が死なないように包む
  const setCollapsedPersist = useCallback(value => {
    setCollapsed(value)
    try {
      storage.set(STORAGE_KEY, { collapsed: value })
    } catch (err) {
      console.warn('[wallet] failed to persist ui state', err)
    }
  }, [])

  useEffect(() => {
    // 初期状態をチェック
    if (world.solana) {
      setConnected(world.solana.isConnected())
      setAddress(world.solana.getAddress() || '')
    }

    // Solana接続イベントをリッスン
    const onConnected = addr => {
      setConnected(true)
      setAddress(addr)
      // 接続成功で自動的に畳む (以後はドットで状態が分かる)
      setCollapsedPersist(true)
    }

    const onDisconnected = () => {
      setConnected(false)
      setAddress('')
    }

    world.on('solana:connected', onConnected)
    world.on('solana:disconnected', onDisconnected)

    return () => {
      world.off('solana:connected', onConnected)
      world.off('solana:disconnected', onDisconnected)
    }
  }, [world, setCollapsedPersist])

  // ポインタロックの状態 (ClientUI が broadcast する)
  useEffect(() => {
    const onUI = state => setActive(state.active)
    world.on('ui', onUI)
    return () => world.off('ui', onUI)
  }, [world])

  // Esc で畳む。生の keydown ではなく controls.bind() で受ける:
  // 同じ CORE_UI 優先度でも後から bind した方が先に評価されるので ClientUI (start() で bind) より前に入る。
  // true を返すとその場で消費され、ClientUI の escape.pressed は立たない (Sidebar のペインは残る)。
  // 畳み済み / ポインタロック中は false を返して下位に渡す
  useEffect(() => {
    const control = world.controls.bind({ priority: ControlPriorities.CORE_UI })
    control.escape.onPress = () => {
      if (!world.ui.state.active) return false
      if (collapsedRef.current) return false
      // フォーカスは戻さない (戻すとそのボタンが Space/Enter を拾い続ける)
      setCollapsedPersist(true)
      return true
    }
    return () => control.release()
  }, [world, setCollapsedPersist])

  // ポインタロック中 (A-3) の操作は無視する。inert が描画されるまでの 1 フレームや
  // visibility のフェード中 (計算値はまだ visible) に、フォーカス済みボタンへ Space/Enter が届く経路を塞ぐ
  const isInactive = () => !world.ui.state.active

  const toggleCollapsed = e => {
    blurIfPointer(e)
    if (isInactive()) return
    setCollapsedPersist(!collapsed)
  }

  const connectWallet = async e => {
    blurIfPointer(e)
    if (isInactive() || connected || connecting) return

    setConnecting(true)
    try {
      if (world.solana) {
        await world.solana.connect()
      }
    } catch (error) {
      console.error('ウォレット接続エラー:', error)
    } finally {
      setConnecting(false)
    }
  }

  const disconnectWallet = async e => {
    blurIfPointer(e)
    if (isInactive() || !connected) return

    try {
      if (world.solana) {
        await world.solana.disconnect()
      }
    } catch (error) {
      console.error('ウォレット切断エラー:', error)
    }
  }

  const refreshBuilderAccess = async e => {
    blurIfPointer(e)
    if (isInactive() || !connected || refreshing) return

    setRefreshing(true)
    try {
      if (world.solana) {
        await world.solana.refreshBalance()
      }
    } catch (error) {
      console.error('ビルダー権限更新エラー:', error)
    } finally {
      setRefreshing(false)
    }
  }

  // 表示状態 (この順で最初に当たったもの)。solana:connected は connect() の途中で飛ぶので
  // connected && connecting の瞬間があり、その間はスピナーが勝つ
  const status = connecting ? 'connecting' : !connected ? 'disconnected' : isBuilder ? 'builder' : 'nobuild'
  const statusLabel = STATUS_LABELS[status]
  // スピナーとドットは畳んでいる時だけ出す。展開時のトグルは常に ×
  const spinning = collapsed && status === 'connecting'
  const showDot = collapsed && (status === 'builder' || status === 'nobuild')
  const requiredAmount = world.solana?.getRequiredTokenAmount() ?? 10000
  const statusText = isBuilder ? 'Builder access granted' : 'No builder access'

  return (
    <div
      className={cls('solana-wallet', { hidden: !active })}
      // ポインタロック中は inert で即座にクリック・フォーカス・キー操作を受けなくする (見た目のフェードは css 側)
      inert={!active}
      css={css`
        position: absolute;
        top: calc(2rem + env(safe-area-inset-top));
        right: calc(2rem + env(safe-area-inset-right));
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
        transition:
          opacity 0.15s ease-out,
          visibility 0.15s;
        @media all and (max-width: 1200px) {
          top: calc(1rem + env(safe-area-inset-top));
          right: calc(1rem + env(safe-area-inset-right));
        }
        /* ポインタロック中: 見えない・押せない・フォーカスも当たらない (visibility で a11y ツリーからも外す)。
           子要素は pointer-events: auto を持つのでフェード中も効くように子にも none を掛ける */
        &.hidden {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          * {
            pointer-events: none;
          }
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}
    >
      {/* トグル (畳み/展開の両状態で同じ 1 要素) */}
      <button
        type='button'
        className={cls('solana-wallet-toggle', status)}
        onClick={toggleCollapsed}
        aria-label={collapsed ? `Show wallet panel. ${statusLabel}` : 'Hide wallet panel'}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : PANEL_ID}
        title={statusLabel}
        css={css`
          position: relative;
          width: max(3rem, 44px);
          height: max(3rem, 44px);
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(11, 10, 21, 0.85);
          color: white;
          border: 0.0625rem solid #2a2b39;
          border-radius: 50%;
          padding: 0;
          cursor: pointer;
          transition:
            background-color 0.2s,
            border-color 0.2s;
          pointer-events: auto;
          backdrop-filter: blur(5px);

          &:hover {
            background: rgba(30, 30, 50, 0.9);
            border-color: #3a3b49;
          }

          svg {
            animation: ${spinning ? 'spin 1s linear infinite' : 'none'};
          }

          .solana-wallet-dot {
            position: absolute;
            top: 0.35rem;
            right: 0.35rem;
            width: 0.55rem;
            height: 0.55rem;
            border-radius: 50%;
            border: 1px solid rgba(0, 0, 0, 0.5);
            &.builder {
              background: #4caf50;
            }
            &.nobuild {
              background: #ff9800;
            }
          }
        `}
      >
        {!collapsed ? (
          <XIcon size='1.25rem' />
        ) : spinning ? (
          <LoaderIcon size='1.25rem' />
        ) : (
          <WalletIcon size='1.25rem' />
        )}
        {showDot && <span className={cls('solana-wallet-dot', status)} aria-hidden='true' />}
      </button>

      {/* 展開パネル (トグルの真下)。未接続なら接続ボタンだけ */}
      {!collapsed && (
        <div
          id={PANEL_ID}
          className='solana-wallet-panel'
          css={css`
            display: flex;
            flex-direction: column;
            align-items: flex-end;
          `}
        >
          {!connected ? (
            <button
              type='button'
              className='solana-wallet-button connect'
              onClick={connectWallet}
              disabled={connecting}
              css={css`
                background: rgba(11, 10, 21, 0.85);
                color: white;
                border: 0.0625rem solid #2a2b39;
                border-radius: 1rem;
                padding: 0.5rem 1rem;
                font-size: 0.875rem;
                cursor: pointer;
                transition: all 0.2s;
                pointer-events: auto;
                backdrop-filter: blur(5px);

                &:hover {
                  background: rgba(30, 30, 50, 0.9);
                  border-color: #3a3b49;
                }

                &:disabled {
                  opacity: 0.6;
                  cursor: not-allowed;
                }
              `}
            >
              {connecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          ) : (
            // 接続されている場合はアドレスとトークン情報を表示
            <div
              className='solana-wallet-info'
              css={css`
                display: flex;
                flex-direction: column;
                gap: 0.4rem;
                background: rgba(11, 10, 21, 0.85);
                border: 0.0625rem solid ${isBuilder ? '#4caf50' : '#2a2b39'};
                padding: 0.6rem 0.8rem;
                border-radius: 1rem;
                pointer-events: auto;
                backdrop-filter: blur(5px);
                min-width: 10rem;
              `}
            >
              {/* アドレス行 */}
              <div
                className='solana-wallet-header'
                css={css`
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  gap: 0.5rem;
                `}
              >
                <div
                  className='solana-wallet-address'
                  css={css`
                    font-size: 0.8rem;
                    color: rgba(255, 255, 255, 0.8);
                  `}
                >
                  {`${address.substring(0, 4)}...${address.substring(address.length - 4)}`}
                </div>
                <button
                  type='button'
                  className='solana-wallet-button disconnect'
                  onClick={disconnectWallet}
                  css={css`
                    background: rgba(244, 67, 54, 0.8);
                    color: white;
                    border: none;
                    border-radius: 0.5rem;
                    padding: 0.2rem 0.4rem;
                    font-size: 0.7rem;
                    cursor: pointer;
                    transition: background-color 0.2s;

                    &:hover {
                      background: rgba(211, 47, 47, 0.9);
                    }
                  `}
                >
                  Disconnect
                </button>
              </div>

              {/* 必要トークン量の案内 (アイコンは現在のビルド権限) */}
              <div
                className='solana-token-info'
                css={css`
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  gap: 0.5rem;
                  padding-top: 0.3rem;
                  border-top: 1px solid rgba(255, 255, 255, 0.1);
                `}
              >
                <div
                  className='solana-token-requirement'
                  css={css`
                    display: flex;
                    align-items: center;
                    gap: 0.3rem;
                    font-size: 0.75rem;
                    color: rgba(255, 255, 255, 0.6);
                  `}
                >
                  {isBuilder ? (
                    <CheckCircleIcon size='0.9rem' color='#4caf50' />
                  ) : (
                    <AlertCircleIcon size='0.9rem' color='#ff9800' />
                  )}
                  <span>Builder access requires {requiredAmount.toLocaleString()} tokens</span>
                </div>
                <button
                  type='button'
                  onClick={refreshBuilderAccess}
                  disabled={refreshing}
                  aria-label='Refresh builder access'
                  title='Refresh builder access'
                  css={css`
                    background: transparent;
                    border: none;
                    color: rgba(255, 255, 255, 0.6);
                    cursor: pointer;
                    padding: 0.2rem;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: color 0.2s;

                    &:hover {
                      color: white;
                    }

                    &:disabled {
                      cursor: not-allowed;
                    }

                    svg {
                      animation: ${refreshing ? 'spin 1s linear infinite' : 'none'};
                    }
                  `}
                >
                  <RefreshCwIcon size='0.85rem' />
                </button>
              </div>

              {/* ステータス表示 */}
              <div
                className='solana-status'
                css={css`
                  font-size: 0.7rem;
                  text-align: center;
                  color: ${isBuilder ? '#4caf50' : '#ff9800'};
                `}
              >
                {statusText}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
