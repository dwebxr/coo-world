# Goal 2E — extras / misc バグ修正

**Phase 2 (正当性バグ) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
残りの局所バグ2件を修正。

## 対象ファイル (単独所有)
- `src/core/extras/downloadFile.js`
- `src/core/systems/ClientControls.js`
- `src/core/systems/ClientUI.js`

## やること

### 1. downloadFile が blob URL を同期 revoke (finding 8.2)
`src/core/extras/downloadFile.js:1-8`: `a.click()` 直後に `URL.revokeObjectURL(url)` を同期実行。一部ブラウザ/拡張は click 後に非同期で Blob を読むため、間欠的に空/失敗ダウンロードが発生する既知の footgun。
- revoke を遅延: `setTimeout(() => URL.revokeObjectURL(url), 0)` (標準的な緩和策)。

### 2. simulateButton の `text` no-undef バグ修正 (finding 1.0 の再評価あり)
`src/core/systems/ClientControls.js:523-550` の `simulateButton()` は、内部 `:535` で未定義 `text` を参照 (`no-undef`: `const capture = control.onButtonPress?.(prop, text)`)。`control.onButtonPress` は未代入なので optional-chaining が短絡し今は throw しないが、no-undef の実欠陥。

**重要 (finding 1.0 の前提訂正)**: finding は「simulateButton はどこからも呼ばれない dead code」とするが、これは `src/` 限定 grep の結果。**`agent.mjs` (リポルート) が `world.controls.simulateButton(prop, true/false)` を呼んでおり、fork のエージェントが使う唯一の programmatic 入力 API**。よって **削除してはならない**。
- 対応: メソッドは**保持**し、`:535` の未定義 `text` を除く/スコープ内の値に直して no-undef を解消する (例: `onButtonPress?.(prop)` に、または `text` が本来意図した値を onKeyDown 実装から確認して合わせる)。挙動は不変 (onButtonPress は未代入なので短絡は変わらない)。
- **必ず `grep -rn "simulateButton" agent.mjs src/` で呼び出し元を確認**してから修正。もし削除が妥当と思える状況でも、agent.mjs が使う限り保持する。
- `src/core/systems/ClientUI.js:4`: `import { thickness } from 'three/src/nodes/TSL.js'` は未使用。削除。

## やらないこと
- ClientControls の他の入力処理を触らない。
- agent.mjs を触らない (Phase 5 所有)。

## 検証手順
- `grep -rn "simulateButton" src/ agent.mjs` で呼び出し元を確認 (削除可否の判断)。
- `npx eslint src/core/systems/ClientControls.js src/core/systems/ClientUI.js` の該当 no-undef / unused-import が消えること。
- `npm run build && npm run client:build` 成功、起動スモークで入力 (build モードのキー/マウス) が従来通り動くこと。
- (可能なら) Sidebar/Menu から .hyp エクスポートしファイルが空でないこと。
