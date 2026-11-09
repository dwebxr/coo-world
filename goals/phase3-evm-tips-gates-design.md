# Phase 3 設計: 投げゼニ (P2)・NFT ゲート (P3)・Solana 修正

状態: v2 (計画レビュー反映、§11 が優先)。前提は Phase 2 (P1: EVM 所有証明, `goals/phase2-evm-wallet-design.md`) が作業ツリーにあること。

## 0. スコープ

| 項目 | 内容 | 状態 |
|---|---|---|
| S | Solana: 検証要求を送った後の失敗 (確認待ちの期限切れ) で `revokeBuilderByToken` を送る。EVM の Codex 指摘 #2 と同型 | 実装済み (§1) |
| R | サーバー専用の EVM JSON-RPC クライアント (P2/P3 共通) | 設計 |
| P2a | 受け取りの意思表示 (真偽値のみ配布)・送金の意思表示 (tip intent) で送り手にだけアドレスを渡す・ウォレットから直接送金・エクスプローラーへのリンク。RPC 不要、告知なし | 今回 |
| B1 | 空の名前によるシステムメッセージの偽装を塞ぐ (既存の穴。P2b の前提) | 今回 |
| P3 | 汎用 NFT 保有判定 (ERC-721 / ERC-1155) をサーバースクリプトから使える API と、ゲート付き app の例 | 今回 |
| P2b | オンチェーン検証・チャット告知・`tip` スクリプトイベント (§4.5–4.6 に §11 の対策を入れてから) | 次回 |

範囲外: P1.5 (EIP-1271/6492, WalletConnect)、OpenPay の配信チケット (`verifyDeliveryTicket`)、送金のガスレス化 (EIP-3009)、DB 永続化。

## 1. S: Solana の期限切れ後の取り下げ

- `solana-integration.js` の `fail()` は、`requestBuilderByToken` を送った試行 (`run.verifySent`) に限り `revokeBuilderByToken` を送る。
- それより前の失敗 (nonce 待ちの期限切れ、署名の拒否) は送らない。nonce 要求の時点でサーバーは検証状態を消しており、revoke はトークン付与のビルダー権限も外すため、従来の挙動を変えないため。
- 期限切れの後に検証成功とビルダー付与が遅れて届いた場合、revoke によって両方が取り消され、クライアント表示 (未検証) と一致する。

## 2. 事実 (調査)

- JPYC (Polygon 137): `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`, decimals 18 (オンチェーン確認済み)。
- USDC (Polygon 137, native): `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, decimals 6, symbol `USDC` (オンチェーン確認済み)。
- ERC-20 `Transfer(address,address,uint256)` topic0 = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` (viem で計算)。
- Polygon PoS は Heimdall v2 (2025-07) 以降、milestone finality 2〜5 秒。`eth_getBlockByNumber('finalized')` で確定済みブロックを取れる。
- polygon-rpc.com は Ankr 運営になり、キー無しアクセスは非推奨。本番はキー付きプロバイダー (Alchemy / Infura / Ankr) をサーバー専用で使う。
- OpenPay の利用許諾 NFT: 標準 ERC-1155。tokenId は商品ごと `keccak256(UTF8('openpay:license:' + productId))`。コントラクトのアドレスは未確認 (デプロイ待ち)。SDK の `hasLicense` は `balanceOf(address, tokenId)` を最新ブロックで読む。→ P3 の汎用 ERC-1155 判定に `contract` と 16 進 `tokenId` を渡せばそのまま使える。(2026-11-10 追記: Polygon の `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` にデプロイ済み。プロキシではなく、`balanceOf` は標準のまま。チェーンでの確認と、これを使うドアは goals/phase7-openpay-nft-door-design.md)
- 法務 (法的助言ではない): JPYC は電子決済手段、発行体は第二種資金移動業者。ユーザーが自分のウォレットで署名し、受取人へ直接送られ、本サービスが鍵・資金を持たず、手数料・交換・保管をしない形は、電子決済手段等取引業に当たりにくいと考えられるが、公式の判断は見つかっていない。公開前に弁護士または金融庁の事前相談で確認する。

## 3. R: サーバー専用 EVM JSON-RPC

- 設定: `EVM_RPC_URL_<chainId>` (例 `EVM_RPC_URL_137`)。`PUBLIC_` を付けない (ブラウザに配られない)。`PUBLIC_EVM_CHAIN_IDS` に含まれるチェーンだけ読む。
- `src/server/evmRpc.js`: `createEvmRpc({ url, fetch, timeoutMs, maxConcurrent, maxResponseBytes })` → `call(method, params)`。
  - JSON-RPC 2.0、タイムアウト (既定 5 秒)、同時実行数の上限、レスポンスの大きさの上限、`error` は例外、結果の形は呼び出し側で検証。
  - Solana の `solanaRpc.js` / `tokenBalance.js` の作法 (期限・同時数・トークンバケット) に合わせる (§9 で具体化)。
- 使う RPC メソッドは `eth_getTransactionReceipt` / `eth_getBlockByNumber('finalized')` / `eth_call` / `eth_chainId` のみ。起動時に `eth_chainId` が設定と一致しなければその URL を使わない (誤設定で別チェーンの結果を信じない)。

## 4. P2: 投げゼニ

### 4.1 設定

| 変数 | 側 | 既定 | 意味 |
|---|---|---|---|
| `PUBLIC_EVM_TIP_TOKENS` | 両方 | 空 (=無効) | 例 `JPYC,USDC`。投げゼニのチェーンは SIWE と同じ先頭チェーン。組み込み表 (Polygon 137 の JPYC / USDC) の記号か、`SYMBOL:0xaddress:decimals` の明示指定 |
| `EVM_RPC_URL_<chainId>` | サーバー | 空 | 送金の検証と告知に使う。無ければ告知しない (送金自体はウォレットで可能) |

### 4.2 受け取りの意思表示 (オプトイン、アドレスは配らない)

- 既定ではアドレスを誰にも見せない (P1 の方針と Player.md の「アドレスはプレイヤーデータに入れない」を維持)。
- EVM パネルで検証済みのとき「Receive tips」スイッチ (既定オフ)。オンにすると「投げゼニを始めた相手には、送金先としてこのアドレスが見える」旨を表示する。
- パケット `setEvmTipReceive {enabled}` (C→S)。サーバーは検証済みアドレスがある時だけ `socket.evmWallet.receiveTips` を立て、プレイヤーエンティティには真偽値 `evmTips` だけを載せて `entityModified` で配る。アドレスは `player.data` に入れない (全クライアントとクライアントスクリプトに配られるため)。
- `evmTips` はクライアントの自己変更許可リスト (`sanitizePlayerSelfModify`) に無いので偽装できない。`PlayerRemote.modify` / `PlayerLocal.modify` に分岐を追加する (無いとクライアントで無視される)。
- EVM の検証が消える時 (revoke、新しい nonce 要求、切断) は `receiveTips` と `evmTips` を自動で消す。

### 4.3 見積もり (quote): 送り手にだけアドレスを渡す

- `requestEvmTipQuote {id, to: playerId, token, amount}` (C→S)。条件: 送り手が EVM 検証済み、受取人が自分以外で `receiveTips`、トークンが設定内、金額 (10 進文字列) が正しい。
- サーバーは `evmTipQuote {id, quoteId, chainId, token: {symbol, address, decimals}, recipient: address, units, expiresAt}` を送り手にだけ返す。quote には送り手の検証済みアドレスと受取人アドレスを控え、10 分で失効。
- アドレス収集の対策: quote は検証済みの送り手だけ、ソケットあたりトークンバケット (3 件、10 秒に 1 件回復)、同時に有効な quote はソケットあたり 3 件まで。
- 受取人が受け取りをやめた・切断した・検証を失ったら、その受取人宛ての未使用 quote は無効。

### 4.4 送る側 (クライアント)

1. Sidebar のプレイヤー一覧で `evmTips` のある相手に「Tip」ボタン (または EVM パネルの投げゼニ欄) → トークンと金額を選ぶ → 確認「<相手> に <金額> <トークン> を送ります。送金は取り消せません」。
2. quote を取得 (サーバーが金額も最小単位に変換して返す。クライアントでも同じ解析をして一致を確認)。
3. `eth_chainId` を見て、違えば `wallet_switchEthereumChain`。4902 なら組み込みチェーン (137) に限り `wallet_addEthereumChain` してから再度切替。
4. `eth_sendTransaction {from: 検証済みアドレス, to: token, data: transfer(recipient, units), value: 0x0}`。`data` は自前でエンコード (selector `a9059cbb` + 32 バイトずつ、共通モジュール `evmAbi.js`)。クライアントに viem は入れない。
5. 返った tx ハッシュ (`/^0x[0-9a-fA-F]{64}$/`) を `evmTip {quoteId, txHash}` でサーバーへ。
6. 結果 `evmTipStatus {quoteId, txHash, state, reason?}` を待つ (`confirmed` / `failed` / `unverified`)。送金後はエクスプローラーへのリンクを出す。

### 4.5 サーバーの検証と告知

- `onEvmTip`: quote が送り手のもので未失効・未使用。tx ハッシュ形式。tx ハッシュの既読集合 (上限付き) で一度だけ扱う。quote は使用済みにする。
- 処理中はソケットあたり 2 件まで。全体の同時ポーリング数にも上限 (例 16)。
- ポーリング: 3 秒ごとに `eth_getTransactionReceipt`、最大 3 分。レシートが出たら:
  - `status == 0x1`、`from` が quote の送り手、`to` がトークンのコントラクト。
  - ログのうち `address == token`、`topics[0] == Transfer`、`topics[1] == 送り手`、`topics[2] == 受取人`、`data == units` (BigInt で一致) のものが 1 件以上。
  - `blockNumber <= finalized` になるまで待つ (同じ 3 分の枠内)。
- 確定したら:
  - 全員へチャットのシステムメッセージ「Alice tipped Bob 100 JPYC」(名前は表示名、アドレスは出さない)。告知はワールド全体で 1 秒に 1 件程度に抑える (超過分はまとめず落とさず遅延)。
  - 送り手へ `evmTipStatus {state: 'confirmed'}`、受取人へ同じ内容の通知 (トースト)。
  - サーバースクリプトへ保護イベント `tip` (§4.6)。
- 失敗・時間切れ: 送り手にだけ `evmTipStatus {state: 'failed' | 'unverified', reason}`。
- RPC が無い場合: quote は出す (送金はウォレットで可能) が、`evmTip` には `state: 'unverified', reason: 'no_rpc'` を返し告知しない。

### 4.6 スクリプト向け

- サーバースクリプトの保護イベント `tip`: 凍結された `{ fromPlayerId, toPlayerId, token, amount, units, decimals, chainId, txHash }`。`amount` は 10 進の人間向け文字列、`units` は最小単位の 10 進文字列 (精度を落とさない)。`internalEvents` に登録してスクリプト・ネットワークから偽装できないようにする。
- クライアントスクリプトには配らない。演出したい場合はサーバースクリプトが `app.send` で配る (その内容はスクリプトの責任)。

## 5. P3: NFT 保有判定

### 5.1 判定

- `src/server/evmHoldings.js`: `check(address, spec)` → `{ known, balance }`。
  - spec: `{ chainId, contract, standard: 'erc721' | 'erc1155', tokenId?, minBalance? }`。
  - ERC-721: tokenId なし → `balanceOf(owner)`、あり → `ownerOf(tokenId) == owner` (balance 0/1)。
  - ERC-1155: tokenId 必須 → `balanceOf(owner, id)`。
  - tokenId は 10 進文字列・16 進文字列 (`0x`) を受ける。数値型は安全整数の範囲だけ (OpenPay の tokenId は 256 ビットなので 16 進文字列で渡す)。
  - `latest` ブロックで読む (保有の判定は即時性を優先)。
  - キャッシュ: (chainId, contract, standard, tokenId, address) ごとに 30 秒。失敗は 5 秒の負のキャッシュ。同時実行数の上限と、同じキーの同時要求は 1 本にまとめる。
  - 失敗・revert・形の不正は `known: false` (fail closed)。

### 5.2 スクリプト API (サーバーのみ)

- `player.getEvmHolding(spec)`: Promise<凍結 `{ verified, known, balance, holds }`>。
  - `verified`: そのプレイヤーの接続で EVM アドレスが検証済み。
  - `holds`: `known && balance >= (minBalance ?? 1)`。
  - クライアントスクリプト・未検証・RPC なし・不正な spec は `{ verified, known: false, balance: 0, holds: false }`。不正 spec は 1 回だけ警告。
  - balance は安全整数に丸めた Number。
- サーバースクリプトの保護イベント `evmWallet`: 凍結 `{ playerId, verified }`。検証の成立・消滅で発火し、スクリプトが再判定のきっかけにできる。`internalEvents` に登録。
- クライアントスクリプト向けの判定 API (自分の分だけ問い合わせる) は今回は作らない。判定と配信はサーバースクリプトで行い、結果は `app.sendTo(playerId, ...)` で本人にだけ送る。

### 5.3 ゲート付き app の例

- `docs/scripting/examples/nft-gate.js` (と e2e の fixture): `app.configure` で `chainId` / `contract` / `standard` / `tokenId` / 案内文 / 保有者向けの文言を設定。
  - サーバー側: プレイヤーが近づく (またはアクション) → `getEvmHolding` → 保有者にだけ `app.sendTo` で「開く」と保有者向けの内容を送る。
  - クライアント側: 受け取った本人の画面だけ扉を開く (既存 token-door と同じく、表示は本人の画面だけ。改造クライアントで扉を開けること自体は防げないため、守りたい中身はサーバーから保有者にだけ送る)。
- ビルダーはこの script を app に貼って .hyp として書き出せる。手順を docs に書く。
- OpenPay 対応: `standard: 'erc1155'`、`tokenId` に `keccak256('openpay:license:' + productId)` の 16 進。コントラクトのアドレスは公開後に設定する。(2026-11-10 追記: Polygon の `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` にデプロイ済み。プロキシではなく、`balanceOf` は標準のまま。チェーンでの確認と、これを使うドアは goals/phase7-openpay-nft-door-design.md)

## 6. 互換性

- パケットは末尾追加のみ (`setEvmTipReceive`, `requestEvmTipQuote`, `evmTipQuote`, `evmTip`, `evmTipStatus`, `evmTipNotice`)。`PROTOCOL_VERSION` は 2 のまま。
- `PUBLIC_EVM_TIP_TOKENS` / `EVM_RPC_URL_*` が空なら P1 と同じ挙動。
- スクリプト向けの新 API・イベントは追加のみ。

## 7. セキュリティ

- 告知はオンチェーンの Transfer (検証済み送り手 → オプトインした受取人、金額一致、確定済み) を確認できたものだけ。クライアントの申告は信じない。
- tx ハッシュの再利用は重複集合と「送り手 = 検証済みアドレス」で防ぐ。
- RPC の濫用は、ソケットごと・全体の上限とポーリング期間の上限で抑える。
- 秘密鍵・資金はサーバーに置かない。手数料なし。
- 受取アドレスの公開はオプトインで、検証の消滅とともに消える。

## 8. テスト

- ユニット: evmRpc (タイムアウト、上限、エラー、chainId 不一致)、金額の解析とエンコード、レシート検証 (正常、status 0、送り手違い、受取人違い、金額違い、別トークン、複数ログ、未確定)、投げゼニのハンドラ (権限、重複、上限、RPC なし、受取人の公開と消去、自己変更での偽装不可)、保有判定 (721 / 1155、tokenId 形式、キャッシュ、負のキャッシュ、revert)、スクリプト API (サーバー・クライアント・未検証・凍結)、保護イベント。
- e2e: 偽 RPC サーバー (Node の http) と偽ウォレットで、受け取り公開 → 送金 → 告知、と NFT ゲートの開閉。

## 9. 実装の詳細 (内部調査を反映)

- ABI エンコード/デコードは共通の純関数 `src/core/extras/evmAbi.js` (selector + 32 バイト語、uint256 は BigInt、アドレスは 20 バイト)。viem はサーバーの `viem/utils` / `viem/siwe` 以外を使わない (lockdown)。
- RPC: `src/server/evmRpc.js` は `solanaRpc.js` と同じ作法 (URL を出さない、http/https のみ、`AbortSignal`、`status 200`、本文を上限付きで逐次読み、`TextDecoder` fatal、`jsonrpc`/`id` 検証、`error` は失敗)。グローバル `fetch` を使い fetch guard (Brotli 拒否) を通す。
- 予算: `tokenBalance.js` と同じ形 (期限、同時数、トークンバケット、上限超過は待たずに unknown、注入可能な時計)。保有判定は `createEvmHoldingService`、送金検証は専用のポーラー (同時数・期間の上限)。
- サーバーの検証済みアドレスは `socket.evmWallet.verified` (EIP-55)。スクリプト API はプレイヤー id からソケットを引いてアドレスを得る (スクリプトはアドレスを見ない・渡さない)。
- スクリプト API は `createPlayerProxy.js` に追加し、`callForScript` で包む。結果はホスト側で作った凍結プレーンオブジェクト (Promise はコンパートメントの intrinsic になるよう既存の getTokenBalance と同じ作り)。`getTokenBalance` と同様、app の死・クラッシュ・致命エラー後は解決しない。
- チャット告知は `world.chat.add(msg, true)`。
- Sidebar の `Players` 一覧の行に `.players-btn` を追加 (lucide のアイコン、`player.isRemote && player.data.evmTips && world.evm?.isVerified()` の時)。投げゼニの入力はモーダル (既存 `Confirm` 等の流儀を確認して合わせる)。
- e2e: 偽 RPC (Node の http サーバー) が `eth_chainId` / `eth_getTransactionReceipt` / `eth_getBlockByNumber` / `eth_call` に答える。偽ウォレットは `eth_sendTransaction` を受けて偽 RPC にレシートを登録する。

## 10. レビューしてほしい論点

1. アドレスを配らず「受け取り可」の真偽値だけ配り、quote で送り手にだけアドレスを渡す方式は妥当か。quote によるアドレス収集の対策は十分か。
2. 告知を `finalized` まで待つ判断と、3 分の上限は妥当か。
3. `tip` イベントをサーバースクリプト限定にする判断 (クライアントへはスクリプトが app.send で配る)。
4. P3 のスクリプト API をサーバー限定にする判断。クライアントの判定 API を後回しにしてよいか。
5. 保有判定を `latest` で読む判断 (OpenPay SDK も最新ブロック)。
6. RPC の濫用・増幅の見落とし。
7. 法務上、設計で避けるべき点の見落とし。

## 11. 計画レビューの結果と v2 の決定 (Fable, 2026-11-08)

判定: S / R / P3 は条件付き GO。P2 の検証・告知・`tip` イベントはこのままでは NO-GO。→ P2 を P2a (今回) と P2b (次回) に分割。

### 今回 (P2a / P3 / B1) で取り込むこと
- **B1 名前の偽装**: サーバーは空白だけの名前を受けない (`sanitizePlayerSelfModify` で捨て、接続時は `user.name` → `Anonymous`)。チャット UI はシステムメッセージを `fromId == null` で判定し、`from` が空の利用者メッセージは「Anonymous」と表示する。テストで固定。
- **用語**: quote は「tip intent」(`requestEvmTipIntent` / `evmTipIntent`)。プラットフォームが値付けしている印象を避ける。
- **P2a のサーバー**: intent は保存しない (P2b で quoteId / minBlock と共に導入)。条件は §4.3 に加え、受取人アドレス ≠ 送り手アドレス (同じウォレットの別ソケット)。トークンごとの最小額 (JPYC 1 / USDC 0.01、明示指定は `SYMBOL:addr:decimals[:min]`)。decimals は 0〜18。
- **同意文** (S6): 「この世界で EVM ウォレットを検証した人なら誰でも、投げゼニのためにこのアドレスを取得できます。投げゼニはあなたのウォレットに直接届き、この世界が資金を預かることはありません。受け取りは課税対象になる場合があります。」
- **受け取り状態の消去** (S2): `invalidateEvmWallet` の中で、検証済みだった時に `receiveTips` / `evmTips` を消して配る。スクリプト向け `evmWallet` イベントも同じ場所と検証成功時に出す。切断時はプレイヤーごと消えるので配信不要。
- **Players 一覧の再描画** (S3): `PlayerRemote.modify` / `PlayerLocal.modify` に `evmTips` 分岐と `world.emit('evmTips', …)`。一覧は `evmTips` と `evm:state` を購読。
- **送金前の確認**: `eth_accounts` の先頭が検証済みアドレスと一致しなければ送らない。intent の units とクライアントでの解析結果が一致しなければ送らない。送金先は intent の受取人だけ (テストで固定: 他のアドレスへの transfer を組み立てる経路が無い)。
- **受信上限** (S7): `setEvmTipReceive` 32 B、`requestEvmTipIntent` 192 B。パケットは `setEvmTipReceive` / `requestEvmTipIntent` / `evmTipIntent` の 3 つ (ID 35〜37)。
- **P3 サービス** (S9 / N7): `createTokenBalanceService` を decimals 0 で流用 (キャッシュ 30 秒、負のキャッシュ 5 秒、同時 4、全体バケット 5/秒・バースト 10、`maxEntries` 4096)。キーは正規化 `chainId|contract(小文字)|standard|tokenId(10 進)|owner(小文字)`。`known: false` は「今は分からない (後で再試行)」でありスクリプトは「持っていない」と扱わないよう docs に書く。
- **OpenPay** (N2): §2 の OpenPay の事実は REPORTED (SDK README 由来)。コントラクトの公開までは将来の注記に留める。(2026-11-10 追記: Polygon の `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` にデプロイ済み。プロキシではなく、`balanceOf` は標準のまま。チェーンでの確認と、これを使うドアは goals/phase7-openpay-nft-door-design.md)
- **法務の不変条件** (回答 7): 手数料なし・保管なし・交換なし。運営のアドレスが「代わりに受け取る」経路を作らない。`tip` を有料特典や景品に変える場合は app 作者の販売 (特商法・景表法・賭博に注意) である旨を P2b の docs に書く。USDC の扱いは発行体・チェーンごとに確認が必要。

### P2b (次回) に持ち越す対策
- B2 再提出: intent 発行時の `latest` を `minBlock` として控え `receipt.blockNumber >= minBlock`。既読集合は時間ベース (15 分以上)。
- B3 費用: 全体のトークンバケット、`finalized` の取得はポーリング 1 回につき 1 回を共有、バックオフ (3 → 10 秒)、`eth_getTransactionByHash` が 60 秒 null なら早期に打ち切り、負荷時は `unverified` に落ちる。
- B4 確定: `finalized >= blockNumber` の後にレシートを取り直し `blockHash` を比較。起動時に `finalized` タグを確認し、使えなければ `latest - 128` か P2b 無効。
- B5 チャット: 最小額、送り手ごとの告知クールダウン (30 秒)、告知キューの上限 (20)。
- S1 受取人・送り手の途中離脱、S4 `receipt.to` の照合をやめる (EIP-7702)、S5 fee-on-transfer の扱い、S8 `unverified` 後の 1 回の再提出、S7 `evmTipStatus` は送り手にだけ。

## 12. 実装記録 (2026-11-08)

- S: `solana-integration.js` の `run.verifySent`。回帰テストは `test/solanaClient.test.js`。
- B1: `sanitizeName` は 1 文字ずつ `/^[\s\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\u2800]$/u` で不可視文字を判定し、全部が不可視なら受けない (§13 の 5)。接続時は `sanitizeName(user.name) || 'Anonymous'`。チャットは `fromId == null` をシステムメッセージとして扱う。
- R: `src/server/evmRpc.js` (`createEvmRpc` / `createEvmRpcs`)。初回呼び出しで `eth_chainId` を確認し、不一致は恒久的に無効、確認失敗は 60 秒後に再試行。
- P2a:
  - 共通: `src/core/extras/evmAbi.js` (エンコード/デコード、金額、tokenId)、`src/core/extras/evmTokens.js` (トークン表、`parseTipTokens`、`parseTipAmount`、Polygon のチェーン情報)。
  - サーバー: `onSetEvmTipReceive` (受け取りの開始だけ 1 秒に 1 回、やめるのは即時)、`onRequestEvmTipIntent` (3 件 + 10 秒に 1 件、理由は固定語彙)、`invalidateEvmWallet` での消去と `evmWallet` イベント。パケット 35〜37。
  - クライアント: `world.evm.tip()` / `setReceiveTips()` / `getTipTokens()`、`TipForm.js`、Players 一覧の Tip ボタン、EVM パネルの受け取りスイッチ。
- P3: `src/server/evmHoldings.js`、`ServerNetwork.evmHolding`、`player.getEvmHolding`、`docs/scripting/examples/nft-gate.js`、docs。
- P2b の下準備: `src/server/evmTipVerify.js` (レシート照合の純関数、単体テストのみ。§11 の S4 に従い P2b で `receipt.to` の照合を外す)。
- テスト: 新規 `evmAbi` / `evmRpc` / `evmTips` / `evmHoldings` / `evmHoldingScript` / `walletButton` ほか既存の更新、e2e `evm-tips-gate.mjs`。

## 13. コードレビュー 2 と最終監査 (2026-11-08)

Codex (GPT-6 Astra, xhigh) の指摘 7 件 (Major 2 / Minor 5) をすべて直し、修正差分の確認で 7 件とも FIXED、リグレッションなし。

1. Major: 例の「保有者だけの秘密」prop は blueprint で全員に配られる → prop を `welcome` にし、公開であることを例のヘッダー・設定ラベル・Player.md・README に明記。本当に限定したい内容はサーバースクリプトが自前のサーバーから取り、確認後に `app.sendTo` で送る。
2. Major: tx がチェーンに結び付いていない → `eth_sendTransaction` に `chainId` (16 進) を入れ、送信中の `chainChanged` は目的のチェーン以外への変更だけを数える。送信中に変わったら `{ ok: true, explorerUrl: null, warning: 'chain_changed' }` で、TipForm が注意を出す。
3. Minor: 受け取りの取り消しが 1 秒の間引きで捨てられる → 間引くのは開始だけ。
4. Minor: `run.verifySent` が送信成功前に立つ → `requestBuilderByToken` を送れた後に立てる。
5. Minor: U+FE0F / U+E0061 だけの名前が通る → Unicode プロパティで判定。
6. Minor: 例で読み取り中のウォレット変更が再確認されない → プレイヤーごとに 1 件、読み取り中の要求は後でやり直し、最新の答えだけ送る。
7. Minor: Tip が `div role=button` でキーボード不可 → 本物の `<button>`。キー操作はワールドに渡さない。e2e でフォーカス + Enter で開き、チャットが開かないことを確認。

最終監査 (メインセッション) で 1 件追加: 送金中に相手が受け取りをやめると送り手のフォームが消え、送信済みの結果とリンクが見えなくなっていた → 開いたフォームは残し、次の送金はサーバーの tip intent が `recipient_unavailable` で断る (e2e に追加)。関係のない整形差分 (`entityModifyPolicy.js` の prettier) は戻した。

結果: ユニット 1274/1274、lint エラー 0、e2e は evm-tips-gate 6/6、evm-wallet 8/8、token-gate 10/10、fullstack 62/62。
