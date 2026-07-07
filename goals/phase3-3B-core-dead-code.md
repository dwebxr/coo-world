# Goal 3B — 非UI デッドコード除去 (core 単独所有)

**Phase 3 (デッドコード) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
core 側のデッドコード (無限蓄積・未使用 import・到達不能な debug 可視化) を除去。3A (UI 系) とファイル非重複。

## 対象ファイル (単独所有)
- `src/core/systems/Entities.js`
- `src/core/entities/App.js`, `PlayerLocal.js`, `PlayerRemote.js` (未使用 import 除去のみ)
- `src/core/utils.js` (未使用 import 除去のみ)
- `src/core/extras/LooseOctree.js`, `src/core/extras/SnapOctree.js`

**注意**: `App.js`/`PlayerLocal.js`/`PlayerRemote.js` は Phase 2 の 2C も触るが、2C は前フェーズで完了済み。あなたは**未使用 import 行の除去のみ**を行い、modify() ロジック等には触れない。

## やること

### 1. Entities.removed 無限蓄積 (finding 2.3)
`src/core/systems/Entities.js:27` の `this.removed = []` と `:71` の `this.removed.push(id)`。`grep -rn "\.removed" src` で他に読み手が無いことを確認 → フィールドと push を削除 (純粋な no-op 化。長時間稼働でのメモリリーク除去)。

### 2. 未使用 import 12件 + stray debug log (finding 4.6)
各シンボルが自身の import 行1回のみ出現することを grep で確認してから除去:
- `src/core/entities/App.js:1-3, 9-11`: `THREE, isArray, isFunction, isNumber, isString, moment, ControlPriorities, getRef, Layers` (9個) 未使用。
- `src/core/entities/PlayerLocal.js:10`: `Emotes` 未使用。
- `src/core/entities/PlayerRemote.js:4-5`: `LerpQuaternion`/`LerpVector3` (直後の `BufferedLerp*` に置換済み) 未使用。
- `src/core/utils.js:1`: lodash-es の `some` 未使用。
- `src/core/entities/PlayerLocal.js:1254`: 無条件 `console.log('modify', data.health)` (他の console.log と違いコメントアウトされていない) を削除。

### 3. octree の死んだ debug 可視化 (finding 8.1, ~140行)
`src/core/extras/LooseOctree.js` と `SnapOctree.js`:
`grep -rn '\.getDepth\|\.getCount\|toggleHelper' src/` で `toggleHelper()`/`getDepth()`/`getCount()`/`createHelper()` が定義ファイル外から呼ばれないことを確認。`createHelper()` (`LooseOctree.js:380-481`) は到達すれば ~65MB の Float32Array を確保する到達不能コード。
- `LooseOctree.js`: `toggleHelper`, `getDepth`, `getCount`, `createHelper` を削除し、`mountHelper()`/`unmountHelper()` の呼び出し (`:164, :363`) と定義も除去 (helper 経路全体が dead)。
- `SnapOctree.js`: 対応する `getDepth`/`getCount` を削除。
- **注意**: octree の本体 (insert/move/remove/raycast) は live。**helper/debug 経路のみ**除去し、コア機能を壊さないこと。

## やらないこと
- 2C が担当する modify() ロジックや bug 修正を触らない (import 除去のみ)。
- octree のコアアルゴリズムを変更しない。

## 検証手順
- `grep -rn "\.removed" src` / helper 系 grep が削除後に dangling 参照を出さないこと。
- `npm run lint` で該当 no-unused-vars / no-console が消えること。
- `npm run build && npm run client:build` 成功。
- 起動スモーク: prop を数個 spawn/move/remove し、octree の insert/raycast/collision が従来通り動くこと。
