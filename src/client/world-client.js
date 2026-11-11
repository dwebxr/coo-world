// import 'ses'
// import '../core/lockdown'
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { css } from '@firebolt-dev/css'

import { createClientWorld } from '../core/createClientWorld'
import { CoreUI } from './components/CoreUI'
import { ErrorBoundary } from './components/ErrorBoundary'
import { createSolanaIntegration } from './solana-integration'
import { createEvmIntegration } from './evm-integration'

export { System } from '../core/systems/System'

export function Client({ wsUrl, onSetup }) {
  const viewportRef = useRef()
  const uiRef = useRef()
  const world = useMemo(() => createClientWorld(), [])
  const [ui, setUI] = useState(world.ui.state)
  useEffect(() => {
    world.on('ui', setUI)
    return () => {
      world.off('ui', setUI)
    }
  }, [])
  useEffect(() => {
    const init = async () => {
      const viewport = viewportRef.current
      const ui = uiRef.current
      const baseEnvironment = {
        model: '/base-environment.glb',
        bg: null, // '/day2-2k.jpg',
        hdr: '/Clear_08_4pm_LDR.hdr',
        rotationY: 0,
        sunDirection: new THREE.Vector3(-1, -2, -2).normalize(),
        sunIntensity: 1,
        sunColor: 0xffffff,
        fogNear: null,
        fogFar: null,
        fogColor: null,
      }
      if (typeof wsUrl === 'function') {
        wsUrl = wsUrl()
        if (wsUrl instanceof Promise) wsUrl = await wsUrl
      }
      const config = { viewport, ui, wsUrl, baseEnvironment }
      onSetup?.(world, config)
      // the boot watchdog in index.html stops waiting once the local player is in
      world.on('ready', () => globalThis.__worldBoot?.ready?.())
      world.init(config)

      // Solana統合を初期化 (tokenMint 未設定時は no-op で world.solana を生やさない)
      createSolanaIntegration(world)
      // EVM 統合 (PUBLIC_EVM_CHAIN_IDS 未設定時は world.evm を生やさない)
      createEvmIntegration(world)
    }
    init()
  }, [])
  return (
    <div
      className='App'
      css={css`
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 100vh;
        height: 100dvh;
        .App__viewport {
          position: absolute;
          inset: 0;
        }
        .App__ui {
          position: absolute;
          inset: 0;
          pointer-events: none;
          user-select: none;
          display: ${ui.visible ? 'block' : 'none'};
        }
      `}
    >
      <div className='App__viewport' ref={viewportRef}>
        <div className='App__ui' ref={uiRef}>
          {/* around the interface only: the world's canvas and the screen-space UI canvases live in the two
              elements above, outside React's children, and this component must never be made again (it makes the
              world and its connection). If the interface as a whole cannot render, the world stays on screen. */}
          <ErrorBoundary name='the interface' mode='root'>
            <CoreUI world={world} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
