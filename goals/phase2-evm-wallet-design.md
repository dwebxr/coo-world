# Phase 2 設計: EVM ウォレット接続 (P1) と事前確認 (P0)

状態: v2 (計画レビュー反映済み、実装着手可)。対象は P0〜P1 のみ。P2 (投げゼニ) / P3 (NFT ゲート) は範囲外だが、P1 の判断が詰まらないよう接点だけ記す。

## 1. 目的とスコープ

- 右上のウォレット UI で Solana に加えて EVM (Polygon を主軸) のウォレットを接続・所有証明できるようにする。
- P1 の成果物は「EVM アドレスの所有をサーバーが SIWE (EIP-4361) で検証し、そのセッション状態がクライアントとサーバーで一致する」ところまで。
- **P1 は EOA のみ。** スマートアカウント (EIP-1271 / 6492) は P1.5 (§12)。
- 送金・NFT 判定・DB 永続化・他プレイヤーへのアドレス公開は P1 に含めない。

## 2. 現状 (調査済み事実)

- UI: `src/client/components/SolanaWalletButton.js`。`window.solana` 直結、ウォレット選択なし。`CoreUI.js:104` で `world.solana` がある時だけ描画。
- `world.solana` は `PUBLIC_TOKEN_MINT` 未設定だと生成されない (`solana-integration.js:59`)。UI が丸ごと消える。
- 検証フロー: `requestBuilderNonce` → `builderNonce` → `requestBuilderByToken` → `walletStatus` (SIWS 形式、tweetnacl)。状態はソケット単位のメモリ (`socket.wallet`, `createWalletSession`)。加えて、トークン付与ビルダーだけがアップロード制限用のモジュール内 `wallets` Map に入る (`solana-gating.js:118-128`)。DB・プレイヤーデータには保存しない (docs/scripting/world/Player.md:65)。
- 世代管理 `invalidateWallet` / `current` は `socket.wallet.generation` に固定 (`ServerNetwork.js:724-741`)。
- パケットは `src/core/packets.js` の `names` 配列 (30 件)。ID は並び順。末尾追加のみ可、上限 128。`test/packets.test.js` が凍結コピーで順序を検証している。
- 受信サイズ上限は `inboundPolicy.js` の表 (未登録は 32 KB / 4096 ノード)。
- EVM 依存は未導入。スクリプトからウォレットは読めない。

## 3. P0: 事前確認項目

| # | 項目 | 結果 / 方法 | P1 への影響 |
|---|---|---|---|
| 0-1 | JPYC: decimals / EIP-2612 / EIP-3009 / EIP-712 domain / 制限 | §10 参照 | なし (P2) |
| 0-2 | JPYC 各チェーンのアドレス一致 | §10 参照 | なし (P2) |
| 0-3 | OpenPay 保護配布 NFT | **未デプロイ** (§10) | なし (P3 は待ち) |
| 0-4 | 法務方針: 非カストディ直接送金に限定 | 人間の判断 | P2 の設計制約 |
| 0-5 | viem のサーバー動作 | viem 2.57.8 (2 週間以上前の版を exact 固定) で SIWE 生成と EOA 検証を確認済み。クライアントには入れない (§4-4) ので SES lockdown 下のバンドル検証は不要 | 解消 |
| 0-6 | SIWE domain = ページのホスト | `WALLET_HOST` は `PUBLIC_API_URL` / `PUBLIC_WS_URL` のホスト。MetaMask は domain とページ origin の不一致で警告を出す。dev (`.env.example` の `localhost:3000`) と Fly (`fly.toml` の `play.dwebxr.xyz`) はページと API が同一ホストで一致を確認済み。フォールバックの `coo-world` は viem の `createSiweMessage` が domain として拒否する (RFC 3986 authority 検査) ため、起動時のメッセージ生成プローブで失敗し、EVM を無効にしてエラーログを出す | 解消 |
| 0-7 | viem と SES lockdown | サーバーは lockdown 下で動く。`viem` ルートは読み込み時に凍結済み `Function.prototype.call` への代入で落ちる。`viem/utils` / `viem/siwe` は lockdown 下で読み込み・検証できることを確認。サブパスのみ使う | 解消 |

## 4. 設計方針

1. **Solana 経路のロジックは触らない。** `solana-integration.js` / `solana-gating.js` / 既存ハンドラ / 既存パケットは現状維持。UI のみ、外枠 (シェル) を共通化するため `SolanaWalletButton.js` を分割する (§7)。
2. **EVM は並列モジュールとして追加。** `world.evm` を新設し、Solana と同じ形 (connect / disconnect / getState / dispose) の API。両チェーンは独立に接続・検証できる。
3. **EVM の検証はランクを変えない。** ビルダー権限付与は従来どおり Solana トークンのみ。P3 で NFT による権限付与を検討する場合、`rankGrants.js` / `tokenGrantedRank` が単一ウォレット前提である点 (両チェーンが BUILDER を付与すると revoke が衝突する) を P3 の設計で解く。
4. **viem はサーバー専用。** クライアントは生の EIP-1193 (`eth_requestAccounts` / `personal_sign` / `accountsChanged`) と、EIP-6963 の発見 (自前の約 30 行、mipd も入れない) だけで足りる。サーバービルドは `packages: 'external'` なので viem はバンドルされない。wagmi / RainbowKit / Reown は入れない。MetaMask / Rabby のモバイルアプリ内ブラウザは `window.ethereum` を注入し 6963 も出すので P1 で動く。WalletConnect は P1.5 以降の別判断。
5. **ブラウザにも サーバーにも RPC を持たせない (P1)。** EOA 検証はローカル計算のみ。

## 5. 設定

| 変数 | 側 | 既定 | 意味 |
|---|---|---|---|
| `PUBLIC_EVM_CHAIN_IDS` | 両方 | 空 (=無効) | 例 `137`。カンマ区切りの正の整数。先頭を SIWE の chainId に使う |

`PUBLIC_EVM_CHAIN_IDS` が空 (または不正) なら `world.evm` を生成せず、サーバーも EVM パケットを無視する。Solana のみの既存デプロイは挙動不変。
RPC URL を将来追加する場合は `PUBLIC_` を付けない (`PUBLIC_` で始まる名前は denylist 完全一致以外すべて `/env.js` でブラウザへ配られる)。

## 6. プロトコル (パケット追加は末尾のみ、`PROTOCOL_VERSION` は 2 のまま)

`names` の末尾 (`requestBuilderRecheck` の後, ID 30〜34) に追加:

| 名前 | 向き | ペイロード | 受信上限 |
|---|---|---|---|
| `requestEvmNonce` | C→S | {address, attempt} | 128 B |
| `evmNonce` | S→C | {attempt, nonce, message} または {attempt, retryAfterMs} | — |
| `requestEvmVerify` | C→S | {address, signature, nonce, attempt} | 512 B |
| `evmWalletStatus` | S→C | {verified, wallet?, attempt?, reason?} | — |
| `revokeEvmWallet` | C→S | {} | 16 B |

- `reason` は初版から持つ: `ok` / `nonce_expired` / `signature_invalid` / `bad_request`。P1.5 で `smart_wallet_unsupported` 等を追加してもパケット変更が要らない。

### 検証規則 (サーバー、`src/server/evm-gating.js` の純関数)

- address: `/^0x[0-9a-fA-F]{40}$/`。大文字小文字混在でもチェックサム不一致は拒否しない (正規化してから使う)。保存・返信は EIP-55 (viem `getAddress`)。
- signature: `/^0x[0-9a-fA-F]{130}$/` (65 バイト、EOA のみ)。
- nonce / attempt: Solana と同じ検証関数 (`isWalletNonce` / `isWalletRequestId`) を再利用。
- メッセージ: viem/siwe の `createSiweMessage` でサーバーが生成 (domain = `WALLET_HOST`, uri = `WALLET_URI`, version `1`, chainId = 先頭チェーン, nonce = 64 hex, issuedAt / expirationTime は TTL 60 秒, statement は Solana と同じ一文)。
- **クライアントからメッセージは受け取らない。** 署名はサーバーが保存した文字列に対して検証する (Solana の `checkChallenge` と同じ)。`parseSiweMessage` はテストで「生成メッセージが期待フィールドに戻ること」の確認にだけ使う。
- 署名検証は `viem` トップレベルの `verifyMessage` (EOA のみの recover + 比較、RPC 不要)。

### ハンドラ (ServerNetwork.js)

- セッションは `socket.evmWallet = evmGating.createEvmWalletSession()` (`generation`, `verified`, `challenge`, `lastChallengeAt`, `challengeCooldownReplied` を独自に持つ)。
- 世代管理は `invalidateEvmWallet(socket, {clearVerified})` と `currentEvm(socket, generation, player)` を新設。**EVM の経路は `socket.wallet` を読みも書きもしない。** Solana の検証中に EVM の nonce 要求が来ても Solana 側は取り消されない (テストで保証)。
- `onRequestEvmVerify` は async (viem の検証は Promise を返す)。`await` の前に `challenge = null` で使い切りにし、`await` の後に `currentEvm` を再確認する。
- クールダウン 5 秒 (チェーンごとに独立)、返信は 1 回だけ (Solana と同じ)。
- アドレスを不正な形のまま viem に渡さない (例外で返信なしになり、クライアントが 15 秒待つのを防ぐ)。形が不正な要求は黙って捨てる (Solana と同じ扱い)。
- `onDisconnect` で EVM 用の追加後始末は不要 (モジュール内 Map を作らない)。

## 7. クライアント

- `src/client/evm-integration.js` を新設。`createEvmIntegration(world)`。依存なし (viem 不使用)。
  - EIP-6963: `eip6963:announceProvider` を受けて provider 一覧を保持し、`eip6963:requestProvider` を発火。`getProviders()` を公開。一覧が空なら `window.ethereum` にフォールバック。
  - `connect(providerId?)`: `eth_requestAccounts` → `requestEvmNonce` → `evmNonce` 待ち (検証: nonce 64 hex、message 1..1024 バイト、attempt 一致) → `personal_sign([hex(utf8(message)), address])` → `requestEvmVerify` → `evmWalletStatus` 待ち。待ち時間・世代管理は solana-integration と同じ流儀。
  - **受理判定は小文字比較:** `data.wallet.toLowerCase() === address.toLowerCase()`。MetaMask は小文字、サーバーは EIP-55 を返すため。表示にはサーバーが返したチェックサム形を使う。
  - `accountsChanged`: 空配列 (サイトの権限取り消し) も含めて切断し、再署名を促す。`chainChanged` は P1 では無視 (検証はアカウント所有の証明で、メッセージの chainId は表示用。送金前のチェーン切替は P2)。
  - 切断時は `wallet_revokePermissions` を best effort で呼び、失敗は無視。
- `ClientNetwork.js`: `onEvmNonce` / `onEvmWalletStatus` を `evm:nonce` / `evm:walletStatus` に中継。`disposeWallet` で `world.evm?.dispose(reason)` も呼ぶ (タイマー・リスナー・provider のイベントを接続終了時に必ず外す)。
- `world-client.js`: `createEvmIntegration(world)` を Solana の隣で呼ぶ。
- UI:
  - `SolanaWalletButton.js` を、外枠 `WalletButton.js` (位置・トグル・Esc・pointer-lock の inert・開閉の記憶) と中身 `SolanaWalletPanel` に分割する。CSS クラス名・`#solana-wallet-panel` の id・localStorage キー `solanaWalletUI` は e2e と既存ユーザーの互換のため維持。
  - `EvmWalletPanel` を新設。両チェーンが有効ならタブ (Solana / EVM) で切替。選択タブも同じキーに `{collapsed, tab}` で保存。
  - トグルの集約表示: どちらかが connecting / signing ならスピナー。ドットの緑/橙は Solana のビルド権限の意味のみ。Solana 未接続で EVM 検証済みなら青ドット。EVM パネルには「ビルド権限」の文言を出さない。
  - CoreUI の表示条件を `world.solana || world.evm` に変更。
  - 署名メッセージの全文表示はしない (ウォレット側が表示する)。
- スクリプト向けの `wallet` イベントは Solana のまま変えない。EVM 用のスクリプト向けイベントを P2/P3 で足す場合は `internalEvents` に登録する。

## 8. セキュリティ・プライバシー

- 署名は取引を承認しない旨を文面に明記。
- nonce 使い捨て、TTL 60 秒、ドメイン/URI 束縛、サーバー保存文字列での検証で、リプレイと改ざんを防ぐ。
- EVM アドレスは P1 では他クライアントへ送らない (プレイヤーエンティティにも載せない)。P2 での公開は、プレイヤーデータではなく別パケットのオプトインにする (`sanitizePlayerSelfModify` 経由の偽装を避ける)。
- 同一アドレスの複数セッション認証は許容 (匿名ユーザー前提)。
- サーバーに秘密鍵を置かない。休眠中の `SOLANA_PKEY_ARRAY` 等は使わない。

## 9. 実装手順とテスト

実装手順:
1. `src/server/evm-gating.js` (設定解析、アドレス/署名検証、チャレンジ生成・検証、セッション生成)。
2. `packets.js` に末尾追加、`inboundPolicy.js` に上限追加。
3. `ServerNetwork.js`: セッション生成、`invalidateEvmWallet` / `currentEvm`、ハンドラ 3 本。
4. クライアント: `evm-integration.js`、`ClientNetwork.js` の中継と dispose、`world-client.js`。
5. UI: `WalletButton` / `SolanaWalletPanel` / `EvmWalletPanel`、`CoreUI.js`、文言。
6. `.env.example` / README / CHANGELOG 追記。

テスト:
- `test/evmGating.test.js`: 正常 (小文字アドレス含む)、期限切れ、nonce 不一致、アドレス不一致、署名不正・形式不正、chainId / domain / uri がメッセージに入ること (`parseSiweMessage`)、設定解析。
- `test/serverEvmWallet.test.js` (networkHarness): 往復成功、古い attempt を無視、クールダウンと返信 1 回、検証中の世代競合、revoke、**EVM の要求が Solana の検証を取り消さないこと**、チェーンごとのクールダウン独立、無効時は無視、ランク不変。
- `test/evmClient.test.js` (clientHarness): 偽 EIP-1193 provider で往復、小文字アドレスの受理、承認拒否、nonce タイムアウト、accountsChanged (空配列含む)、dispose 後に何も残らない、6963 の発見とフォールバック。
- 既存の更新: `packets.test.js` の凍結表、`inboundPolicy.test.js` の上限、`networkHarness.mjs` のメソッド一覧と `evmGating` 注入、`solanaWalletButton.test.js` を分割後のパネルに追従、`publicEnv.test.js` に `PUBLIC_EVM_CHAIN_IDS` は配られる旨。
- 回帰: 既存テスト全通過、`PUBLIC_EVM_CHAIN_IDS` 未設定で従来と同一。
- e2e: `test/e2e/evm-wallet.mjs` (実ビルドのサーバー)。ワイヤーで SIWE 往復・他鍵の署名拒否・上限超過パケットの破棄、ブラウザで偽 EIP-6963 ウォレット (署名は Node 側、`page.exposeFunction`) による Solana/EVM タブ・接続と検証・畳み時の青ドット・再読み込み後のタブ記憶・切断。既存 `token-gate.mjs` を UI 分割の回帰確認として実行。

## 10. P0 結果

調査日 2026-11-08。VERIFIED = 自分で確認、REPORTED = 調査エージェントが二次情報から報告、UNVERIFIED = 未確認。

### JPYC (0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29)
- decimals = 18: **VERIFIED** (Polygon に `eth_call decimals()` → 0x12)。
- name = "JPY Coin" / symbol = "JPYC": **VERIFIED** (Polygon 上の `name()` / `symbol()`)。
- ERC1967 プロキシ (アップグレード可能)、実装 0xafAC17FC3936A29CA2D2787cEd3c5d1c52007d2e: **VERIFIED** (Polygon の EIP-1967 実装スロットを直接読んで一致)。実装は差し替え可能なので挙動が将来変わり得る。
- `nonces(address)` が応答: **VERIFIED** (EIP-2612 permit の存在を示唆するが、`permit` 自体は未テスト)。
- `DOMAIN_SEPARATOR()` と `version()` は revert: **VERIFIED**。EIP-712 ドメイン name="JPY Coin", version="1" は OpenPay の dry-run (PR #29, Polygon/Kaia で署名が通った) に依拠する **REPORTED**。
- EIP-3009 (`transferWithAuthorization` / `receiveWithAuthorization`): **REPORTED** (実装のソースファイル名に EIP3009.sol、OpenPay の Polygon dry-run 成功)。Ethereum / Avalanche は **UNVERIFIED**。
- blocklist / pause: **REPORTED** (ソースファイル名のみ)。送金が拒否され得る前提で UI を作る。
- 4 チェーン (Ethereum / Polygon / Avalanche / Kaia) で同一アドレス: JPYC 公式 README の記載 (**REPORTED**)。オンチェーン確認は Polygon のみ。

### OpenPay
- `OpenPayLicense1155` (保護配布の利用許諾 NFT) は **未デプロイ**。公式 contracts README に「アドレスの記載なし」。→ **P3 は外部依存が未着地のため着手不可**。
- `Eip3009Forwarder` (Polygon 0x0F4560a777415580F0680F8B56a79B0022C6B848) は alpha・監査なし。本プロジェクトは直接依存しない。
- openpay-x402-sdk の最新は 0.10.5 (2026-10-30)。

### P0 の結論
- P1 のブロッカーなし。
- P2 の投げゼニは最初は通常の ERC-20 `transfer` (18 decimals、ガスは送り手負担)。EIP-3009 のガスレスは後続の最適化。
- P3 は OpenPay NFT の公開待ち。それまでは「任意の ERC-721/1155 コントラクト+tokenId を設定して `balanceOf` で判定する」汎用ゲートに寄せる。

## 11. 計画レビューの結果 (Fable, 2026-11-08)

判定: 条件付き GO。全指摘を v2 に反映した。

- ブロッカー: B1 Solana と世代カウンタを共有するとチェーン間で検証を取り消し合う → 独立セッションと `*Evm` 双子関数 (§6)。B2 アドレスの大文字小文字で受理判定が常に失敗 → 小文字比較 (§7)。B3 P1 の 1271/6492 は RPC 増幅・非同期の規則不足 → P1 は EOA のみ、P1.5 へ (§12)。
- 要修正: メッセージ再構築は無意味 → 保存文字列で検証。MetaMask の domain 警告 → 0-6。dispose 漏れ → `disposeWallet`。受信上限表 → §6。テストハーネスの更新 → §9。viem はサーバー専用 → §4。`PUBLIC_` の配布 → §5。nonce ペイロード検証 → §7。UI の外枠分割と集約表示 → §7。

## 12. P1.5 (別途): スマートアカウントと WalletConnect

- EIP-1271 / 6492 は `viem/actions` の `verifyMessage` (PublicClient 必須) で検証する。サーバー専用 `EVM_RPC_URL_<chainId>` を導入。
- 必須規則: await 前に challenge を使い切り、await 後に `currentEvm` 再確認、RPC 呼び出しにタイムアウト・ソケットあたり 1 件・全体予算 (`tokenBalanceService` 相当)、RPC 障害時は `reason` で区別して返す。6492 署名は数 KB になり得るので `requestEvmVerify` の上限を別途決める。1271 はチェーン依存なので、対象チェーンをメッセージの chainId に固定する。
- WalletConnect (Reown) はモバイル外部ウォレットのため。導入時はバンドルと SES lockdown 下での動作確認を P0 として行う。

## 13. 実装結果とレビュー記録 (2026-11-08)

ブランチ `feat/evm-wallet-p1` (未コミット)。

- 実装中の発見: サーバーの SES lockdown 下で `viem` ルートの読み込みが失敗する (0-7)。`viem/utils` / `viem/siwe` のみ使用し、lockdown 下での読み込みと検証をテストで固定。フォールバック host `coo-world` は SIWE の domain として拒否されるので EVM は無効になる (0-6)。
- コードレビュー (Codex GPT-6 Astra, xhigh, read-only): ブロッカーなし。Major 2 / Minor 4、全件修正。
  1. 既知 uuid への別 provider の announce で乗っ取り → 最初の紐付けを固定。
  2. 15 秒後に届いた成功でサーバーだけ検証済みが残る → 失敗時にサーバー試行があれば `revokeEvmWallet`。
  3. アカウント取得中の `accountsChanged([])` を無視 → 取得中の通知を記録し、結果と食い違えば中止。
  4. パネル再マウントで選択ウォレットを失う → `world.evm` が選択を保持。
  5. UI 分割で更新ボタンのロックが畳むと消える (回帰) → パネルは常時マウントし `hidden` で隠す。開閉/タブの ref は同期更新。
  6. dispose 後に UI が Verified のまま → dispose で最終状態を publish。
- 修正差分の確認 (Codex): 6 件とも FIXED、新たな回帰なし。
- テスト: ユニット 1227 件全通過 (新規 39 件)、`evm-wallet.mjs` 8/8、`token-gate.mjs` 10/10 (Chromium)。`npm audit` は着手前と同じ 13 件 (viem 由来なし)。
- 残課題 (範囲外): Solana 側の `solana-integration.js` にも「ack 期限後の成功でサーバーだけ検証済みが残る」同型の挙動がある (既存)。P1.5 (1271/6492, WalletConnect)、P2 (投げゼニ)、P3 (NFT ゲート, OpenPay のデプロイ待ち)。
