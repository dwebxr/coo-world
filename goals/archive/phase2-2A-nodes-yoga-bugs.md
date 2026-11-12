# Goal 2A — nodes / yoga バグ修正

**Phase 2 (正当性バグ) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
Phase 0 で lint が機能した後に顕在化した、scene-graph node / yoga レイアウトの実バグを修正。いずれも低リスク・局所修正・挙動を正しくするもの。

## 対象ファイル (単独所有)
- `src/core/nodes/UIView.js`
- `src/core/nodes/UI.js`
- `src/core/nodes/UIText.js`
- `src/core/nodes/UIImage.js`
- `src/core/extras/yoga.js`

## やること

### 1. flexWrap 自己再帰スタックオーバーフロー (finding 3.0)
`src/core/nodes/UIView.js:471-473` と `src/core/nodes/UI.js:780-782`:
`get flexWrap() { return this.flexWrap }` が自分自身を呼び無限再帰 (`RangeError`)。バッキングフィールド `this._flexWrap` を返すよう修正 (同ファイルの他 getter、例 `get gap()` は正しく `this._gap` を返している)。両ファイル1行ずつ。

### 2. `rturn` タイポ (finding 3.1)
`src/core/nodes/UIText.js:370`: setter 内の `rturn` → `return`。同じ padding 値を2回設定すると `ReferenceError` を投げるバグ。

### 3. Yoga enum 誤アクセス (finding 3.2)
`src/core/nodes/UIView.js:255`, `UIText.js:250`, `UIImage.js:279`:
`absolute` setter が `Yoga.POSITION_TYPE_ABSOLUTE.ABSOLUTE` (= `undefined`) を使っている。`.ABSOLUTE` を除き `Yoga.POSITION_TYPE_ABSOLUTE` に (各ファイルの `mount()` 内の正しい表現に合わせる)。mount 後の `.absolute = true` トグルが効かないバグ。3ファイル各1箇所。

### 4. flexDirection validator が justify-content 値を誤受理 (finding 8.0)
`src/core/extras/yoga.js:47`:
`const flexDirections = ['column','column-reverse','row','row-reverse','flex-start','flex-end','center']` の末尾3つ (`flex-start`/`flex-end`/`center`) は justify-content 値で flex-direction として無効。`initYoga()` もこれらを `FlexDirection` に登録していない。配列を `['column','column-reverse','row','row-reverse']` に修正。これにより `isFlexDirection()` (UI.js:729, UIView.js:420 の検証ゲート) が正しく無効値を弾く。

## やらないこと
- getProxy() 定型や setter 前置きの共通化 (div:high, スコープ外)。
- 対象外の node クラスを触らない。

## 検証手順
- `npx eslint src/core/nodes/UIText.js` の `rturn` no-undef が消えること。
- `npm run build && npm run client:build` 成功。
- 可能なら簡易確認: UIView/UI インスタンスを構築し `getProxy().flexWrap` を読んで `RangeError` が出ないこと。`.absolute = true` を mount 後に呼び position type が ABSOLUTE になること。`flexDirection = 'center'` が `[ui] flexDirection invalid` 相当で弾かれ、'column'/'row' 系は通ること。
- 起動スモーク: `node build/index.js` 起動、UI を含む world が壊れないこと。
