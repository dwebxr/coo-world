# Phase 7: OpenPay の利用許諾 NFT で開くドア (nft_gate.hyp)

2026-11-10。ユーザーの依頼:「OpenPay の NFT コントラクトが公開されたら、ゲートをそれに合わせて設定する」「nft_gate.hyp のソースを差し替えて動くように」。

ユーザーの nft_gate.hyp は、本番ワールドの「TOKEN GATE COO」を書き出したもの (元の名前は token-gate-coo.hyp)。

- 今の判定は Solana の COO トークン (10,000 以上) で、クライアントのスクリプトが `world.getPlayer().getTokenBalance()` を読んでドアを開ける。
- これを、OpenPay の利用許諾 NFT「Coo-World NFT Gate」を持っている人に開くドアへ差し替える。
- 見た目と動き (ドアのモデル、スライドとスイングの切り替え、3 秒で閉まる) はそのまま残す。

## 1. 調べたこと

ラベルの意味: VERIFIED はチェーンを読んだか、公開されたソースを読んだもの。REPORTED は文書に書いてあるもの。

### コントラクト (Grok 4.7、公開ノードでの読み取りだけの eth_call と公開資料、2026-11-10)

- **VERIFIED: コントラクトの形。**
  - Polygon (137) の `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc`。
  - プロキシではない (EIP-1967 の実装スロットと管理者スロットは 0)。solc 0.8.28 でコンパイルされている。
  - supportsInterface は ERC-165 / ERC-1155 / ERC-1155 metadata URI のすべてで true。
- **VERIFIED: 登録 tx の中身。** tx `0xa869bd39…b038` は、block 97016433 で `registerLicense(id, 30, true, uri, definitionHash)` を呼んで成功した。ログは `URI` と `LicenseRegistered` で、どちらも同じ id を出している。
- **VERIFIED: tokenId の求め方。**
  - tokenId は `0x44ed4cd2617180c45b9c6e4c1043502f00094cd474effa009b2b84141ac4a171` で、`keccak256(utf8('openpay:license:h_dc83087ae6050a26540f963151de4c1f'))` と一致した。
  - 次の 3 つで同じ値になることを確かめた。
    - 登録ログ
    - オンチェーンの `computeTokenId(string)`
    - 手元の viem での計算
  - `h_` を外すなど別の綴りでは一致しない。
- **VERIFIED: この id の今の状態 (`licenseOf(id)`)。** maxSupply 30、minted 0、transferable true、exists true。
  - `uri(id)` は `https://open-pay.jp/api/license/metadata/h_dc83087ae6050a26540f963151de4c1f` を返す (名前は「Coo-World NFT Gate」)。
- **VERIFIED by URL: `balanceOf` の挙動。** ソースは github.com/cipherwebllc/openpay の `OpenPayLicense1155.sol` で、デプロイ済みのものと挙動が一致する。
  - `balanceOf` は ERC-1155 の標準のまま。期限、停止、ブロックリスト、公開フラグは見ない。
  - 譲渡できない設定は商品ごとにあるが、この商品は譲渡できる。
  - 運営者が強制的に焼却する手段はない。
- **VERIFIED by URL: SDK の `hasLicense`。** `openpay-x402-sdk@0.11.0` の `hasLicense` は、最新ブロックで `balanceOf(account, id) > 0` を見る。
- **ストアの公開状態。** 「未公開」は OpenPay の HTTP API の `saleActive: false` のことで、チェーンの判定とは関係ない。
- **購入ページ。** `https://open-pay.jp/@coo?product=h_dc83087ae6050a26540f963151de4c1f`。メタデータの `external_url` と、API の商品 URL が同じ値。

### リポジトリ (Sonnet, Haiku)

- **使える API。**
  - サーバーのスクリプトから `player.getEvmHolding({ chainId, contract, standard, tokenId, minBalance })` が使える。ERC-1155 と 256 ビットの 16 進 tokenId に対応している。
  - クライアントのスクリプトから呼ぶと、常に「不明」が返る。
- **キャッシュ。** 結果は 30 秒、失敗は 5 秒キャッシュされる。
- **許可リストはない。** コントラクトを絞る仕組みはなく、チェーンは `PUBLIC_EVM_CHAIN_IDS` で決まる。本番は 137 と `EVM_RPC_URL_137` が設定済み。
- **スクリプトでは keccak を計算できない。** 使える組み込みに keccak がないので、tokenId は計算済みの 16 進で持つ。
- **既存の例。** `docs/scripting/examples/nft-gate.js` は汎用の例で、紫の板を消す作り。サーバー側の書き方 (`asked`、`running`、`evmWallet` で再判定) はそのまま使える。
- **e2e の前例。**
  - `test/e2e/evm-tips-gate.mjs` は、その例を `installAsset` で入れ、偽の RPC で保有者と非保有者を確かめている。
  - `test/e2e/token-gate.mjs` と `test/e2e/apps/token-door.js` は、元のドアと同じスクリプトを Solana で確かめている。
  - token-door.js はモデルの代わりに、`Frame`、`LeftDoor`、`RightDoor` を prim で作る。
- **.hyp の形式 (src/core/extras/appTools.js)。**
  - 先頭 4 バイトはヘッダーの長さで、リトルエンディアン。そのあとにヘッダーの JSON (`{ blueprint, assets }`) と、ファイルの本体が順に続く。
  - サーバーは受け取ったファイルを `sha256.ext` の名前で保存する。そのため、`asset://` の名前は中身の SHA-256 と一致していなければならない。元の nft_gate.hyp は 2 つとも一致している。

### 元の nft_gate.hyp

- blueprint は name `TOKEN GATE COO`、author `coo`、desc `REQUIRES SOLANA MOD`、`unique: true`。
- モデルは `bf9043…bb27.glb` (394,684 バイト)。中のノードは次の 3 つ。
  - `Frame` (static rigidbody)
  - `LeftDoor` と `RightDoor` (kinematic rigidbody)。それぞれ幅は約 1.5 m で、collider がある。
- スクリプトは `f364c2…c551.js` (7,555 バイト)。中身は test/e2e/apps/token-door.js のゲート部分と同じ。
- props は Solana の設定 (`network`、`tokenMintMainnet` など) とドアの設定 (`type` "1"、`direction` "1"、`slideDistance` "1")。

## 2. 作るもの

1. **`docs/scripting/examples/nft-door.js`。** OpenPay の利用許諾 NFT で開くドアのスクリプト。nft_gate.hyp にそのまま入れる。
2. **新しい nft_gate.hyp。** 元の .hyp を土台にして、次のように直す。
   - モデルはそのまま残す。
   - スクリプトを 1. に差し替え、SHA-256 の名前を付け直す。
   - props を OpenPay 用に置き換え、Solana の props は消す。
   - name は `NFT GATE COO` に、desc は `Opens for holders of the OpenPay license NFT (Polygon). Needs an EVM wallet.` にする。
   - リポジトリには入れない。ユーザーの作品で、モデルも大きいため。
3. **文書。**
   - Player.md、README、nft-gate.js の注記に、OpenPay のコントラクトのアドレスとドアの例を書く。
   - phase2 と phase3 の設計書の「デプロイ待ち」に、日付つきで追記する。
4. **テスト。**
   - ユニット (test/nftDoorExample.test.js)。
   - e2e (test/e2e/evm-tips-gate.mjs にドアの 3 ステップ)。

開く条件は NFT だけにする。2026-11-10 にユーザーに確認した (「NFT だけ」)。Solana の COO の判定は外す。

サーバーのコードは変えない。本番の設定もそのままで動く (`PUBLIC_EVM_CHAIN_IDS = '137'` と `EVM_RPC_URL_137`)。

## 3. スクリプトの設計 (nft-door.js)

### 設定 (`app.configure`)

| key | 種類 | initial | 用途 |
|---|---|---|---|
| `chainId` | number | 137 | |
| `contract` | text | `0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc` | |
| `tokenId` | text | `0x44ed…a171` | OpenPay の商品 `h_dc83…1f` |
| `minBalance` | number | 1 | |
| `passName` | text | `Coo-World NFT Gate` | 看板に出す名前 |
| `storeUrl` | text | 購入ページの URL | 持っていない人への案内。空なら案内しない |
| `type` / `slideDistance` / `maxRotation` / `direction` | 元のまま | `'1'` / `'1.8'` / `'45'` / `'2'` | ドア |

- `standard` は固定で `erc1155`。OpenPay の利用許諾 NFT 専用なので、設定から外す。
- 元のスクリプトの `defaultValue` は、src のどこからも読まれていなかった。
  - `initial` に書き換えた値は、元のスクリプトで値が未設定のときの扱い (`|| 1.8`、`|| 45`、`direction` が `'1'` でなければ外開き) と同じ。動きは変わらない。
- `initial` が入るのは、props が `undefined` のときだけ (Apps.js の configure)。

### サーバー (`world.isServer`)

nft-gate.js のやり方をそのまま使い、要求の中身を答えに付けて返す (§8 の Codex の指摘で、今の形にした)。

- `nft-door:check` で受けた `{ run, nonce, open }` を、そのプレイヤーの最新の要求として覚える。
  - `run` は 32 文字までの文字列で、それ以外は `''`。
  - `nonce` は正の安全な整数で、それ以外は 0。
  - `open` は `true` のときだけ真。
- そのうえでプレイヤーを `asked` に入れ、判定する。
- 判定はプレイヤーごとに 1 本だけ走らせる。途中で来た要求は、終わってからもう一度読む。送るのは最新の答えだけ。
- 答えは `app.sendTo(playerId, 'nft-door:result', { verified, known, holds, run, nonce, open })`。`run`、`nonce`、`open` は、送る時点で覚えている最新の要求のもの。
- `evmWallet` イベントでは、覚えている要求の `open` を `false` にしてから、`asked` のプレイヤーを読み直して送る。
  - ウォレットが変わったのはボタンを押したのとは違う。なので、答えを待っている Open は状態の答えになる。
  - 読み取りの途中でウォレットが変わったら、その回の答えは捨てて読み直す。
- `leave` で `asked` と要求を消す。
- `contract` と `tokenId` は前後の空白を落とす。
- 設定が不完全なとき (コントラクトや tokenId が空) は `known: false` になる。`getEvmHolding` の型の確認は通ってしまうので、警告は出ない。

### クライアント (`world.isClient`)

モデルの `Frame`、`LeftDoor`、`RightDoor` と、開閉の計算は元のまま使う。

- **`run`。** スクリプトが動くたびに `uuid()` で作る。
  - 違う `run` の答えは、設定やスクリプトが変わる前の古い答えなので、すべて捨てる。
  - 送った覚えのない番号 (今の `nonce` より大きい、または 1 未満) の答えも捨てる。
- **要求には番号を付ける** (`nonce`、1 から)。`answered` は答えをもらった最大の番号。
- **`status`。** 最新の答えを `status` に持つ。Open の途中でなければ、看板とパネルはいつも `status` から描く。扉が閉じたときも `status` に戻す。
- **読み込み時。** 状態を表示するために `nft-door:check` を送る。
  - 検証済みのウォレットがない人には、サーバーは RPC を使わずに返す。
  - 15 秒たっても答えがなければ、表示は変えずに 1 回だけ送り直す。それでも答えがなければ `Pass: unknown` を出す。
  - 送り直すのは、.hyp をドロップした本人の画面のため。その画面では、サーバーにアプリが届く前にスクリプトが動き、最初の要求が失われる (2026-11-10 の手元の確認で再現した)。
- **「Open」アクション。**
  - 押した要求の番号を `openNonce` に覚えて、`open: true` で送る。
  - 扉が動いているあいだや、答えを待っているあいだは、押しても無視する。
  - 扉が開いているときに押しても、もう一度判定して、許されたときだけ開いている時間を延ばす。元のスクリプトと同じく、判定してから延ばす。
  - 閉じている途中で許可が届いたら、その位置から開け直す。
  - 扉を開けるのは、番号が `openNonce` とちょうど一致し、サーバーが `open: true` を付けた答えだけ。
  - Open の途中で古い番号の答えが来たら、`status` は更新するが、看板は `CHECKING…` のまま。
  - 15 秒で答えがなければ `TRY AGAIN` にして、`openNonce` を解く。遅れて来た答えは表示だけになる。
    - 答えを受けた時点でも時間切れを確かめる。ネットワークのイベントは、アプリの update より先に処理されるため (ClientNetwork)。
    - 長く止まっていた画面が再開したとき、update が時間切れにするより先に届いた古い許可でも、扉は開かない。
  - 15 秒にした理由: サーバーは 1 回の読み取りを 10 秒であきらめて自分で「不明」を返す (tokenBalance.js、`2 * deadlineMs`)。それより長くしておく。
  - 時間は `Date.now()` (スクリプトに渡される時計) で測る。フレームの `dt` を足し合わせると遅れる。
    - ワールドは 1 フレームを 1/30 秒で頭打ちにする (World.js `maxDeltaTime`)。
    - そのため、遅い端末ではフレームの時間が実時間より遅れる。
    - ソフトウェア描画の手元の確認で、60 秒たっても送り直しが起きないことがあり、これで見つかった。
    - 扉の動きは元のまま `dt` で進める。
- **`app.send` が `false` を返したとき。** その場で `TRY AGAIN` にし、待ちにしない。
- **答えを受けたとき:**

| 答え | 看板 | 補足の行 | パネル | ドア |
|---|---|---|---|---|
| `verified: false` | `CONNECT EVM WALLET` | `Wallet button (upper right) → EVM → sign in` | `EVM wallet not connected` | 開けない (開いていれば時間で閉じる) |
| `known: false` | `TRY AGAIN` | | `Pass: unknown` | 閉じたまま |
| `holds: false` | `NFT PASS REQUIRED` (赤) | `Get the pass: open-pay.jp/@coo` | `No pass · Get it here` (押すと購入ページ) | 閉じたまま |
| `holds: true`、自分の Open の答えで `open: true` | `ACCESS GRANTED` (緑) | | `Pass: held` | 開く (開いていれば 3 秒延ばす) |
| `holds: true`、それ以外 | `PASS VERIFIED` (緑) | `Open the door` | `Pass: held` | 変えない |

  - `storeUrl` が空なら、補足の行は `passName`、パネルは `Pass: not held` で、リンクにしない。

- **購入ページへのリンク。**
  - 2 つ目のアクションはやめた。Fable の指摘で、アクションはプレイヤーに一番近いものが 1 つだけ出るので、Open と取り合うため。
  - 代わりに右のパネル (`nft-door-pass-panel`) を、持っていない答えのときだけ押せるようにする (`onPointerDown`、`cursor: 'pointer'`)。
  - 押すと `world.open(storeUrl, true)` で新しいタブが開く。`false` にするとワールドのタブが移動して、接続が切れてしまう。
  - ポップアップが止められる人のために、看板にも `open-pay.jp/@coo` を出す。

### 秘密について

設定とスクリプトは、訪問者の全員に送られる。ドアが開くのはその人の画面だけで、改造したクライアントなら自分で開けられる。これは元のドアと nft-gate.js と同じ前提なので、例の先頭に書いた。

## 4. .hyp の作り直し

一回限りの node のスクリプトで作る。置き場所は scratchpad で、リポジトリには入れない。

1. 元の .hyp を読み、ヘッダーとファイルに分ける。元のファイル名が中身の SHA-256 と一致することも確かめる。
2. スクリプトを nft-door.js のバイト列に替え、そのバイト列の `sha256` から `asset://<hash>.js` を作る。
   - blueprint.script と assets の両方を書き換える。
   - サイズはバイト数。スクリプトには `…` や `→` が入るので、文字数ではずれる。
   - mime は元の `text/javascript` のまま。
3. blueprint を直す。
   - name、desc を替える。
   - props は、ドアの値 (元の `type`、`slideDistance`、`direction`) と、OpenPay の 6 つの値にする。
   - `image: null`、`url: null`、真偽値のフラグ、`unique: true`、`id`、`version` は元のまま。
4. 書き出したら、エンジンの `importApp` で読み直して確かめる。
   - 中身がバイト単位で一致すること。
   - 2 つのファイル名が中身の SHA-256 と一致すること。
   - モデルが変わっていないこと。

## 5. 影響と制限

- **ドアの開閉は見た目だけ。** 開くのはその人の画面だけで、ほかの人には閉じたまま見える。元のドアと同じ。
- **今は誰も通れない。** 発行は 0 で、ストアは未公開。公開して 1 枚買うまで、誰がチェックしても `NFT PASS REQUIRED` になる。
- **買ってすぐは反映されないことがある。** 結果は 30 秒キャッシュされるので、最大 30 秒は「持っていない」のまま。
- **NFT はウォレットに届いている必要がある。**
  - OpenPay は、購入の権利が先にでき、NFT の発行が後から来ることがある。ゲートが見るのは NFT だけ。
  - 支払いに使ったウォレットと、ワールドでサインインしたウォレットが違えば通れない。
  - Myna Wallet (AA) で買ったときは、AA のアドレスに届く。そのアドレスでサインインしていれば通れる。
    - 前提は、`PUBLIC_EVM_CHAIN_IDS` の先頭が 137 であること。本番は `'137'` だけ。
- **NFT は譲渡できる。** 譲渡すれば、30 秒のキャッシュが切れたあと通れなくなる。
- **Solana の COO の判定はなくなる。** ユーザーが 2026-11-10 に選んだ。
- **RPC の予算。**
  - 未検証の人は RPC を使わない。
  - 検証済みの人は、(spec, アドレス) ごとに 30 秒に 1 回まで。
  - 予算 (毎秒 5、まとめて 10) を超えると `known: false` になり、`TRY AGAIN` または `Pass: unknown` と出る。
  - 設定を変えると全員が一斉に読み直すので、検証済みが 10 人を超えると、読み込み時に `TRY AGAIN` が出ることがある。
- **入れ方は 2 通り。**
  - **.hyp を入れ直す場合 (おすすめ)。** 新しいアプリとして置かれ、新しい id が付く (ClientBuilder.addApp)。古い「TOKEN GATE COO」は手で消す。
  - **既存のアプリにスクリプトを貼る場合。**
    - 位置はそのまま。
    - `initial` は props が未設定のときだけ入るので、元のドアの値 (`type`、`direction`、`slideDistance`) はそのまま残る。OpenPay の 6 つの値と `maxRotation` が入る。
    - 入った値は各クライアントとサーバーのメモリの上だけにあり、ビルダーが次に何かの設定を保存したときに保存される。
    - Solana の props の残り、name、desc は、手で直すまで残る (設定の画面には出ず、害もない)。

## 6. テスト

1. **ユニット (test/nftDoorExample.test.js、24 件)。** SES の Compartment で、本物のスクリプトを偽の app と world で動かす。
   - **プリセット。** tokenId が、ストアの URL の商品 ID から計算した `keccak256('openpay:license:' + id)` と一致する。コントラクトはチェックサム付きで正しい。
   - **設定。** `initial` は未設定のときだけ入る。貼り付けたときは元の値が残る。
   - **クライアント。**
     - 読み込み時の答えは表示だけを変える。
     - Open は 1 回だけ送り、その番号の答えだけで開く。
     - 持っていないときはリンクが出る。持っているときは出ない。
     - `storeUrl` が空ならリンクなし。
     - 未接続と、`known: false`。
     - Open の時間切れと、そのあと遅れて来た答え。
     - 読み込み時の要求を 1 回だけ送り直す。
     - 送信できなかったとき。
   - **サーバー。**
     - spec の空白を落とし、答えはその人だけに番号付きで返す。
     - 読み取り中に来た要求は、最新の番号で 1 回だけ答える。
     - 番号が不正なら 0 にする。
     - ウォレットが変わったら読み直す。退出したら読み直さない。
2. **e2e (test/e2e/evm-tips-gate.mjs)。**
   - token-door.js の prim の `Frame`、`LeftDoor`、`RightDoor` の後ろに nft-door.js をつなぎ、ワールドの assets に書く。
   - Alice の画面で 2 つのドアを見る。1 つは Alice が持っている id、もう 1 つは誰も持っていない id。
     - 読み込み時に `PASS VERIFIED` が出て、扉は動かない。
     - Open で `ACCESS GRANTED` になり、扉が開く。`balanceOf` が Alice のアドレスで呼ばれている。
     - 持っていない方は、リンクと補足の行が出る。パネルを押すと `window.open(STORE, '_blank', 'noopener,noreferrer')` が呼ばれる。
     - 扉が開いているあいだにウォレットを切断すると、押さなくても両方が `CONNECT EVM WALLET` になる。
     - 扉が自分で閉じたあとも、看板は `CONNECT EVM WALLET` のまま。
3. **本物の Polygon (読み取りだけ)。** `createEvmHoldingService` を公開ノード 2 つ (publicnode、drpc) につなぎ、本物のコントラクトと id で読む。
   - `0x…dEaD` と所有者のアドレスは `known: true, balance: 0` (発行 0 と一致)。
   - 登録されていない id も 0 で、エラーにはならない。これが、ユニットでプリセットを突き合わせる理由。
4. **.hyp を手元のワールドで確かめる (scratchpad の live-door.mjs、本番には触れない)。**
   - 手元のサーバーを、本物の Polygon の公開ノードにつないで起動する。
   - 管理者が `world.builder.addApp` で .hyp をドロップすると、本物のモデルの `Frame`、`LeftDoor`、`RightDoor` が組み上がる。
   - アップロードされた 2 つのファイルが、blueprint の名前で保存されている。
   - 新しい鍵で EVM にサインインすると、本物のチェーンの答えで `NFT PASS REQUIRED` とリンクが出る。Open しても扉は動かない。
   - 別の訪問者の画面でも、サーバーからモデルとスクリプトが読み込まれ、`CONNECT EVM WALLET` が出る。
   - ページのエラーはなし。
   - 保有者が通る場面は、発行が 0 なので本物では確かめられない。e2e の偽の RPC で確かめた。

## 7. 計画レビュー (Fable 5.1, 2026-11-10) の結果: 必須の変更を入れれば GO

### 必須 (すべて取り込んだ)

1. 「Get pass」のアクションが Open と取り合う。→ 右のパネルを押せるリンクにした (§3)。
2. 「Open の答えだけで開く」は、番号がないと書いたとおりにならない。→ `nonce` をサーバーに返してもらう形にした。
3. 10 秒の時間切れが、サーバーの最悪の場合と同じ。→ 15 秒にした。
4. 既存のアプリにスクリプトを貼る場合が抜けている。→ §5 に書いた。.hyp を入れ直すと新しいアプリになり、古いものは手で消すことも書いた。
5. .hyp のサイズはバイト数で数え、ハッシュは書いたバイト列で取る。→ Buffer で数え、両方のファイル名を読み直しで確かめている。
6. e2e でクライアントの状態の変化まで見る。→ ユニットで順序どおりに、e2e で本物のエンジンの上で確かめた。応答がない場合はユニットで見ている。
7. Solana の判定を外すことはユーザーに聞く。→ 聞いて「NFT だけ」になった。

### 推奨 (取り込んだもの)

- 看板にストアのホスト (`open-pay.jp/@coo`) を出す。新しいタブはそのまま。
- §3 の表に `PASS VERIFIED` を加える。
- Myna Wallet (AA) で通れる前提 (`PUBLIC_EVM_CHAIN_IDS` の先頭が 137) を書く。
- ドロップした本人の画面で最初の問い合わせが失われる件。→ 手元の確認で実際に起きたので、1 回だけ送り直すようにした。
- 決まった順序で状態の変化を確かめるユニットテスト。

### 取り込まなかったもの

- **読み込み時の要求を 0〜1 秒ずらす。** このワールドの人数では予算の心配が小さいので、見送った。
- **App.md に、サーバー側のコールバックが `(data, networkId)` であることを書く。** 今回の変更の範囲外なので、見送った。

## 8. コードレビュー (Codex GPT-6 Astra, xhigh, 2026-11-10) の結果

中くらいの指摘が 3 件、軽微な指摘が 2 件あり、すべて直した。

- セキュリティ、プライバシー、SES、.hyp の作り直しには問題なしとのこと。
- 作り直した .hyp は、読み込める、スクリプトがバイト単位で一致する、サイズとハッシュとヘッダーの境目が正しい、と確認された。

1. **中: アプリを作り直す前の答えで扉が開く。**
   - 作り直すと番号は 1 からになる。一方、App は古い版の答えも受け取る。そのため古い番号 7 の許可が、新しい Open の番号 2 を満たしてしまう (`>=` で比べていたため)。
   - → `run` を加え、`run` が違う答えは捨てる。開けるのは番号がちょうど一致したときだけにした。
2. **中: ウォレットを替えると、押していないのに扉が開く。**
   - Open の答えを待っているあいだにウォレットを替えると、サーバーが読み直しを Open の番号のまとめて返す。新しいウォレットが持っていれば開いてしまう。
   - → サーバーは `evmWallet` で `open` を落とし、答えに `open` を付けて返す。クライアントは `open: true` の答えでだけ開く。
3. **中: 開いている扉を、未接続の人が押し続けて開けたままにできる。**
   - 開いているときの Open が、判定せずに時間を延ばしていた。
   - → 開いているときも判定してから延ばす。
4. **軽微: 扉が閉じると、新しい状態の看板 (`CONNECT EVM WALLET`) が `NFT PASS REQUIRED` に戻る。**
   - → 閉じたときは `status` から描き直す。
   - e2e も、閉じたあとの看板まで見るようにした。
5. **軽微: 設計書の「警告を 1 回出す」は誤り。**
   - → §3 を直した。空の設定は警告なしで `known: false` になる。

### 修正差分の確認 (Codex, 1 回目)

1〜5 はすべて FIXED と判定された。新たに次の指摘があり、すべて直した。

- **中: 閉じている途中で届いた許可が捨てられる。** `ACCESS GRANTED` と出たまま扉が閉じる。
  - → `openDoor` は、閉じている途中でも開け直す。
- **中: 時間切れを答えの処理では確かめていない。** 15 秒を超えて止まっていた画面に古い許可が先に届くと、扉が開く。
  - → 答えを受けた時点でも時間切れを確かめる。
- **軽微: 3 の回帰テストが弱い。** 元の不具合を戻しても 21 件すべてが通った。
  - → 7.5 秒押し続けても、閉じた位置にちょうど戻ることを確かめる形にした。
  - 直した不具合を 1 つずつ戻すと、それぞれをテストが検出することを確かめた。戻したのは、1〜4、上の 2 件、時間切れをフレームで数える形の 7 種類。

### 修正差分の確認 (Codex, 2 回目): CLEAN

- A、B、C はすべて FIXED と判定された。
- 新しい不具合はなし。
- Codex 自身も、直した不具合 7 種類を 1 つずつ戻してテストが検出することと、時間切れの境目 (14,999 ms では受け取り、15,000 ms では捨てる) を確かめた。

## 9. 最終の結果 (2026-11-10)

- ユニット: `npm test` は全件通過。test/nftDoorExample.test.js は 24 件。lint はエラー 0。
- e2e: `evm-tips-gate.mjs` は Chromium 11/11、WebKit 11/11。
- 手元のワールド (本物のモデル、本物の Polygon) での .hyp の確認: 6/6。
- 作り直した nft_gate.hyp は 409,659 バイト。スクリプトは `asset://47eeddcd…e1d7.js` で、nft-door.js の SHA-256 と一致する。モデルは元のまま。
