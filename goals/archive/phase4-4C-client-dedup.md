# Goal 4C — client systems 重複統合

**Phase 4 (重複整理) | 実装: Sonnet | Risk: 低〜中 | Effort: M | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
ClientControls (XR)・ClientLoader・ClientLiveKit の verbatim 重複を parameterize して単一化。挙動を厳密に保つ。

## 対象ファイル (単独所有)
- `src/core/systems/ClientControls.js`
- `src/core/systems/ClientLoader.js`
- `src/core/systems/ClientLiveKit.js`
- `src/core/systems/XR.js` (関与する場合のみ)

**注意**: `ClientControls.js` は Phase 2 の 2E も触るが 2E は前フェーズで完了済み (simulateButton の text 修正)。あなたは XR gamepad polling 部を扱う。

## やること

### 1. XR 左右ゲームパッド polling の重複 (finding 1.1, ~100行)
`src/core/systems/ClientControls.js:128-329` の `preFixedUpdate()` 内、left (`:130-228`) と right (`:230-328`) の handedness ブロックが byte-identical (ray/grip pose・stick・trigger・grip・2 buttons)。差は 'Left'/'Right' と 'left'/'right' のみ (検証済みで完全一致)。
- パラメータ化ヘルパ `updateXRHand(controls, src, frame, referenceSpace, side)` を抽出し、`preFixedUpdate()` から handedness ごとに2回呼ぶ。~200行→~100行+2呼出。挙動不変。

### 2. video "force load stream data" の重複 (finding 1.2)
`ClientLoader.js:412-457` (`createVideoFactory` の `prepare`) と `ClientLiveKit.js:405-449` (`createPlayerScreen` の `prepare`) が near-identical (ClientLiveKit.js:381 に「ClientLoader.js と同構造」コメント有り)。差は duration 追跡有無・`play()` の commented 有無・debug log のみ。
- 共有 `prepareVideoElement(elem, { trackDuration = false, forcePlayOnMetadata = true } = {})` を抽出し両者から呼ぶ。既存の2つの挙動差をパラメータで表現。

### 3. ClientLoader load()/insert() の per-type 構築重複 (finding 1.5, ~60行)
`ClientLoader.js:170-227` (`load()`) と `:277-334` (`insert()`) が model/avatar/emote の結果オブジェクト構築を3種コピペ。差は glb の取得方法 (`parseAsync(buffer)` vs `loadAsync(localUrl)`) のみ。
- module-level ヘルパ `buildModelResult(glb, world, file)` / `buildAvatarResult(glb, world, file, vrmHooks)` / `buildEmoteResult(glb, url)` を抽出し、両メソッドが glb 取得後に呼ぶ。`this.results.set(...)` は呼出側に残す。挙動不変。

## やらないこと
- 2E が担当した simulateButton を触らない。
- video/loader の実際の読み込み挙動を変えない (workaround をそのまま centralize)。

## 検証手順
- `npm run build && npm run client:build` 成功、`npm run lint` 悪化なし。
- video: 通常動画 URL を world にドロップ (ClientLoader 経路) + LiveKit 画面共有 (ClientLiveKit 経路) が両方 play/pause・寸法表示 OK。
- loader: model/avatar/emote を preload する scene (`load()`) と local .glb/.vrm の drag-drop (`insert()`) が両方 render し `getStats()`/`toNodes()`/`toClip()` 同一。
- XR: WebXR エミュレータで両手のコントローラの ray/grip/stick/trigger/button が左右同一に反応 (エミュレータ無ければコードレビューで代替)。
