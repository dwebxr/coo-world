# Goal 1A — Solana セキュリティ & 堅牢化 (全 Solana ソース単独所有)

**Phase 1 (セキュリティ) | 実装: Fable 5 (直接) | Risk: 中 | Effort: M〜L | upstream_divergence: none**
※難易度・リスクが高く client/server プロトコルが密結合するため Fable 5 が直接実装。Sonnet には渡さない。

## 目的
現状のトークンゲーティングは**セキュリティ的に破綻**している。サーバはクライアント自己申告の `tokenBalance` を無検証で信頼し、ウォレット所有証明も無いため、devtools から `world.network.send('requestBuilderByToken', { walletAddress:'<任意>', tokenBalance: 999999999 })` を送るだけで誰でも BUILDER 権限を奪取できる (finding 0.0/9.1)。加えてデプロイ経路で設定不能 (9.0)、エラー握り潰し (0.3/9.2)、常時有効で feature-flag 無し (0.4)、config の `||` が 0 値を弾く (0.5) 等の問題がある。これらを一括で塞ぐ。

## 対象ファイル (このタスクが全 Solana ソースを単独所有)
- `src/core/systems/ServerNetwork.js` (token-gating ハンドラ部)
- 新規 `src/server/solana-gating.js`
- `src/core/packets.js` (nonce パケット追加)
- `src/client/solana-integration.js`
- `src/client/components/SolanaWalletButton.js`
- `src/client/world-client.js` (import/feature-flag)
- `src/client/components/CoreUI.js` (render gating)
- `package.json` (`tweetnacl` 依存追加)

## やること

### (a) トークンゲーティング再設計 — 所有証明 + サーバ側残高検証 (finding 0.0/9.1)
現行 `onRequestBuilderByToken` (`ServerNetwork.js:432-479`) を以下に置換:
1. **サーバ側残高検証**: `walletAddress` の残高を **サーバの Solana RPC** で実取得 (`@solana/spl-token` の `getAccount`/`getAssociatedTokenAddress`)。client 申告 `tokenBalance` は**完全に無視**。
2. **ウォレット所有証明 (署名 nonce)**:
   - 新パケット `requestBuilderNonce` (client→server) / `builderNonce` (server→client)。
   - サーバは暗号乱数 nonce を生成し `socket.id` にバインドして保存、client に返す。
   - client は `window.solana.signMessage(nonce)` で署名し `requestBuilderByToken` に `{ walletAddress, signature, nonce }` を載せて送る (残高は送らない)。
   - サーバは `tweetnacl` の `nacl.sign.detached.verify(nonceBytes, signature, walletPubkeyBytes)` で検証。
3. 両方 (署名 OK かつ実残高 ≥ 必要量) 通過時のみ `player.modify({ rank: Ranks.BUILDER })`。セッション限定 (DB 非永続) の現行設計は維持。

**[C1] nonce 設計を厳守**:
- 単回使用: 検証成否いずれでも即破棄 (Map から delete)。
- `socket.id` バインド: 他 socket の nonce を流用不可。
- TTL 30〜60秒で失効 (発行時刻を保存し検証時にチェック。※ `Date.now()` はこのファイル内では通常コードなので使用可)。
- **RPC 失敗時は fail-CLOSE**: 残高取得が timeout/レート制限/例外で失敗したら**付与しない** (deny)。

**[I5] レート制限**: `onRequestBuilderByToken` (と nonce 要求) に per-socket クールダウン (例: 直近 N 秒に1回) を入れ、RPC 枯渇 DoS を防ぐ。

### (b) 署名検証依存の追加 (finding [C2])
- `package.json` の dependencies に `tweetnacl` を追加 (`@solana/web3.js@1.98` は任意メッセージ ed25519 検証を公開 API で提供しない)。node バンドル (server ビルド) に載ることを確認。
- インストール: `npm install tweetnacl`。

### (c) ハンドラを fork 専用モジュールへ切り出し (finding 0.2, [I4])
- 新規 `src/server/solana-gating.js` に検証ロジック (残高取得・署名検証・nonce 管理・レート制限) を移す。
- `ServerNetwork.js` 内の `TOKEN_GATING_ENABLED`/`REQUIRED_TOKEN_AMOUNT` 定数 (`:18-19`) もこのモジュールへ**移動**。`ServerNetwork.js` のハンドラは薄い委譲だけにし、upstream ファイルへの埋め込みを最小化 (将来マージ衝突を減らす)。
- `onRevokeBuilderByToken` (`ServerNetwork.js:482-510`) は**自 socket の降格のみ**で昇格にならないため署名検証**不要** (N2)。現行維持でよいが、モジュール移動に伴い整理する場合も検証追加は不要。

### (d) client 堅牢化 (finding 0.3/9.2, 0.5, 0.4, 9.4)
`src/client/solana-integration.js`:
- **エラー握り潰し修正**: `fetchTokenBalance` (`:72-79`) が RPC 失敗を残高0と混同している。`TokenAccountNotFoundError` (=本当に残高0) と、それ以外の RPC エラー (=不明) を区別し、後者は呼び出し側が「不明」として扱えるようにする (例: 例外を再throw か sentinel を返し、UI/権限判定で 0 と混同しない)。
- **config 0値許可 (0.5)**: `Number(...) || DEFAULT` を `Number.isFinite` ベースに (0 を明示設定可能に)。
- **default → named export (9.4)**: `export default function createSolanaIntegration` を named export に。呼出元 `world-client.js` の import も更新。
- **feature-flag (0.4)**: `config.tokenMint` 未設定なら `createSolanaIntegration` を呼ばない。

`src/client/world-client.js`: feature-flag 判定を追加し、未設定時は Solana 統合を初期化しない (`:9,48-49`)。
`src/client/components/CoreUI.js`: `world.solana` が存在するときのみ `SolanaWalletButton` を render (`:44` の `{ready && <SolanaWalletButton .../>}` を `{ready && world.solana && <SolanaWalletButton .../>}`)。
`src/client/components/SolanaWalletButton.js`: 署名フロー変更に伴う調整 (残高送信ではなく nonce 要求→署名の UX)、及び堅牢化に伴う表示調整。

### (e) [I1統合] 設定経路の runtime 解決 (finding 9.0)
`solana-integration.js` の config 解決を **0.5 の Number.isFinite チェックと単一変換に統合**:
```
process.env.PUBLIC_X ?? globalThis.env?.PUBLIC_X ?? DEFAULT   (数値は Number.isFinite で検証)
```
根拠: `PUBLIC_*` はビルド時に存在せず (Dockerfile がビルド時に fly.toml env を渡していない)、現状 Solana config はデプロイ経路で設定不能。`src/core/extras/Layers.js:27` の慣習に合わせ実行時 `/env.js` 注入 (`globalThis.env`) を効かせる。build.mjs/Dockerfile は変更不要。

## やらないこと
- `.dockerignore`/`Dockerfile` は 1B が所有。触らない。
- `packets.js` は既存 name の順序を変えない (追加のみ末尾に。wire 互換のため)。
- 過剰設計しない (nonce store は単純な in-memory Map で十分。永続化不要)。

## 検証手順
- `npm install` 後 `npm run build && npm run client:build` 成功。
- **攻撃再現テスト**: サーバ起動 + wallet 無しの client 接続 → devtools で `world.network.send('requestBuilderByToken', { walletAddress:'11111111111111111111111111111111', tokenBalance: 999999999 })` を送信 → **BUILDER が付与されない**こと (修正前は付与された)。署名 nonce 無しでは常に拒否。
- feature-flag: `PUBLIC_TOKEN_MINT` 未設定で client を開き、Solana UI (Connect Wallet ボタン) が**出ない**こと。
- 正常系 (可能なら): 正規 nonce+署名+実残高で BUILDER が付与されること (devnet で実 wallet が用意できなければロジックレビューで代替)。
- `npm run lint` でこれらファイルのエラーが増えないこと。
