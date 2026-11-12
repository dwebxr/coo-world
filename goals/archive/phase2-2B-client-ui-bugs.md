# Goal 2B — client UI クラッシュバグ修正

**Phase 2 (正当性バグ) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
lint 復旧で顕在化した client UI の未定義参照クラッシュを修正。いずれも `no-undef` / `react/jsx-no-undef` の実バグ。

## 対象ファイル (単独所有)
- `src/client/components/Sidebar.js` (AppModelBtn 部のみ — **注意: Sidebar 全体分割 (5.7) はスコープ外。触るのは AppModelBtn の props と呼出のみ**)
- `src/client/components/NodeHierarchy.js`
- `src/client/particles.js`

## やること

### 1. AppModelBtn の未定義 `world` (finding 5.0)
`src/client/components/Sidebar.js:1302-1332` の `function AppModelBtn({ value, onChange, children })` は `world` を受け取らないのに `handleDownload` で `world.loader.getFile(value)` を使い `ReferenceError`。
- `AppModelBtn` の分割代入 props に `world` を追加。
- 呼出元 (`:1162` 付近 `<AppModelBtn value={blueprint.model} onChange={changeModel}>`) に `world={world}` を渡す (他の Sidebar サブコンポーネントと同じ)。

### 2. NodeHierarchy の未 import アイコンでタブがクラッシュ (finding 5.1)
`src/client/components/NodeHierarchy.js:114-122` の空状態が `<LayersIcon size={24} />` を render するが `LayersIcon` は import されていない (`react/jsx-no-undef`)。ErrorBoundary 不在のため React tree 全体がクラッシュ。
- lucide-react の import に `LayersIcon` を追加 (Sidebar.js で既に同様に import 済み)。

### 3. particles の未知 shape fallback が throw (finding 5.2)
`src/client/particles.js:987-990` の default case が `createShape('point', dimensions, thickness)` を呼ぶが、`createShape` は単一配列引数を取り、かつ `dimensions`/`thickness` は未定義 → Web Worker で `ReferenceError`。
- `:989` を `return createShape(['point'])` に (他の呼出、例 `:792` の配列パターンに合わせる)。未知 shape を point emitter に graceful fallback させる。

## やらないこと
- `Sidebar.js` の分割・他コンポーネントの改変 (div:high 5.7 はスコープ外)。AppModelBtn 以外の Sidebar 部分を触らない。
- `CoreUI.js` を触らない (Phase 3 が dead code を所有)。

## 検証手順
- `npx eslint src/client/components/Sidebar.js src/client/components/NodeHierarchy.js src/client/particles.js` の該当 no-undef / jsx-no-undef が消えること。
- `npm run client:build` 成功。
- 可能なら: App inspector で base-model アイコンを shift-click してモデル DL が動く / Nodes タブが空状態でも 'No nodes found' が出る / 未知 shape の emitter が point に fallback する。
