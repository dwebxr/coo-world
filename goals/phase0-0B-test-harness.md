# Goal 0B — テストハーネス導入 (node:test)

**Phase 0 (安全網) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: none/low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
現在テストはゼロ。Node 組込みの `node:test` + `node:assert` (追加依存ゼロ) で最初のテストを導入し、純粋・依存の薄いコアモジュールから安全網を張る。特に wire protocol (`packets.js`) の回帰を捕捉できるようにする。

## 対象ファイル (単独所有)
- `test/` ディレクトリ (新規作成) **のみ**。
- **`package.json` は触らない**。`scripts.test = "node --test test/"` の追加は 0A が行う (Phase 0 の package.json 一元管理・競合防止)。0A → 0B の順で実行されるため、あなたが着手する時点で test script は既に存在する。

## やること (finding 7.4)

### 1. テストファイル作成
純粋モジュールを確認してからテストを書くこと (実際の export シグネチャに合わせる):

- **`test/utils.test.js`** — `src/core/utils.js` の `clamp(n, low, high)` と `num(min, max, dp)` の境界ケース (下限/上限/範囲内/dp 丸め)。
- **`test/packets.test.js`** — `src/core/packets.js` の `writePacket`/`readPacket` を使い、`names` 配列 (packets.js:6-31) の**全 name** を round-trip (write→read で name と payload が一致)。加えて未知 name / 未知 id のエラー経路 (packets.js:55, :64) を assert。
  - このテストの価値: `names` 配列の並べ替え・重複が入ると全パケット型が wire 上で壊れるが、現状それを捕捉するものが無い。
- **`test/ranks.test.js`** — `src/core/extras/ranks.js` の `isRank`/`hasRank` (13行, 純粋関数)。

### 3. 動作確認
`npm test` が全て緑になること。

## やらないこと
- テスト対象モジュールの**実装は変更しない** (テストを書くだけ)。もしテスト作成中に実バグを見つけたら**報告のみ** (該当は Phase 2 が担当)。
- `storage.js`/`prng.js` のテストは今回のスコープ外 (将来漸進)。無理に追加しない。
- CI 設定 (`.github/`) は 0C が担当。触らない。

## 検証手順
- `npm test` が pass。
- 回帰検出の実証: `packets.js` の `names` 配列の2要素を一時的に入れ替えると round-trip テストが**落ちる**ことを手元で確認 (確認後は元に戻す)。→ 報告に記載。
- `npm run lint` で新規 test ファイルにエラーが出ないこと (必要なら test/ 用の env: node を eslint override で… ただし .eslintrc は 0A 所有なので、必要が生じたら報告し 0A と調整。基本は `/* eslint-env node */` 等ファイル先頭コメントで回避)。
