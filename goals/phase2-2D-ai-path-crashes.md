# Goal 2D — node-client / AI 経路のクラッシュ修正

**Phase 2 (正当性バグ) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
node-client (headless AI エージェント) 経路が現在 import 時と snapshot 時にクラッシュし、`agent.mjs` が全く動作しない。Phase 5 (AI 基盤) の前提としてこの2件を直す。

## 対象ファイル (単独所有)
- `src/client/utils.js`
- `src/core/systems/ClientNetwork.js` (**注意: Phase 5 の 5B も ClientNetwork を触るが、5B は後フェーズ。あなたは onSnapshot の1行のみ修正**)

## やること

### 1. node-client が import 時に window/navigator でクラッシュ (finding 6.0)
`src/client/utils.js:19-22` のモジュールスコープ (関数外) で `window.matchMedia(...)` / `navigator.maxTouchPoints` を参照。`ClientControls.js:1` が `import { isTouch } from '../../client/utils'` し、`createNodeClientWorld.js` が ClientControls を登録するため esbuild が node-client バンドルに無条件で含める → `node agent.mjs` が `ReferenceError: window is not defined` で即クラッシュ (World すら構築できない)。
- モジュールスコープの browser API アクセスを guard:
  ```js
  const hasWindow = typeof window !== 'undefined'
  const coarse = hasWindow && window.matchMedia('...').matches
  const noHover = hasWindow && window.matchMedia('...').matches
  const hasTouch = hasWindow && navigator.maxTouchPoints > 0
  ```
  ブラウザビルドの挙動は不変であること (guard は `typeof` チェックのみ)。既存の `matchMedia` 呼びの `.matches` 参照有無を実コードに合わせること。

### 2. onSnapshot が未登録の ai.deserialize を無条件呼び (finding 6.1)
`src/core/systems/ClientNetwork.js:140-145`: `this.world.ai.deserialize(data.ai)` を無条件で呼ぶが、`createNodeClientWorld.js` は 'ai' システムを登録しない (client/server world は登録する)。→ node-client で `TypeError: Cannot read properties of undefined (reading 'deserialize')`。これが flush() の try/catch で握り潰され、**以降の `blueprints.deserialize`/`entities.deserialize`/`storage.set('authToken')` が全て実行されない** → PlayerLocal が作られず `ready` イベントが発火せず、agent が接続しても何もしない。
- `:141` を `this.world.ai?.deserialize(data.ai)` に (次行の livekit が既に optional-chaining している前例に合わせる)。

## やらないこと
- `agent.mjs` を触らない (Phase 5 が所有)。
- ClientNetwork の authToken 経路を触らない (5B が所有)。onSnapshot の該当1行のみ。
- ClientControls 本体を触らない。

## 検証手順
- `npm run build && npm run node-client:build` 成功。
- **実機検証**: `node build/index.js` を起動 → 別シェルで `node agent.mjs` → (a) `ReferenceError: window is not defined` が出ないこと、(b) agent が `ready:true` に到達し press/release キーログと `world.chat.send('heyo...')` が出ること (修正前はどちらも起きなかった)。
