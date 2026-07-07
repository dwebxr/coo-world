# Goal 4A — network dispatch / builder-check 重複統合

**Phase 4 (重複整理) | 実装: Sonnet | Risk: 低〜中 | Effort: M | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
Server/Client ネットワークの重複を共有ヘルパ化。挙動 (FIFO 順・per-item エラー分離) は完全に保つ。

## 対象ファイル (単独所有)
- `src/core/systems/ServerNetwork.js`
- `src/core/systems/ClientNetwork.js`
- `src/core/utils.js` または `src/core/systems/System.js` (共有ヘルパ置き場)

## やること

### 1. enqueue/flush dispatch-queue の重複 (finding 2.4)
`ServerNetwork.js:111-124` と `ClientNetwork.js:69-82` が同一構造の FIFO drain + `this[method]?.()` ディスパッチ + try/catch 分離を持つ (差は tuple に `socket` を含むか否かのみ)。
- 共有ヘルパ (例: `createDispatchQueue()` を `utils.js` に、または System 基底クラスの protected メソッド) を作り、push/drain/try-catch ループを汎用 tuple で持つ。
- 両クラスの `enqueue`/`flush` を薄い wrapper に。
- **観測可能挙動を保つ**: FIFO 順、`console.error` による per-item エラー分離、ハンドラ名解決。

### 2. builder-permission-check の6重複 (finding 2.5)
`ServerNetwork.js:513, 522, 539, 581, 589, 639` の各ハンドラが `if (!socket.player.isBuilder()) return console.error('player attempted to ... without builder permission')` を繰り返す (action 語のみ差)。
- `requireBuilder(socket, action)` ヘルパを追加: `if (socket.player.isBuilder()) return true; console.error(\`player attempted to ${action} without builder permission\`); return false`。
- 各ガードを `if (!this.requireBuilder(socket, 'add blueprint')) return` 等に置換。**ログ文言と制御フローを完全維持**。

## やらないこと
- token-gating ハンドラ (1A が作った solana-gating 委譲部) を触らない。
- ネットワークプロトコル (packets.js) を変えない。

## 検証手順
- `npm run build && npm run client:build` 成功、`npm run lint` 悪化なし。
- 起動スモーク + 2クライアント: chat / entity add-move-remove / settings 変更 の network round-trip が新たな console.error 無しで動くこと。
- 非 builder セッションで add/modify blueprint・add/remove entity・settings 変更・AI 使用が従来と同じ console.error で拒否されること。
