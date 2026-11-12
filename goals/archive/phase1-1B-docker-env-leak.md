# Goal 1B — Docker/env 漏出修正 (インフラのみ・1A と並列安全)

**Phase 1 (セキュリティ) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: none**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
`.env` (実在, `SOLANA_PKEY_ARRAY` / `JWT_SECRET` / `AI_API_KEY` / `DB_URI` / `LIVEKIT_*` 等を含む) が `.dockerignore` の `.env.*` パターンに**一致せず** (素の `.env` にはマッチしない)、`Dockerfile` の `COPY . .` で Docker ビルドコンテキストに混入している (finding 0.1)。これはイメージレイヤーへの秘密漏洩リスク。

## 対象ファイル (単独所有 — 1A と非重複)
- `.dockerignore`
- `Dockerfile` (監査・必要なら最小修正)
- 鍵ローテーション報告 (実装ではなくテキスト報告)

**注意**: `scripts/build.mjs` と `src/client/solana-integration.js` は **1A が所有**。触らない (finding 9.0 の設定経路修正は 1A 側に集約済み)。

## やること (finding 0.1)

### 1. .dockerignore に素の .env を追加
`.dockerignore` に `.env` 行を追加 (既存の `.env.*` はそのまま。`!.env.example` の除外も維持)。
検証: `.env` が Docker ビルドコンテキストから除外されること。

### 2. Dockerfile 監査
`Dockerfile` を読み、`COPY . .` で他に秘密が混入していないか確認。`.dockerignore` が効く構成であることを確認 (最小修正のみ。大改変しない)。

### 3. 鍵ローテーション要否の報告 (実装ではなく調査)
`.env` の秘密 (特に `SOLANA_PKEY_ARRAY` — Solana 秘密鍵配列の可能性) が過去の Docker ビルド/公開イメージに含まれた可能性がある。**鍵ローテーションの要否を報告**する (git 履歴やデプロイ履歴から漏洩済みか判断できる範囲で。判断できなければ「要確認」として user にフラグ)。**秘密の値そのものは報告に含めない** (変数名のみ)。

## やらないこと
- `.env` の中身を書き換えない・値を出力しない。
- `scripts/build.mjs`, `solana-integration.js` を触らない (1A 所有)。
- Fly デプロイ設定 (`fly.toml`) を変更しない。

## 検証手順
- `tar --exclude-from=.dockerignore -cf - . | tar -tf - | grep -E '^\./.env$'` が**何も返さない** (=.env が除外された) こと。または `docker build` のコンテキストに .env が無いことを確認。
- `.env.example` は引き続き含まれること (`!.env.example`)。
- 報告に鍵ローテーション判断を明記。
