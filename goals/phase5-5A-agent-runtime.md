# Goal 5A — AI エージェント runtime 化 (agent.mjs)

**Phase 5 (AI 基盤) | 実装: Fable 5 (直接) | Risk: 低 | Effort: L | upstream_divergence: none**
※設計性が高く fork の中核エントリのため Fable 5 が直接実装。

## 目的
`agent.mjs` は現在 69行のデモ (ランダムキー連打 + 固定チャット1回)。これを実運用可能な AI エージェント基盤にする: 再接続、kick 理由分岐、perceive→decide→act ループ、プラガブルな decide コールバック。全て fork 所有ファイルで完結 (upstream 非改変)。

## 前提 (先行フェーズで解消済み)
- Phase 2D: node-client の import crash (6.0) と onSnapshot の ai.deserialize crash (6.1) は修正済み → agent が `ready` に到達する。
- Phase 5B (並行/先行): `ClientNetwork.init` に optional `authToken` を通し複数エージェント同時起動可 (6.2)。5A は 5B の API (authToken オプション) を利用する。

## 対象ファイル (単独所有)
- `agent.mjs`
- 新規ヘルパ (例: `agent/` または `scripts/agent-lib.mjs`。既存構成に合わせて配置)

## やること (finding 0.6, 6.3, 6.4)

### 1. 設定の外部化 (0.6)
- `wsUrl`/name/avatar/behavior を CLI 引数 or 環境変数に (現状 `ws://localhost:3000/ws` ハードコード)。
- `AGENT_ID` env で複数インスタンスを区別 (5B の authToken オプションと連携)。

### 2. 再接続 + backoff + kick 理由分岐 (6.3)
- connect+ready ハンドシェイクを指数 backoff 付き再接続ループで包む。
- `world.on('kick', code => ...)` の `code` で分岐: `moderation` (`ServerNetwork.js:421`) は retry しない、`player_limit` (`:218`) や予期せぬ drop は backoff 付き retry。`duplicate_user` (`:253`) は設定 (authToken) の問題として明示ログ。
- `world.on('disconnect', ...)` で `world.destroy()` して即終了ではなく、supervised に再接続を試みる。

### 3. perceive → decide → act ループ (6.4)
- **perceive**: `world.chat.subscribe(cb)` / `world.events.on('chat', cb)` (`Chat.js:104-110, :41`) で受信チャットを購読、`world.entities.players` から近傍プレイヤー/エンティティのスナップショットを取得。
- **decide**: プラガブルな `decide(perception) => actions` コールバックを定義。デフォルト実装は現行のランダム移動相当 (後方互換) でよいが、**LLM ブレインに差し替え可能なインターフェース**にする (関数/クラス注入)。
- **act**: `decide` が返す actions (移動キー・チャット等) を `world.controls.simulateButton(...)` / `world.chat.send(...)` で実行。
- 既存の press/release/num ヘルパは perceive-act の act 層として整理・再利用してよい。

### 4. graceful shutdown (0.6)
- `SIGINT`/`SIGTERM` ハンドラで `handle?.()` cleanup と `world.destroy()` を呼んでから exit (現状 Ctrl+C は両方スキップ)。

## やらないこと
- upstream ファイル (ClientNetwork.js 等) を触らない (authToken は 5B が対応)。ここは fork エントリのみ。
- 実際の LLM API 呼び出しの実装までは必須ではない (差し替え可能な**インターフェース**を用意すれば十分。デフォルトは既存挙動でよい)。過剰実装しない。

## 検証手順
- Phase 2D/5B 適用後、`node build/index.js` 起動 → `AGENT_ID=a node agent.mjs` → agent が ready に到達し行動すること。
- 再接続: サーバを落として再起動し、agent が exit せず再接続すること。moderation kick で retry storm にならないこと。
- 複数体: `AGENT_ID=a` と `AGENT_ID=b` を同時起動し両方 in-world に出ること (5B と連携)。
- perception: 別クライアントが chat/移動すると agent のログに受信 chat と近傍プレイヤー数が更新されること。
- Ctrl+C で cleanup/`world.destroy()` ログが出てから終了すること。
