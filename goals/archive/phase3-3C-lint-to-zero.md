# Goal 3C — 残存 lint error をゼロに (CI 必須ゲート化の前提)

**Phase 3 (デッドコード/整理) | 実装: Sonnet | Risk: 低〜中 | Effort: M | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 背景
Phase 0 で eslint の偽陽性を除去した結果、実 error のベースラインが 79 前後に。うち Phase 2 が no-undef 系バグ (9) と no-prototype-builtins (29) と jsx-no-undef (1) を解消済み。**残るのは本タスクが担当する ~41 件**。これらをゼロにして、0C が設定した「Phase 3 完了後に lint を CI 必須ゲート化」を可能にする。

## 前提 (先行フェーズ完了済み)
Phase 2 が下記ファイルの no-undef/no-prototype-builtins を既に修正済み: Stage.js (world→self.world)、ServerNetwork.js、particles.js (shape)、UIText.js (rturn) 等。**あなたはそれらの修正を絶対に元に戻さない**。触るのは各ファイルの**残っている別種の lint error 行のみ**。

## 対象ファイル (単独所有 — 3A/3B とは非重複)
no-var: `src/client/AvatarPreview.js`, `src/core/extras/Curve.js`, `src/core/nodes/{Action,Audio,Nametag,Particles,SkinnedMesh,Sky,UI,UIText,UIView,Video}.js`
no-async-promise-executor: `src/client/components/ScriptEditor.js`, `src/core/loadPhysX.js`, `src/core/nodes/Prim.js`, `src/core/systems/Apps.js`, `src/core/systems/ClientLiveKit.js`, `src/core/systems/ClientLoader.js`, `src/core/systems/ServerLoader.js`
getter-return: `src/core/nodes/Prim.js`, `src/core/systems/Stage.js`
no-case-declarations: `src/client/particles.js`, `src/core/nodes/Prim.js`
no-inner-declarations: `src/core/systems/ServerNetwork.js`
no-prototype-builtins: `src/core/systems/ServerNetwork.js:585,589` (onEntityModified の `data.hasOwnProperty` 2件。Phase2 の 2C は App/Player のみ対応しここは対象外だった)
no-loss-of-precision: `src/core/extras/prng.js`

> **注意**: `ClientLoader.js` は Phase 4 の 4C も触るが 3C (Phase 3) が先。`UI/UIText/UIView.js` は Phase 2 の 2A が先に触る。いずれも逐次で衝突しない。あなたは lint error 行のみ最小修正すること。

## やること

### 1. no-var (22件) — 機械的
`var` を `const`/`let` に。**まず `npx eslint <file> --fix` を no-var/prefer-const に対して使い、その差分を目視レビュー**して意図しない変更が無いか確認 (--fix は安全な範囲)。Curve.js に 11件集中。挙動不変。

### 2. no-case-declarations (2件) — 機械的
`switch` の `case` 内の `const`/`let` 宣言を `{ }` ブロックで囲む (particles.js, Prim.js)。挙動不変。

### 3. no-inner-declarations + no-prototype-builtins (ServerNetwork.js) — 機械的
- no-inner-declarations (1件): ブロック内の関数宣言をトップレベル or 関数式に。挙動不変。
- no-prototype-builtins (`:585,589`): `data.hasOwnProperty('name'/'avatar')` を `Object.prototype.hasOwnProperty.call(data, 'name')` に (Phase2 で App/Player は対応済み。ServerNetwork の onEntityModified 内の2件がこのタスク担当)。**ファイル冒頭の fork Solana コード (solana-gating import, onRequestBuilderNonce 等) には触れない**。

### 4. no-loss-of-precision (1件) — 要確認
`prng.js`: 精度が落ちる数値リテラル。PRNG のシード定数の可能性があり**値を変えると乱数列が変わる**。リテラルを等価な表現 (指数表記等) にして精度警告を消すが、**数値そのものは変えない** (round-trip で同一 double になることを確認)。判断に迷えば報告。

### 5. no-async-promise-executor (13件) — 要注意 (robustness)
`new Promise(async (resolve) => {...})` は executor 内の reject が握り潰される。特に `ServerLoader.js`(5) / `ClientLoader.js`(3) はロード失敗が無言でハングする実害あり。
- パターン: `new Promise((resolve, reject) => { (async () => { try { ...; resolve(x) } catch (e) { reject(e) } })() })` に書き換え。
- **各サイトで、元の resolve タイミング・成功時の値・呼出側の await/catch 有無を確認し、挙動 (成功パス) を保つ**こと。reject を足すことで従来 unhandled だった失敗が顕在化する場合、呼出側が catch していなければ**その旨を報告** (呼出側修正は範囲外なら報告のみ)。
- `loadPhysX.js` の `new Promise(async resolve => { globalThis.PHYSX = await PhysXModule(); ...; resolve(...) })` も同様に。

### 6. getter-return (2件) — 要確認 (実バグ判定)
- `Stage.js:213` `get _ref()`: Phase 2 で `world`→`self.world` 修正済み。条件不成立時に return が無く undefined を返す。**意図的なら明示 `return undefined` を末尾に足して rule を満たす** (挙動不変)。
- `Prim.js:942` `get transparent()`: getProxy 転送部。全パスで return するか確認。**実バグ (return 漏れ) なら適切な値を返す修正**、意図的な条件返しなら明示 return。判断根拠を報告。

## やらないこと
- Phase 2 が修正した no-undef/no-prototype-builtins を元に戻さない。
- getProxy 定型/setter の div:high 共通化はしない (該当行の getter-return のみ)。
- 挙動を変えない (no-loss-of-precision の数値、async の成功パス)。

## 検証手順
- `npm run lint` の **error を 0** にする (warning は残ってよい)。`npm run lint 2>&1 | grep -c error` で確認。
- `npm run build && npm run client:build && npm run viewer:build && npm run node-client:build` 全成功。
- `npm test` 緑。
- 起動スモーク: `node build/index.js` 起動。
- PhysX ロード (loadPhysX) が壊れていないこと (server 起動時に physics 初期化ログ/エラー無し)。
- ServerLoader/ClientLoader 経路: asset ロードが従来通り (model/avatar を含む world を起動し読み込み成功)。
- 報告に: getter-return 2件の判定 (実バグ/意図的)、async 修正で顕在化する未 catch 失敗の有無。
