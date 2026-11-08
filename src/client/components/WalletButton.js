import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { WalletIcon, XIcon, LoaderIcon } from 'lucide-react'
import { storage } from '../../core/storage'
import { ControlPriorities } from '../../core/extras/ControlPriorities'
import { cls } from '../utils'
import { useRank } from './useRank'
import { blurIfPointer, SolanaWalletPanel } from './SolanaWalletPanel'
import { EvmWalletPanel } from './EvmWalletPanel'

// 開閉状態と選択タブの記憶 (ブラウザごと)。world.prefs は使わない。
// キー名とパネル id は従来の Solana 専用ボタンと同じ (保存済みの開閉状態と e2e のセレクタを保つ)
const STORAGE_KEY = 'solanaWalletUI'
const PANEL_ID = 'solana-wallet-panel'

// storage.get は `value || defaultValue` を返すので裸の false は既定値に化ける。
// { collapsed, tab } のオブジェクト形で保存する
const readStored = () => {
  try {
    const value = storage.get(STORAGE_KEY, null)
    return { collapsed: !!value?.collapsed, tab: typeof value?.tab === 'string' ? value.tab : null }
  } catch {
    return { collapsed: false, tab: null }
  }
}

// トグルの title / 読み上げ文
const STATUS_LABELS = {
  connecting: 'Wallet: connecting…',
  disconnected: 'Wallet: not connected',
  builder: 'Wallet: connected · can build',
  nobuild: 'Wallet: connected · no build access',
  evm: 'Wallet: EVM wallet verified',
}

const TAB_LABELS = { solana: 'Solana', evm: 'EVM' }

const DISCONNECTED = { status: 'disconnected' }
const isConnecting = state => state.status === 'connecting' || state.status === 'signing'

// ウォレットの外枠: 位置・トグル・Esc で畳む・ポインタロック中の inert・開閉の記憶。
// 中身は有効なチェーンのパネル (両方有効ならタブで切替)
export function WalletButton({ world }) {
  const [solanaState, setSolanaState] = useState(() => world.solana?.getState() ?? DISCONNECTED)
  const [evmState, setEvmState] = useState(() => world.evm?.getState() ?? DISCONNECTED)
  // サーバーが実際に付与した権限 (= 今ビルドできるか)。ドット・枠・ステータス文の正はこれ。
  const { isBuilder } = useRank(world, world.entities.player)
  // ポインタロック中は ui.active が false になる → ウィジェットごと隠す (A-3)。
  // 'ui' イベントは変化時にしか飛ばないので初期値は直接読む
  const [active, setActive] = useState(() => world.ui.state.active)
  const [stored] = useState(readStored)
  const [collapsed, setCollapsed] = useState(stored.collapsed)
  const [tab, setTab] = useState(stored.tab)
  const collapsedRef = useRef(collapsed)
  const tabRef = useRef(tab)

  useEffect(() => {
    collapsedRef.current = collapsed
    tabRef.current = tab
  }, [collapsed, tab])

  // storage.set は try/catch 無しで setItem を呼ぶので、quota 超過や無効化環境でも UI 操作が死なないように包む
  const persist = useCallback((nextCollapsed, nextTab) => {
    try {
      storage.set(STORAGE_KEY, { collapsed: nextCollapsed, tab: nextTab })
    } catch (err) {
      console.warn('[wallet] failed to persist ui state', err)
    }
  }, [])

  const setCollapsedPersist = useCallback(
    value => {
      // ref は描画を待たずに更新する (直後の Esc やタブ切替が古い値で保存しないように)
      collapsedRef.current = value
      setCollapsed(value)
      persist(value, tabRef.current)
    },
    [persist]
  )

  useEffect(() => {
    const update = state => setSolanaState(state)
    if (world.solana) update(world.solana.getState())
    world.on('solana:state', update)
    return () => world.off('solana:state', update)
  }, [world])

  useEffect(() => {
    const update = state => setEvmState(state)
    if (world.evm) update(world.evm.getState())
    world.on('evm:state', update)
    return () => world.off('evm:state', update)
  }, [world])

  // ポインタロックの状態 (ClientUI が broadcast する)
  useEffect(() => {
    const onUI = state => setActive(state.active)
    world.on('ui', onUI)
    // 描画してから購読するまでの間の変化を拾い直す
    setActive(world.ui.state.active)
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

  const tabs = [world.solana && 'solana', world.evm && 'evm'].filter(Boolean)
  const selected = tabs.includes(tab) ? tab : tabs[0]

  const toggleCollapsed = e => {
    blurIfPointer(e)
    if (!world.ui.state.active) return
    setCollapsedPersist(!collapsed)
  }

  const selectTab = (e, value) => {
    blurIfPointer(e)
    if (!world.ui.state.active) return
    tabRef.current = value
    setTab(value)
    persist(collapsedRef.current, value)
  }

  // 署名・確認待ちはどちらのチェーンでもスピナーで表示する。
  // 緑/橙のドットは Solana のビルド権限の意味だけを持つ。Solana 未接続で EVM 検証済みなら青
  const connecting = isConnecting(solanaState) || isConnecting(evmState)
  const status = connecting
    ? 'connecting'
    : solanaState.address
      ? isBuilder
        ? 'builder'
        : 'nobuild'
      : evmState.verified
        ? 'evm'
        : 'disconnected'
  const statusLabel = STATUS_LABELS[status]
  // スピナーとドットは畳んでいる時だけ出す。展開時のトグルは常に ×
  const spinning = collapsed && status === 'connecting'
  const showDot = collapsed && (status === 'builder' || status === 'nobuild' || status === 'evm')

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
            &.evm {
              background: #2196f3;
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

      {/* 展開パネル (トグルの真下)。畳んでもタブを切り替えても中身はマウントしたまま hidden で隠す:
          更新ボタンのロックや選択中のウォレットなど、パネル側の状態を作り直しで失わないため */}
      <div
        id={PANEL_ID}
        className='solana-wallet-panel'
        hidden={collapsed}
        css={css`
          &[hidden],
          [hidden] {
            display: none !important;
          }
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0.4rem;
          max-width: min(24rem, calc(100vw - 2rem));
          padding: 0.6rem 0.8rem;
          background: rgba(11, 10, 21, 0.85);
          border-radius: 1rem;
          color: white;
          font-size: 0.75rem;
          pointer-events: auto;
          backdrop-filter: blur(5px);
        `}
      >
        {tabs.length > 1 && (
          <div
            className='wallet-tabs'
            role='tablist'
            aria-label='Wallet network'
            css={css`
              display: flex;
              gap: 0.3rem;
              button {
                flex: 1;
                background: transparent;
                color: rgba(255, 255, 255, 0.6);
                border: 0.0625rem solid #2a2b39;
                border-radius: 0.75rem;
                padding: 0.3rem 0.6rem;
                font-size: 0.75rem;
                cursor: pointer;
                &.selected {
                  color: white;
                  border-color: #4a4b5a;
                  background: rgba(30, 30, 50, 0.9);
                }
              }
            `}
          >
            {tabs.map(value => (
              <button
                key={value}
                type='button'
                role='tab'
                aria-selected={selected === value}
                className={cls({ selected: selected === value })}
                onClick={e => selectTab(e, value)}
              >
                {TAB_LABELS[value]}
              </button>
            ))}
          </div>
        )}
        {world.solana && (
          <div
            className='wallet-tab-panel'
            role={tabs.length > 1 ? 'tabpanel' : undefined}
            hidden={selected !== 'solana'}
          >
            <SolanaWalletPanel world={world} walletState={solanaState} isBuilder={isBuilder} />
          </div>
        )}
        {world.evm && (
          <div className='wallet-tab-panel' role={tabs.length > 1 ? 'tabpanel' : undefined} hidden={selected !== 'evm'}>
            <EvmWalletPanel world={world} walletState={evmState} />
          </div>
        )}
      </div>
    </div>
  )
}
