# Goal 0A — ESLint 復旧 & lint スコープ拡張

**Phase 0 (安全網) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: none/low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
`npm run lint` は現在 495 errors / 489 warnings で機能停止状態。うち ~214 は eslint に runtime global を宣言していないだけの偽陽性。これを解消し、以降の全フェーズで lint を「本物の欠陥を検出するゲート」として使えるようにする。

## 対象ファイル (単独所有)
- `.eslintrc`
- `.eslintignore` (必要なら)
- `package.json` (**Phase 0 で `package.json` を編集するのはあなただけ**。`scripts.lint`/`scripts.lint:fix` の変更に加え、**0B のための `scripts.test` = `"node --test test/"` もあなたが追加**する。0B は `test/` ファイル作成のみで package.json は触らない。競合防止のため一元管理)
- `src/world/assets/ai.js` (パースエラー修正のみ)
- `scripts/*.mjs` (未使用 import/変数の除去のみ)

## やること

### 1. eslint globals / overrides 追加 (finding 4.0, 7.0)
`.eslintrc` に以下を追加:
- `globals: { PHYSX: 'readonly', lockdown: 'readonly' }`
  - 根拠: `globalThis.PHYSX = await PhysXModule()` (`src/core/loadPhysX.js:13`)、`lockdown` は `ses` パッケージが導入 (`src/node-client/index.js` の `import 'ses'`)。repo全体で 214/337 の no-undef がこれ。
- `examples/**/*.js` と `src/world/assets/*.js` 用の `overrides` ブロックを追加し、SES script globals を readonly 宣言: `app, world, props, Vector3, Quaternion, Euler, Matrix4, num, ...` (これらは `compartment.evaluate(wrapRawCode(code))` 経由で実行される in-world script 用グローバル。`src/core/systems/Scripts.js:65-69` 参照。既存の `world/**/*` を ignore する慣習に倣ってもよいが、examples は残す方針)。79件の `app` + 11件の `world` no-undef がこれ。
- `react/no-unknown-property` の css prop 偽陽性 (87件) を解消: `'react/no-unknown-property': ['error', { ignore: ['css'] }]` (`@firebolt-dev/css` の JSX pragma 由来)。

**注意**: 495 errors を一度に全消しするのが目的ではない。まず偽陽性ノイズ (PHYSX/lockdown/app/world/css) をゼロにし、本物の欠陥 (no-prototype-builtins, no-async-promise-executor, 実 no-undef 等) が残って**見える**状態にすること。それら本物の欠陥は Phase 2/3 で別途修正するので**このタスクでは触らない** (対象ファイル外)。

### 2. 本物のパースエラー修正 (finding: lint 実行で確認済み)
`src/world/assets/ai.js:18` に `Parsing error: 'return' outside of function` がある。関数外の `return` を修正 (該当行を読んで、関数で包むか return を除くか、意味を壊さない最小修正)。in-world script なので挙動を変えないこと。

### 3. lint スコープ拡張 + test script 追加 + dead code 掃除 (finding 7.1, 7.4, [I6])
- `package.json` の `lint` を `eslint . --ext .js,.jsx,.mjs` に (現状 `.mjs` 非マッチで `scripts/*.mjs` と `agent.mjs` が未 lint)。`lint:fix` も同様。
- `package.json` の `scripts` に `"test": "node --test test/"` を追加 (0B がテスト本体を書く。追加依存不要 = node 22 の組込み)。
- **agent.mjs は触らない** (Phase 5 が所有)。ただし lint 対象に入ることで agent.mjs の warning が出る場合、それは Phase 5 で対応するので報告に記す。
- スコープ拡張で顕在化する `scripts/*.mjs` の実 dead code を除去 (挙動変更なし):
  - `scripts/build.mjs:4` 未使用 `execSync` import
  - `scripts/build-node-client.mjs:4` 未使用 `execSync`, `:7` 未使用 `polyfillNode`, `:12` 未使用 `buildDir`
  - `scripts/build-client.mjs:19` 未使用 `buildDirectory`
  - `build.mjs`/`build-node-client.mjs` の onEnd handler の未使用 `result` 引数
  - (各シンボルは grep で自身の import 行1回のみ出現を確認してから消すこと)

## やらないこと
- 本物の lint 欠陥 (Snaps.js の THREE 未 import, Stage.js の world スコープ, UIText の rturn 等) は**修正しない** — Phase 2 が所有。
- `agent.mjs` の中身を触らない — Phase 5 が所有。
- `package.json` の lint/lint:fix 以外のキーを触らない。

## 検証手順
- `npm run lint 2>&1 | grep -c "no-undef"` で PHYSX/app/world 由来がゼロになったことを確認。
- `npm run lint` の error 総数が ~70 程度 (本物のみ) まで低下していること。
- `npm run build && npm run node-client:build && npm run client:build && npm run viewer:build` が全て成功すること (dead code 除去で壊れていないこと)。
- 監査ゲート: **偽陽性 error がゼロ**。残る本物 error/warning はベースラインとして報告に列挙する。
