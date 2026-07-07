# Goal 4B — Player / App 重複統合 (entities 単独所有)

**Phase 4 (重複整理) | 実装: Sonnet | Risk: 低〜中 | Effort: S〜M | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
PlayerLocal/PlayerRemote 間の重複 (認可・チャットバブル・enum) と App の Proxy factory 重複を単一ソース化。特に認可ロジックはセキュリティ関連なので single source of truth にする価値が高い。

## 対象ファイル (単独所有)
- `src/core/entities/PlayerLocal.js`
- `src/core/entities/PlayerRemote.js`
- `src/core/entities/App.js`
- `src/core/extras/createVRMFactory.js`
- 新規共有モジュール: `src/core/extras/locomotionModes.js`, `src/core/extras/playerRanks.js`, `src/core/extras/playerAura.js` (適宜)

## やること

### 1. Locomotion Modes enum の重複 (finding 4.2)
`PlayerLocal.js:47-56` と `createVRMFactory.js:43-52` が byte-identical な `Modes` enum を持ち、双方に「de-dup せよ」TODO コメント有り。
- 新規 `src/core/extras/locomotionModes.js` に `Modes` を export、両者から import、TODO と重複定義を削除。
- 付随: `PlayerLocal.js:1015-1016` の `Modes.FLIP` は enum に存在せず `undefined` (dead code、`airJumping` は `:710` で `false &&` 永久短絡)。**小さく安全な方**を選ぶ: 共有 enum に `FLIP: 7` を追加して将来の air-jump 経路を無害化する (削除ではなく追加を推奨)。

### 2. Player 認可メソッドの重複 (finding 4.3)
`PlayerLocal.js:402-420` と `PlayerRemote.js:117-135` の `outranks()`/`isAdmin()`/`isBuilder()`/`isMuted()` が byte-identical。ServerNetwork の8箇所と createPlayerProxy がこれに依存 (認可契約)。
- 新規 `src/core/extras/playerRanks.js` に `player` を第1引数に取る純関数群 (`getEffectiveRank`, `outranks`, `isAdmin`, `isBuilder`, `isMuted`) を作り、両クラスのメソッドは委譲。挙動不変・single source of truth。

### 3. Chat-bubble/nametag 構築と chat() の重複 (finding 4.4)
`PlayerLocal.js:130-162 / 1231-1240` と `PlayerRemote.js:50-77 / 241-250` の aura/nametag/bubble ノード構築 (差は `id:'bubble'` とコメントのみ) と `chat(msg)` (byte-identical)。
- 共有 factory (例: `createPlayerAura({ label, health })` を `src/core/extras/` に) と共有 `chatBubble`/mixin を作り両コンストラクタ/メソッドから呼ぶ。presentation のみで低リスク。

### 4. App の Proxy factory 重複 (finding 4.5)
`App.js:453-488` (`getWorldProxy`) と `:490-531` (`getAppProxy`) は getter/setter/method マップと (app のみ) root-node fallback だけが違う機械的重複。
- 共有 `createEntityProxy(entity, { getters, setters, methods, fallbackGet, fallbackSet })` を作り両者から呼ぶ。per-instance の遅延キャッシュ (`this.worldProxy`/`this.appProxy`) は呼出側に残す。**これは in-world script のサンドボックス API 表面なので挙動を厳密に保つ**。

## やらないこと
- getProxy() 定型 (nodes/*, div:high) や setter 前置き共通化はスコープ外。
- 認可の**ロジック自体**は変えない (再配置のみ)。

## 検証手順
- `npm run build && npm run client:build` 成功、`npm run lint` 悪化なし。
- 起動スモーク: admin/builder/regular 各 rank で build モードトグル・kick/mute UI ゲート・app script の `player.isAdmin/isBuilder` が同一挙動。
- 歩行/走行/ジャンプ/落下/飛行のアニメが従来通り (Modes 値は不変)。
- 2クライアントで local/remote 双方の chat bubble/nametag の表示・5秒後非表示が不変。
- world/app プロパティ read/write する app を動かし script が同一に動作。
