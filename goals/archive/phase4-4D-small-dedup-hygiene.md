# Goal 4D — 小重複 / import hygiene

**Phase 4 (重複整理) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
小さな重複・import 不整合をまとめて解消。いずれも局所・低リスク。

## 対象ファイル (単独所有)
- `src/client/components/Fields.js`
- `src/client/components/Hint.js` (useHintProps 追加)
- `src/core/extras/buttons.js`
- `src/server/AssetsLocal.js`, `src/server/AssetsS3.js`
- 新規 `src/server/assetFilename.js`
- `src/core/extras/curveManager.js`, `src/client/AvatarPreview.js`
- `scripts/build.mjs`, `scripts/build-node-client.mjs`, `scripts/build-client.mjs`, `scripts/build-viewer.mjs`
- 新規 `scripts/lib/finalizePhysxBuild.mjs` (適宜)

**注意**: `scripts/build.mjs` は Phase 0 の 0A も触った (未使用 import 除去) が 0A は前フェーズで完了済み。`Fields.js` は他フェーズと非重複。

## やること

### 1. Fields.js の FieldVec3 三重化 + hint パターン20重複 (finding 5.6)
`Fields.js:721-930` の `FieldVec3` は X/Y/Z の near-identical `<input>` ブロック3つ (~115行)。
- 軸ごとの input を内部ヘルパ/小コンポーネント (`['x','y','z']` ループ or `AxisInput`) にパラメータ化。
- hint パターン `const { setHint } = useContext(HintContext)` + `onPointerEnter/Leave` が Fields.js に11箇所・Sidebar.js に9箇所 (計20)。`Hint.js` に `useHintProps(hint)` フックを追加し `{onPointerEnter, onPointerLeave}` を返して各所で spread。
- **Sidebar.js の9箇所も対象** (hint パターンのみ。Sidebar の他の部分・分割はしない)。→ Sidebar.js も対象ファイルに含める:

  **追加対象**: `src/client/components/Sidebar.js` (hint パターン置換のみ)

### 2. buttons.js の逆マップ手動重複 (finding 8.4)
`src/core/extras/buttons.js:75-147` (`codeToProp`) と `:149-221` (`propToCode`) が手動逆マップ。
- `propToCode` を `Object.fromEntries(Object.entries(codeToProp).map(([k,v]) => [v,k]))` で導出し single source of truth 化。

### 3. AssetsLocal/S3 の hash/filename ロジック重複 (finding 9.3)
`AssetsLocal.js:20-30, :48` と `AssetsS3.js:177-189, :251` が hash+ext 生成と「64文字 hash」判定を独立実装。
- 新規 `src/server/assetFilename.js` に `computeAssetFilename(file)` と `isUploadedAssetFilename(name)` を出し両者から呼ぶ。**hash アルゴリズム・`${hash}.${ext}` 形式を厳密に維持**。

### 4. lodash → lodash-es (finding 8.3)
`src/core/extras/curveManager.js:1` (`clamp`) と `src/client/AvatarPreview.js:2` (`isString`) が full `lodash` から import (他48ファイルは `lodash-es`)。両方 `lodash-es` に変更 (tree-shaking 改善)。

### 5. esbuild plugin の重複 (finding 7.3)
`build.mjs:120-145` と `build-node-client.mjs:38-62` の PhysX-copy/dev-fork/prod-exit プラグインが near-verbatim (差は fork エントリパスと stray `loader:{}`)。
- 共有 `scripts/lib/finalizePhysxBuild.mjs` に `makePhysxFinalizePlugin({ rootDir, dev, forkEntry })` を出し両者で再利用。
- (任意) build-client.mjs/build-viewer.mjs の single-entry boilerplate 共通化も可だが**低リスク優先**。無理なら PhysX plugin のみ。

## やらないこと
- Sidebar.js の分割 (5.7 div:high) はしない。hint パターン置換のみ。
- Fields.js の Field* の挙動を変えない。

## 検証手順
- `npm run build && npm run node-client:build && npm run client:build && npm run viewer:build` を**変更前後で実行し、build/ 出力物 (index.js, world-node-client.js, physx-js-webidl.js/.wasm, public/*, viewer/*) が同一生成**、dev fork/restart も動くこと。
- `npm run lint` 悪化なし。
- Position/Rotation/Scale の vec3 field (入力・arrow ステップ・shift/alt 修飾) と hint hover が不変。
- key 入力 (letters/digits/arrows) が正しくマップされること。
- local backend でファイルを upload し filename/hash が抽出前と byte-identical。
- curve editor UI と AvatarPreview が不変。
