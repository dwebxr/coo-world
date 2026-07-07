# coo-world リファクタリング計画 (フェーズ分け)

> 方針: **ハイブリッド**。fork独自コード (`upstream_divergence=none`) は積極的にリファクタ。upstream由来コードは「低〜中リスクかつ価値が明確」なもののみ。`upstream_divergence=high` の大規模改変 (将来の hyperfy マージを壊す) は**スコープ外**として明示的に見送る。
> 目的の優先順位: (1) 安全網 → (2) セキュリティ/fork正当性 → (3) 保守性・可読性 → (4) AIエージェント基盤 → 横断してパフォーマンス。
> ベンダーコード (`src/core/physx-js-webidl.js`, `src/core/libs/**`) は一切触らない。

調査は Sonnet 10体並列 (Workflow) で完了。61件の所見を回収済み。各フェーズは**逐次** (前フェーズが監査を通ってから次へ)。フェーズ内のタスクはファイル非重複で **Sonnet 並列実装**。難易度・リスクが特に高いタスクは **Fable 5 直接実装**。

---

## リポジトリの前提事実 (実物確認済み)

- upstream `hyperfy-xyz/hyperfy` と 0コミット遅れ / 9コミット先行。fork独自差分は Solana 統合 (~590行) + `agent.mjs` のみ。
- `npm run lint`: **495 errors / 489 warnings**。うち ~214 は `PHYSX`/`lockdown`/SES script globals が eslint に未宣言なだけの偽陽性。`src/world/assets/ai.js:18` に本物のパースエラー1件。
- `.env` が実在し `SOLANA_PKEY_ARRAY` / `JWT_SECRET` / `AI_API_KEY` / `DB_URI` / `LIVEKIT_*` を含む。`.dockerignore` の `.env.*` は**素の `.env` に一致しない** → Docker ビルドコンテキストに漏出。
- テストは**ゼロ**。CI は push 時の Docker publish のみで lint/build ゲート無し。

---

## Phase 0 — 安全網 & ツーリング (全フェーズのゲート)

**なぜ最初か**: 以降の全バグ修正を「lint が通る / no-undef が消える / build 4種が緑」で検証するため、まず検証基盤を機能させる。すべて div:none/low・低リスク。

| Task | 内容 | 対象ファイル | 実装 |
|---|---|---|---|
| **0A** eslint 復旧 | `.eslintrc` に `globals: { PHYSX, lockdown }` 追加。`examples/**`・`src/world/assets/**` 用 overrides で SES script globals (`app,world,props,Vector3,Quaternion…`) を readonly 宣言。`src/world/assets/ai.js:18` の本物パースエラー修正。`scripts/**`・`agent.mjs` を lint 対象に含める (現状 `.mjs` 未マッチ)。**[I6対応] lint スコープ拡張で finding 7.1 の実 dead code (`scripts/*.mjs` 内の未使用 `execSync`/`polyfillNode`/`buildDirectory` 等) が新規顕在化するため、同タスク内で掃除する**。 | `.eslintrc`, `.eslintignore`, `src/world/assets/ai.js`, `scripts/*.mjs`(未使用除去のみ) | Sonnet |
| **0B** テストハーネス | `node --test` 導入。`package.json` に `"test"` script。純粋モジュールの初回テスト: `test/utils.test.js` (clamp/num 境界), `test/packets.test.js` (全 name の writePacket/readPacket 往復 + 未知name/id エラー経路), `test/ranks.test.js`。 | `package.json`, `test/**` (新規) | Sonnet |
| **0C** CI ゲート | GitHub Actions: PR で `lint` + build 4種 (`server/client/viewer/node-client`) + `test` を実行。 | `.github/workflows/ci.yml` (新規) | Sonnet |

> **監査ゲート [I6修正]**: `npm run lint` の **real error (偽陽性・SES globals・PHYSX を除いた実エラー) がゼロ**。0A 完了時点で残る warnings (no-console 等) はベースラインとして記録し「新規増加ゼロ」で判定 (全消しは Phase 2/3 で漸進)。`npm test` 緑、CI YAML が有効なこと。
>
> **0A と 0B/0C のファイル非重複**: 0A=`.eslintrc`/`.eslintignore`/`ai.js`/`scripts/*.mjs`、0B=`package.json`/`test/`、0C=`.github/`。`package.json` は 0B のみが編集 (0C は script を参照するだけ) → 並列安全。

---

## Phase 1 — セキュリティ & fork分離 (div:none / 最優先実益)

**なぜ2番目か**: fork独自コードは将来マージを壊さず自由に直せる。かつ現状**セキュリティ的に破綻**しており実益が最大。

> **[I1/I4対応] Phase 1 の再編**: 当初案の 1A/1B/1C は全て `solana-integration.js` を共有し並列不可だった。Solana 機能は ~590行と小さく client/server プロトコルで密結合するため、**全 Solana ソースを 1A (Fable 直接) が単独所有**。Docker/build インフラのみを 1B (Sonnet) に分離し、ファイル非重複で**1A と 1B を並列実行**する。

| Task | 内容 | 対象ファイル | 実装 |
|---|---|---|---|
| **1A** Solana セキュリティ & 堅牢化 (全ソース単独所有) | **(a) トークンゲーティング再設計** (finding 0.0/9.1): サーバは client 自己申告残高を無検証で信頼しウォレット所有証明も無い→devtools 一発で BUILDER 奪取可能。修正= サーバ側で `walletAddress` の残高を Solana RPC 実取得 (client申告は無視) + サーバ発行 nonce を `signMessage` で署名させ所有証明、**両方通過時のみ** `Ranks.BUILDER` 付与。**[C1] nonce 設計を明記**: 単回使用 (成否いずれでも即破棄)・`socket.id` バインド (他socketの nonce 流用不可)・TTL 30〜60秒失効・**RPC 失敗時は fail-CLOSE (付与しない)**。nonce 発行用パケット (`requestBuilderNonce`→`builderNonce`) を1往復追加。**[I5] `onRequestBuilderByToken` に per-socket レート制限/クールダウン** (RPC 枯渇 DoS 防止)。**(b) [C2] 署名検証依存を追加**: `tweetnacl` を direct dependency に追加 (`@solana/web3.js@1.98` は任意メッセージ ed25519 検証を公開APIで提供しない/`nacl.sign.detached.verify` を使用)。node バンドルへの影響確認。 **(c) ハンドラを fork専用 `src/server/solana-gating.js` に切り出し** `ServerNetwork.js` 埋め込みを最小化 (finding 0.2)。`ServerNetwork.js:18-19` の `TOKEN_GATING_ENABLED`/`REQUIRED_TOKEN_AMOUNT` 定数もこの新モジュールへ**移動** ([I4] 移動先で扱う)。 **(d) client 堅牢化**: RPC 失敗を残高0と混同しない (0.3/9.2)、config の `\|\|`→`?? ... Number.isFinite` (0値許可, 0.5)、feature-flag= `config.tokenMint` 未設定なら `createSolanaIntegration` を呼ばず `SolanaWalletButton` も描画しない (0.4)、`default export`→named export (9.4, 呼出元 world-client.js の import も更新)。 **(e) [I1統合] finding 9.0 の config 解決を 0.5 と単一変換に統合**: `process.env.X ?? globalThis.env?.X ?? DEFAULT` かつ `Number.isFinite` チェックを 1箇所で (実行時 `/env.js` 注入を効かせ、デプロイ経路で設定可能に)。署名側もここで実装。 | `src/core/systems/ServerNetwork.js`, 新規 `src/server/solana-gating.js`, `src/core/packets.js`, `src/client/solana-integration.js`, `src/client/components/SolanaWalletButton.js`, `src/client/world-client.js`, `src/client/components/CoreUI.js`, `package.json`(tweetnacl追加) | **Fable 5** |
| **1B** Docker/env 漏出 (インフラのみ・並列安全) | (1) `.dockerignore` に素の `.env` 追加 (`.env.*` は素の `.env` に非マッチ)。(2) `SOLANA_PKEY_ARRAY`/`JWT_SECRET`/`AI_API_KEY` 等が過去 Docker ビルドに含まれた可能性 → **鍵ローテーション要否を報告** (実装ではなく調査報告)。**build.mjs は変更不要** (finding 9.0 の修正は 1A 側 solana-integration.js に集約)。 | `.dockerignore`, `Dockerfile`(監査のみ), 報告 | Sonnet |

> **依存**: 1A は `package.json` の dependencies を編集 (tweetnacl 追加)。Phase 0 の 0B も `package.json` を編集するが**フェーズが異なる** (0 完了後に 1 開始) ため衝突しない。1A と 1B は完全ファイル非重複 → 並列実行可。
> **監査**: devtools からの偽 `requestBuilderByToken` (署名なし/偽残高) が拒否されること、正規 nonce+署名+実残高でのみ BUILDER 付与、未設定時に Solana UI が出ないこと、build 4種緑、`.env` が Docker コンテキストから除外されること。

---

## Phase 2 — 正当性バグ修正 (div:low / 低リスク / eslint復旧で顕在化)

Phase 0 で lint が機能した後に一掃。エリア別にファイル非重複で並列。

| Task | バグ (finding) | 対象 |
|---|---|---|
| **2A** nodes/yoga | flexWrap 自己再帰スタックオーバーフロー(3.0), `rturn` タイポ(3.1), Yoga enum誤り(3.2), flexDirection validator誤り(8.0) | `src/core/nodes/*`, `src/core/extras/yoga.js` |
| **2B** client UI | AppModelBtn 未定義`world`(5.0), NodeHierarchy 未import icon crash(5.1), particles 未知shape throw(5.2) | `src/client/components/*`, `src/client/particles.js` |
| **2C** server/entity | autosave 単発エラーで恒久停止(2.0), Chat.add createdAt未代入(2.1), ReferenceError系2件(2.2), handler null-guard(2.6), hasOwnProperty on payload(4.1)。**[I3修正] blueprint スキーマバグは3箇所/2ファイル**: `ClientBuilder.js:1166-1183`(addModel)・`ClientBuilder.js:1226-1243`(addAvatar) に `frozen:false` を補い、`ClientAI.js:38-57`(create) に `frozen:false` **+ `scene:false`** を補う (ClientAI は両方欠落)。全体 factory 化(div:high 1.3)は見送り、実バグのみ修正。 | `src/core/systems/{Server,Chat}*.js`, `src/core/entities/*`, `src/core/systems/ClientBuilder.js`, `src/core/systems/ClientAI.js` |
| **2D** AI経路クラッシュ | node-client が import時に window/navigator 参照でクラッシュ(6.0), onSnapshot が未登録 `ai.deserialize` 呼び(6.1) | `src/core/systems/ClientNetwork.js`, node-client bundle経路 |
| **2E** extras/misc | downloadFile が blob URL 同期revoke(8.2), 死んだ`simulateButton`+未使用import(1.0) | `src/core/extras/*`, `src/core/systems/ClientControls.js` |

---

## Phase 3 — デッドコード除去 (div:low / 低リスク)

> **[I2対応] 再編**: 当初 3A(Menu削除) と 3B(コメント除去) が両方 `CoreUI.js` を触り並列衝突していた。UI系デッドコードを **3A に集約** (CoreUI.js/Sidebar.js を単独所有、Menu*/Inputs/AppsPane の削除と import 除去も含む)。非UI系を 3B に分離しファイル非重複に。

| Task | 内容 | 対象 |
|---|---|---|
| **3A** UI デッドコード (client 単独所有) | Menu 生成コード一式削除 (`Menu.js`/`MenuApp.js`/`MenuMain.js`/`AppsPane.js` 計2058行, 5.3), `Inputs.js` 死コード516行(5.4), `CoreUI.js`/`Sidebar.js` のコメントアウト~230行+死state(5.5)。**削除ファイルの import 元を grep で全特定し除去** (CoreUI/Sidebar 経由)。5.7 Sidebar 分割は div:high でスコープ外 (このタスクでは触らない)。 | `src/client/components/` 配下: `CoreUI.js`, `Sidebar.js`, 削除= `Menu.js`/`MenuApp.js`/`MenuMain.js`/`AppsPane.js`/`Inputs.js` |
| **3B** 非UI デッドコード (core 単独所有) | `Entities.removed` 無限蓄積(2.3), core内 未使用import12件+debug log(4.6), octree死んだ可視化~140行(65MB確保経路含む)(8.1) | `src/core/systems/Entities.js`, `src/core/extras/{LooseOctree,SnapOctree}.js`, 他 core |
| **3C** lint-to-zero (Phase0監査で追加) | Phase0 で eslint 偽陽性除去後に残った実 error ~41件をゼロに: no-var 22 (機械的), no-async-promise-executor 13 (robustness/要注意, ServerLoader/ClientLoader のロード失敗握り潰し), getter-return 2 (Prim/Stage, 実バグ判定), no-case-declarations 2, no-inner-declarations 1, no-loss-of-precision 1 (prng, 数値不変)。これで 0C の「Phase3後に lint を CI 必須ゲート化」が可能に。 | `Curve.js`, `nodes/{Action,Audio,Nametag,Particles,SkinnedMesh,Sky,UI,UIText,UIView,Video,Prim}.js`, `AvatarPreview.js`, `ScriptEditor.js`, `loadPhysX.js`, `systems/{Apps,ClientLiveKit,ClientLoader,ServerLoader,Stage,ServerNetwork}.js`, `client/particles.js`, `extras/prng.js` |

---

## Phase 4 — 重複整理 (div:low のみ)

`upstream_divergence=high` の大型dedup (proxy 2192行/setter 253箇所) は**見送り**。低乖離の局所dedupのみ。

| Task | 内容 | 対象 |
|---|---|---|
| **4A** network dispatch | Server/Client の enqueue/flush 重複を共有ヘルパ化(2.4), builder権限チェック6重複(2.5) | `src/core/systems/{Server,Client}Network.js`, `System.js`/`utils.js` |
| **4B** player重複 | Modes enum(4.2), 権限メソッド(4.3), chat-bubble/nametag(4.4), App proxy factory(4.5) を PlayerLocal/Remote 間で共有化 | `src/core/entities/*` |
| **4C** client重複 | XR gamepad polling(1.1), video force-load(1.2), ClientLoader load/insert(1.5) | `src/core/systems/{XR,ClientLoader}.js`, video系 |
| **4D** 小重複/hygiene | Fields.js FieldVec3+hint(5.6), buttons.js 逆マップ(8.4), AssetsLocal/S3 hash(9.3), lodash→lodash-es(8.3), esbuild plugin重複(7.3) | `Fields.js`, `extras/buttons.js`, assets系, `scripts/*.mjs` |

---

## Phase 5 — AIエージェント基盤 (div:none/low)

| Task | 内容 | 対象 | 実装 |
|---|---|---|---|
| **5A** agent runtime | `agent.mjs` を実運用可能に: 再接続+指数backoff, kick理由(player_limit/duplicate_user/moderation)で分岐(6.3), chat/近傍entity購読の perceive→decide→act ループ化, `decide(perception)=>actions` プラガブル化(6.4)。 | `agent.mjs`, 新規ヘルパ | **Fable 5** (難度高) |
| **5B** multi-agent authToken | ClientNetwork.init に optional `authToken` を通し singleton `localstorage.json` 衝突を解消(6.2) → 複数エージェント同時起動可に。 | `src/core/systems/ClientNetwork.js`, `agent.mjs` | Sonnet |

---

## スコープ外 (意図的に見送り — 高マージコスト)

将来の upstream hyperfy マージを大規模に壊すため、ハイブリッド方針上**やらない**。別途 upstream への PR として提案する方が筋が良い。

- **3.3** getProxy() 定型 2192行 (24ファイル) の共有ヘルパ化 — div:high, L
- **3.4** setter前置き (validate→no-op→assign) ~253箇所 — div:high, M
- **1.3** blueprint/app-entity リテラル 12重複の factory化 (実バグの`frozen`欠落のみ Phase 2Cで修正) — div:high, M
- **1.4** `ClientBuilder.update()` 427行関数の分割 — div:high, L
- **5.7** `Sidebar.js` 1904行のディレクトリ分割 — div:high, L

---

## 検証方針 (テスト無し前提)

各フェーズ監査 (Fable 5) = `npm run lint` (real error 増加ゼロ) + `npm run build` (server/client/viewer/node-client 全緑) + `node build/index.js` 起動スモーク + 該当機能の手動確認 + Phase 0 以降は `npm test`。全フェーズ後に `/gpt-review` で差分レビュー (Critical/Bug/Security 全対応まで反復)。

---

## 計画ゲート結果 (2026-07-07)

Codex(GPT-5.5) は上限のため **Opus 4.8 サブエージェント (実物照合済み) で代替レビュー**。Critical 2 / Important 6 / Nit 6。**Critical・Important は全て本計画に反映済み** (上記 [C1][C2][I1]〜[I6] タグ)。

- **N2 (revoke は署名検証不要)**: `onRevokeBuilderByToken` (`ServerNetwork.js:482-510`) は自 socket の rank 降格のみで権限昇格にならないため、署名検証は不要。1A では revoke を変更対象にしない (現行維持)。TOCTOU (残高取得→付与) と「複数socketで同一wallet」も、付与がセッション限定・wallet所有者本人の行為に留まり昇格にならないため許容範囲。
- **N1 (dead→dedup 順序は正しい)**: Phase 3(dead) を Phase 4(dedup) より先にするのは正。逆順だと削除予定コードを dedup する手戻りが出る (例: finding 8.2 downloadFile 呼出は削除対象 `Menu.js:689,831` を含む)。
- **N6 (Phase 5 順序充足)**: node-client crash (6.0) は Phase 2D で修正 → Phase 5 の agent 検証が可能に。2D と 5B が共に `ClientNetwork.js` を触るが逐次フェーズのため可。
