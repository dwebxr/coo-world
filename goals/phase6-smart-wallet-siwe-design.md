# Phase 6: スマートコントラクト型ウォレットのサインイン (EIP-1271 / EIP-6492) と JPYC 向けウォレットのボタン

2026-11-08。ユーザーの依頼:「スマホのボタンを Trust Wallet・Rainbow ではなく、JPYC 向けの Myna Wallet・HashPort Wallet に」。

Myna Wallet はスマートコントラクト型のアカウントなので、今の EOA 専用の検証では「Signature not accepted」になる。そのため、サーバーの検証も対応させる。

「その他のウォレット」の一覧 (Reown のウォレット一覧 API を使う画面) は見送った。負担に見合わないと判断した。

## 1. 調べたこと

### Reown のウォレット一覧 API

2026-11-08 に、本番のプロジェクト ID で `explorer-api.walletconnect.com/v3/wallets` に問い合わせた。

| ウォレット | 一覧の ID | universal | native | 対応 |
|---|---|---|---|---|
| HashPort Wallet | 38633830ef578a1249c345848a8d6487551a346b923d21ce197ea57f423f3113 | `https://link.wallet.hashport.com` | `expo2025-wallet://` | `sign_v2`、`eip155:137` |
| MynaWallet | e3d6117850435b1359b81d7cef869f6851c00ad2125cadb04f4e003be8074af6 | `https://prd-api.mynawallet.jp/deeplink` | `mynawallet://` | `sign_v2`、`eip155:137` |

### アカウントの種類 (公開資料から)

- **Myna Wallet:** Account Abstraction (ERC-4337) のアカウントで、操作はパスキー、復旧はマイナンバーカード。
  - personal_sign の署名は、デプロイ済みなら EIP-1271、未デプロイなら EIP-6492 で包んだものになる見込み。これは推測で、資料には書かれていない。
- **HashPort Wallet:** 復元フレーズの取り込みに対応しているので、EOA の見込み。資料で確認はできていない。

### リンクの形式

AppKit (`formatUniversalUrl`) と同じく、`<universal>/wc?uri=<encodeURIComponent(wc: URI)>` にする。

この 2 つで実際に開くかは、実機で確かめる。

**2026-11-09 実機の結果と変更:**
- Myna Wallet: 開いた。接続と署名まで通った。
- HashPort Wallet: App Store のページを経てアプリが開いたが、接続の要求は出なかった。
  - `link.wallet.hashport.com/wc?uri=` は、アプリに渡らないと App Store へ 301 で移り、そこで wc: URI が失われる。
  - AASA は `*` を宣言していて、Apple の CDN にも載っているが、アプリには渡らなかった。
- 変更: HashPort だけ、AppKit がスマホで使う `mobile_link` のスキームで開く (`expo2025-wallet://wc?uri=…`)。
  - Reown のレジストリと api.web3modal.org の値。universal の方は AppKit では Link Mode 専用 (`link_mode`)。
  - アプリが無いと Safari は「開けない」と出る (ストアへは飛ばない)。パネルの「Install the wallet app first」でカバーする。
- 「Open wallet」もスキームを優先する。接続済みならアプリは入っている。
  - Myna の AASA は `/deeplink/*` だけなので、ベースの `…/deeplink` はアプリに渡らない。
  - 順序: ウォレット自身の `redirect.native` → タップしたウォレットのスキーム → ウォレット自身の `redirect.universal`。
  - アプリ用スキームのリンクは同じタブで開く。新しいタブで開くと空のタブが残るため。
  - 「Copy link」と「Show QR」を押したら、タップしたウォレットの記憶を消す。別のウォレットが受けるかもしれないため。

## 2. ボタン (src/core/extras/walletLinks.js)

- `WALLET_LINKS` を MetaMask、HashPort Wallet、Myna Wallet にする。id は `metamask` / `hashport` / `myna`。
- 下の説明文を変える。MetaMask の app.link は未インストールならストアへ案内するが、他の 2 つは分からない。
  - 新しい文: 「Install the wallet app first if you do not have it.」
- README と CHANGELOG に書く。

## 3. サーバーの署名検証 (src/server/evm-gating.js)

### 流れ (`checkEvmChallenge`)

1. 今の形式チェック (nonce、期限、アドレス) をする。署名は、新しい上限の範囲の 16 進文字列であること。
2. 署名が 65 バイトで、`verifyMessage` (ecrecover) が一致したら `ok`。RPC は使わない。今と同じ。
3. それ以外のとき:
   - サインインチェーンの RPC (`EVM_RPC_URL_<chainId>`) がなければ、`contract_unsupported` を返す。
   - RPC があれば、**ERC-6492 の汎用検証器を、デプロイせずに `eth_call` で動かす** (deployless)。
     - `data` は、検証器のバイトコードに `abi.encode(address signer, bytes32 hash, bytes signature)` をつなげたもの。
     - `hash` は、保存した SIWE の文字列の EIP-191 ハッシュ (`hashMessage`)。
     - `'latest'` のブロックに対して呼ぶ。
4. 結果:
   - `0x01` なら `ok`。
   - `0x00`、またはノードの JSON-RPC エラー (revert を含む) なら `signature_invalid`。
   - 通信の失敗、時間切れ、上限超えなら `unavailable`。

### 検証器

EIP-6492 の参照実装 (ValidateSigOffchain) で、viem 2.57.8 の `erc6492SignatureValidatorByteCode` と同じもの。

- 1 回の呼び出しで次を扱える。
  - デプロイ済みのコントラクト: `isValidSignature(hash, sig) == 0x1626ba7e` (EIP-1271)。
  - 未デプロイ (6492 で包んだ署名): factory を呼んでから EIP-1271 で確かめる。
  - EOA: 中で ecrecover する。
- サーバーは SES の lockdown 下で viem のルートを読み込めないので、定数を `src/server/erc6492.js` に写す。
  - テスト (lockdown なしのプロセス) で、viem のルートが出している値と一致することを確かめる。
  - 同じ入力に対して、viem の `verifyHash` が作る `eth_call` の `data` と一致することも確かめる (偽の transport で捕まえる)。
- 扱わないもの:
  - ERC-8010 (EIP-7702 の初期化つき署名)。
  - 7702 で委任した EOA は普通の ECDSA で署名するので、手順 2 で通る。

### 上限と時間

- **署名の長さ:** 0x 付きの 16 進文字列で、1〜4096 バイト (`MAX_EVM_SIGNATURE_BYTES`)。
  - WebAuthn の署名を 6492 で包むと 1〜2 KB になる。
  - `isEvmSignature` (65 バイト) はそのまま残し、サインイン用に `isEvmSigninSignature` を足す。クライアントの事前チェックも、こちらに替える。
- **パケットの上限:** `requestEvmVerify` の受信上限を 512 から 8704 バイトにする。
  - 署名は最大 8194 文字。msgpack の str32 の見出しと、他のキー (約 200 バイト) を足した値。
  - INBOUND の他の値は変えない。
- **RPC の時間:** 8 秒 (`AbortSignal.timeout`)。クライアントの ack 待ちは 15 秒。
- **予算 (サーバー全体):**
  - 同時に 4 件まで。
  - 1 分に 30 件まで (トークンバケット)。
  - 超えたら `unavailable`。
  - ソケットごとには、すでに 1 件ずつしか来ない。nonce を使い切ってから await するのと、nonce の発行にクールダウンがあるため。
- **ログ:** アドレスと署名は出さない。失敗の種類ごとに一度だけ数を出す (logOnce)。

### 理由の語彙

- `EVM_STATUS_REASONS` に `contract_unsupported` と `unavailable` を足す。
- `publicReason` でこの 2 つも通す。
- クライアントの文言 (`failureMessage`):
  - `contract_unsupported`: 「Signature not accepted. Smart-contract wallets are not supported in this world.」
  - `unavailable`: 「Could not check the wallet's signature right now. Please try again.」
  - `signature_invalid`: 「Signature not accepted. Please sign again.」
    - WalletConnect 用の「Smart-contract wallets are not supported yet.」は消す。サーバーが判断できるようになったため。

## 4. 影響と制限

- **検証できるアドレス:** スマートアカウントのアドレスで検証できるようになる。
  - NFT の確認 (`player.getEvmHolding`) は、そのアドレスの保有を見る。
  - 投げゼニの受け取りは、ERC-20 の送り先として普通に使える。
- **AA ウォレットからの送金:** WalletConnect の `eth_sendTransaction` が、UserOperation のハッシュを返すウォレットがある。その場合、確認は `unverified` になる。
  - 本番では投げゼニがまだ無効なので、制限として README に書くだけにする。
- **eth_call の負荷:** `eth_call` は、攻撃者の factory の呼び出しも含めて、ノードの中だけで動く。状態は変わらない。
  - 負荷は、予算と nonce のクールダウンで抑える。
  - ガスの上限はノードの既定に任せる。

## 5. テスト

- **ユニット (test/evmGating.test.js ほか):**
  - EOA は RPC を使わない。
  - コントラクトの経路: `eth_call` の形 (`to` なし、`'latest'`)、`0x01` / `0x00` / RpcError / 通信失敗 / 時間切れ / 予算超え。
  - RPC がないときは `contract_unsupported`。
  - 署名の長さの境界。
  - 写した定数が viem と一致すること。`data` が viem の verifyHash と一致すること。
  - lockdown 下で読み込めること。
- **クライアント (test/evmClient.test.js):**
  - 長い署名を通す。
  - 新しい理由の文言。
- **e2e:**
  - evm-wallet: 上限超えのパケットのテストを、新しい上限 (8704) を超える大きさにする。
  - evm-tips-gate: 偽の RPC で、スマートアカウントのサインインを wire で通す。`eth_call` が検証器の `data` なら `0x01` を返す。
- **シート (test/walletConnectSheet.test.js):** 新しいボタンの href。

## 6. 計画レビューで見てほしい点

1. 毎回、deployless の汎用検証器で確かめる方法でよいか。代わりに `eth_getCode` を先に呼んで、`isValidSignature` を直接呼ぶ方法もある。
2. 上限の値 (4096 バイトと 8704 バイト) と予算 (4 件同時、1 分 30 件) は妥当か。
3. 理由の語彙を足すこと (プロトコルの互換)。
4. 写した定数をテストで固定する作り。
5. `'latest'` のブロックを使ってよいか。`finalized` でなくて大丈夫か。

## 7. 計画レビュー (Fable, 2026-11-08) の結果: 必須の変更を入れれば GO

### 必須 (すべて取り込んだ)

1. **RPC のエラーを code で分ける。** 検証器の revert (3 / -32000 / -32015) だけを `signature_invalid` にする。
   - それ以外の RpcError (レート制限 -32005、`to` のない `eth_call` を拒む -32602 など) は `rpc_error` にして、logOnce を出す。
   - `evmRpc` のチェーン確認 (`eth_chainId`) で JSON-RPC エラーが返ったときは、RpcError ではなく普通の Error (「RPC chain unknown」) にする。呼び出したメソッドの拒否と取り違えないため。
2. **検証器の渡し方。** `createEvmSignatureVerifier({ rpc })` を `ServerNetwork.init()` で作り、`checkEvmChallenge` の 4 番目の引数 `{ verifyContract }` で渡す。
   - 予算はこの部品の中に持つ。
   - テストでは差し替えられる。
3. **`checkEvmChallenge` は reject しない。** 時間切れはタイマーの signal で扱い、`finally` で予算の枠を返す。
4. **結果の解釈を厳しくする。** `0x01` と `0x00` 以外の形は `rpc_unexpected` にする。利用者に返す理由は `unavailable`。
5. **パケット上限のテストを直す。** 最大の正しいパケットが通ることと、4096 バイトを超える署名が落ちることを確かめる。
6. **内部の理由を分ける。** `rpc_busy` / `rpc_timeout` / `rpc_error` / `rpc_unexpected` に分け、`publicReason` で `unavailable` にまとめる。
7. **写した定数を viem とは別にも固定する。** keccak256 でも固め、出典 (Ambire の signature-validator) を書く。

### 推奨 (取り込んだもの)

- **gas:** `eth_call` に 1000 万を付ける。
- **RPC がないとき:** 65 バイトの失敗は `signature_invalid`、それ以外は `contract_unsupported` にする。
- **予算:** 毎秒 0.5 件、最大 10 件まで貯まり、同時に 4 件まで。超えたら待たせずに断る。
- **ログ:** アドレス・署名・呼び出しデータ・ノードのメッセージは出さない。
- **README:** Myna Wallet の前提と、AA ウォレットからの投げゼニの制限を書く。
- **e2e の偽 RPC:** valid / revert / -32005 の 3 通りを確かめる。
- **ユニットテスト:** 予算、時間切れの後の枠、Safe 1-of-1 (65 バイトのコントラクト署名)、ロックダウン下で動くこと、クライアントの事前チェック。

### 制限 (文書に残す)

- 予算はサーバー全体で 1 つなので、大量の不正な署名で、正しいスマートウォレットの利用者が待たされることがある。
  - ソケットごとの nonce のクールダウンと接続の上限で抑えられているので、今は受け入れる。

## 8. コードレビュー (Codex) を受けた変更と、本物のチェーンでの確認

### 変更

- **P1 コントラクトのアカウントは、サインインのチェーンでだけ検証済みにする。** `state.verifiedContract` を持つ。他のチェーンの `player.getEvmHolding` には `verified: false` を返す。
  - Safe のように、同じアドレスでもチェーンごとに持ち主が違うことがあるため。
  - EOA は、どのチェーンでも同じ鍵なので、今までどおり。
- **P2 ゼロアドレスではサインインさせない。** 検証器の ecrecover は、復元できない署名に対してゼロアドレスを返すため。
  - nonce も出さない。`checkEvmChallenge` でも `bad_wallet` にする。
- **P2 32 バイト未満の署名は、アカウントの `isValidSignature` を直接 `eth_call` で呼ぶ。** 検証器は末尾の 32 バイトを読むので、短い署名は必ず revert してしまうため。
  - magic の 32 バイト語なら `ok`。それ以外の 32 バイト語か空の答えなら `signature_invalid`。
- **P2 revert の判定を、code だけでなく RpcError の `reverted` (真偽値) で行う。**
  - `reverted` は、code が 3 か、メッセージか data に "revert" を含むときに立つ。
  - -32000 でも revert でなければ (例: missing trie node)、`unavailable` にしてログを出す。
  - ノードのメッセージそのものは持たない。

### 本物の Polygon ノードでの確認 (2026-11-08、公開ノード、読み取りだけの eth_call)

| 入力 | 答え | サーバーの扱い |
|---|---|---|
| 新しい EOA と正しい署名 | `0x01` | `ok` (実際には、ローカルの ecrecover で先に通る) |
| 新しい EOA と別の鍵の署名 | `0x00` | `signature_invalid` |
| ゼロアドレスとゼロの署名 | `0x01` | 呼ぶ前に `bad_wallet` (上の P2) |
| EOA への短い署名の直接呼び出し | `0x` | `signature_invalid` |
| ウォレットでないコントラクト (JPYC) | `error 3: execution reverted` | `signature_invalid` |
| よく知られたテスト鍵 (0x11…11) のアドレスと正しい署名 | `error 3` | ローカルの ecrecover で `ok` |

最後の行のアドレスには、Polygon で EIP-7702 の委任コード (`0xef0100…`) が入っていた。検証器は委任先の `isValidSignature` を呼ぶので revert する。ローカルで ecrecover を先に試すので、こうした EOA も自分の鍵でサインインできる。
