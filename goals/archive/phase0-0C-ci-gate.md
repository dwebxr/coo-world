# Goal 0C — CI ゲート (GitHub Actions)

**Phase 0 (安全網) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: none**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
現在 CI は push 時の Docker publish のみで、lint/build/test のゲートが無い。PR で自動検証を走らせ、以降の変更が壊れないようにする。

## 対象ファイル (単独所有)
- `.github/workflows/ci.yml` (新規作成)
- (既存の `.github/workflows/` の Docker publish workflow は**触らない** — 確認のみ)

## やること (finding 7.2)

1. 既存の `.github/workflows/` を確認し、命名が衝突しないファイル名 (`ci.yml`) で新規作成。
2. PR (`pull_request`) と main への push で以下を実行:
   - Node セットアップ: `.nvmrc` / `package.json` engines に合わせる (node 22.11.0)。`actions/setup-node` で `cache: npm`。
   - `npm ci`
   - `npm run lint`
   - build 4種: `npm run build`, `npm run client:build`, `npm run viewer:build`, `npm run node-client:build`
   - `npm test`
3. lint はこの時点ではまだ本物の error が残っている可能性がある (Phase 2/3 で解消)。そのため **lint ステップは初期は `continue-on-error: true` かベースライン許容**にし、build と test を**必須ゲート**にする。lint を必須化するタイミングはコメントで明記 (Phase 3 完了後)。

## やらないこと
- 既存 Docker publish workflow を変更しない。
- deploy 系のジョブは追加しない (Fly デプロイは手動手順)。
- `package.json` を編集しない (0B が所有)。script は参照するだけ。

## 検証手順
- YAML の構文が有効であること (`node -e` や yamllint 相当、または GitHub Actions のスキーマに沿っているか目視)。
- ワークフローの各コマンドがローカルで通ること (`npm run lint` 以外は緑、lint はベースライン)。
- 参照する npm script (`build`, `client:build`, `viewer:build`, `node-client:build`, `test`) が `package.json` に存在することを確認 (test は 0B が追加)。
