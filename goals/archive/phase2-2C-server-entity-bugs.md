# Goal 2C — server / entity バグ修正

**Phase 2 (正当性バグ) | 実装: Sonnet | Risk: 低〜中 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
サーバ永続化・チャット・エンティティ modify 経路の実バグを修正。特に autosave 恒久停止 (2.0) は永続化データ喪失につながるため優先。

## 対象ファイル (単独所有)
- `src/core/systems/ServerNetwork.js` (**注意: Phase 1 の 1A も ServerNetwork を触るが、1A は Phase 1 で完了済み。あなたは Phase 2 で 1A 完了後に着手するため衝突しない。ただし 1A が触った token-gating ハンドラ部には触れず、下記 autosave/handler-guard/hasOwnProperty 部のみ修正すること**)
- `src/core/systems/Chat.js`
- `src/core/systems/Snaps.js`
- `src/core/systems/Stage.js`
- `src/core/entities/App.js`
- `src/core/entities/PlayerLocal.js`
- `src/core/entities/PlayerRemote.js`
- `src/core/systems/ClientBuilder.js` (frozen 補完のみ)
- `src/core/systems/ClientAI.js` (frozen + scene 補完のみ)

## やること

### 1. autosave 単発エラーで恒久停止 (finding 2.0)
`src/core/systems/ServerNetwork.js:130-197` の `save` 内、'entity removed' 分岐の `await this.db('entities').where('id', id).delete()` (`:183`) だけ try/catch が無い。ここが throw すると `setTimeout(this.save, ...)` の再スケジュール (`:196`) がスキップされ autosave が永久停止 → 以降の全変更が永続化されない。
- delete 分岐を上の2分岐と同じ try/catch で包む。
- **多層防御**: `save` 全体を `try { ...本体... } finally { this.saveTimerId = setTimeout(this.save, SAVE_INTERVAL*1000) }` の形にし、再スケジュールを無条件化。

### 2. Chat.add の createdAt 未代入 (finding 2.1)
`src/core/systems/Chat.js:26`: `if (!msg.createdAt) moment().toISOString()` は計算するだけで代入していない。→ `if (!msg.createdAt) msg.createdAt = moment().toISOString()`。

### 3. ReferenceError 系2件 (finding 2.2)
- `src/core/systems/Snaps.js:17`: `new THREE.Vector3(...)` だが THREE 未 import。`import * as THREE from '../extras/three'` を追加 (Nametags.js/Animation.js/Particles.js と同じ)。
- `src/core/systems/Stage.js:213-214`: `get _ref() { if (world._allowMaterial) ... }` の bare `world` を `self.world` に (同関数は `const self = this` を `:116` で捕捉済み)。

### 4. handler null-guard 追加 (finding 2.6)
`src/core/systems/ServerNetwork.js`:
- `onEntityRemoved` (`:580-586`): `entity.isApp` 参照前に guard → `if (entity?.isApp) this.dirtyApps.add(id)`。
- `onBlueprintModified` (`:521-536`): `blueprint.version` 比較前に `if (!blueprint) return` (ログ付き)。
- `onKick` (`:413-423`): `tSocket.send(...)` 前に `if (!tSocket) return`。
いずれも現状 flush() の try/catch で握り潰されているが、意図した副作用が起きずログノイズになる。挙動 (実質何もしない) は保ちつつ throw を除く。

### 5. hasOwnProperty on unvalidated payload (finding 4.1)
`src/core/entities/App.js:273-312`, `PlayerLocal.js:1245-1274`, `PlayerRemote.js:185-232` の `modify()` 内 (計27箇所) の `data.hasOwnProperty('x')` を `Object.prototype.hasOwnProperty.call(data, 'x')` に (または既存依存の lodash-es `has(data,'x')`)。network payload の key に `hasOwnProperty` が来ると throw する edge を除去し、`no-prototype-builtins` 27件を解消。

### 6. blueprint スキーマバグ ([I3] finding 1.3 の実バグ部分のみ)
新規 blueprint リテラルで `frozen` が欠落している3箇所を補完 (全体 factory 化 div:high はスコープ外):
- `src/core/systems/ClientBuilder.js:1166-1183` (addModel): `frozen: false` 追加。
- `src/core/systems/ClientBuilder.js:1226-1243` (addAvatar): `frozen: false` 追加。
- `src/core/systems/ClientAI.js:38-57` (create): `frozen: false` **と `scene: false`** 追加 (ClientAI は両方欠落。他2箇所は scene:false 有り)。
※ 補完する値は他の正しいリテラルと同じ default に合わせること (frozen は false が default)。

## やらないこと
- `ClientBuilder.update()` 427行の分割 (div:high スコープ外)。frozen 追加のみ。
- blueprint リテラルの factory 化 (div:high スコープ外)。
- 1A が触った token-gating ハンドラ・nonce 部分を触らない。

## 検証手順
- `npm run lint` で `no-prototype-builtins` (27件) と Snaps/Stage の no-undef が消えること。
- `npm run build` 成功、`node build/index.js` 起動スモーク。
- autosave: (可能なら) delete を一時的に reject させても `world saved` ログが継続することを確認 (確認後戻す)。
- entity modify: join/move/chat/名前・avatar・rank 変更が従来通り反映されること。
