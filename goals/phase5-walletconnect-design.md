# Phase 5 設計: WalletConnect (P1.5 の前半)

状態: v1 (計画レビュー前)。前提は main の EVM ウォレット接続 (PR #21、`src/client/evm-integration.js`)。

## 0. 目的とスコープ

- スマホの普段のブラウザ (Safari / Brave / Chrome) から、スマホのウォレットアプリで EVM ウォレットをつなげる。
- PC では、拡張機能が無くても、QR コードをスマホのウォレットで読み取ってつなげる。
- つないだ後の流れは今と同じにする: SIWE 署名で所有を証明する (EOA)、投げゼニの送金 (ERC-20 transfer)。

範囲外 (次の段階):
- スマートコントラクト型ウォレット (EIP-1271 / 6492) の署名確認。
- AppKit (Reown の公式モーダル) の利用。

## 1. 調査結果 (2026-11-08)

### ライブラリの選択
- `@walletconnect/ethereum-provider@2.26.0` は試したが採らない。
  - QR モーダル用に `@reown/appkit` (Lit・Coinbase SDK など) を引き込む。
  - npm audit の high が 3 → 15 に増える。原因はすべて zod の GHSA-mrhx-c7xc-m3w5 (`<4.6.6`、3.x の修正版なし)。
  - モーダルの Lit が SES と合うかは未検証。
- 採用: `@walletconnect/universal-provider@2.26.0` (2026-10-08、31 日前)。
  - AppKit を含まず、audit は変わらない (13、high 3 は既存の Solana 系)。zod も入らない。
  - QR と画面は自前で作る。
- QR は `uqr@0.1.3` (MIT、依存なし、2026-04-03) で作る。SVG の文字列を `data:image/svg+xml` の `<img>` として出し、innerHTML は使わない。

### SES との相性 (試作で確認)
- リポジトリ外の試作で確かめた。本物の `src/core/lockdown.js` (lockdown 済みで、組み込みが凍結されている) の後に、universal-provider を動的 import した。
- Chromium・WebKit とも、`init` → relay 接続 → `display_uri` (`wc:...`) まで動き、エラーは 0 件だった。
- relay を遮断すると `display_uri` は出ない (relay につながるまで待つ)。

### 読み込みの重さ
- 試作では WalletConnect 部分が 484 KB (minify 済み) の別ファイルになった。
- 今のビルドは esbuild の `splitting` が無効で、動的 import も本体に入ってしまう。分割を有効にする (§4)。

### API
- `UniversalProvider.init({ projectId, metadata })` → `connect({ optionalNamespaces: { eip155: { chains, methods, events } } })`。
- `display_uri` イベントで `wc:` の URI が出る。
- 承認後、`session.namespaces.eip155.accounts` に `eip155:137:0x...` が入る。
- 要求は `request({ method, params }, 'eip155:137')` で送る。
- イベント: `session_event` (accountsChanged / chainChanged)、`session_delete`、`disconnect`。
- `wallet_revokePermissions` は無いので、代わりに `disconnect()` を使う。
- `wallet_addEthereumChain` は多くのウォレットで使えない。

### スマホでの動き
- 最初の接続は、ウォレットの universal link で行う: `<universal>/wc?uri=<encoded wc:...>`。AppKit と同じ書式。
- 承認後のブラウザへの戻りは利用者の手動 (iOS は自動では戻れない)。
- 後の `personal_sign` / `eth_sendTransaction` で、ウォレットアプリは自動では開かない → 「ウォレットを開く」ボタンを出す。

### ライセンスと運用
- WalletConnect Community License: MAU 500 / RPC 250 万回を超えると商用ライセンスが要る。閾値は Reown の裁量で変わる。
- Reown のゲートウェイへの接続が条件。
- ダッシュボードの Domain allowlist に `play.dwebxr.xyz` を登録する (`localhost` は常に可)。CSP は今のサイトに無いので対応は不要。

## 2. 設定

| 変数 | 側 | 既定 | 意味 |
|---|---|---|---|
| `PUBLIC_WALLETCONNECT_PROJECT_ID` | ブラウザ (公開値) | 空 (=無効) | Reown のプロジェクト ID。EVM (`PUBLIC_EVM_CHAIN_IDS`) が有効なときだけ使う |

- 本番では `fly.toml` に `814ddf464dea172256d6ddd8edd42880` を入れる。
- `buildPublicEnv` は `PUBLIC_*` を通すので、サーバーの変更は不要。

## 3. 接続アダプター `src/client/walletconnect.js` (新規、動的 import でだけ読み込む)

```js
createWalletConnectProvider({ UniversalProvider, projectId, chainId, metadata, storage? }) → Promise<provider>
```

- EIP-1193 の形 (`request` / `on` / `removeListener`) で返し、`evm-integration` の既存の経路にそのまま乗せる。
- 加えて `connectWith(onUri)`、`disconnect()`、`walletLink()` (§5) を持つ。
- `request` の対応:
  - `eth_requestAccounts`: セッションが無ければ `connect` (optionalNamespaces = eip155 に `eip155:<chainId>`)。
    - methods は `personal_sign`、`eth_sendTransaction`、`wallet_switchEthereumChain`。events は `accountsChanged`、`chainChanged`。
    - `display_uri` は呼び出し側の `onUri` に渡す。
    - 承認後、`<chainId>` の口座が無ければ切断して `{ code: 4901 }` (チェーン未対応) で失敗させる。
  - `eth_accounts`: セッションの `<chainId>` の口座。
  - `eth_chainId`: 口座があれば `0x<chainId>`。
  - `wallet_switchEthereumChain` で `<chainId>`: 承認済みなら何もしない。それ以外は `{ code: 4902 }`。
  - `wallet_addEthereumChain`: `{ code: 4200 }` (未対応)。`evm-integration` の switchChain は 4902 → add の順で試すので、ここで止まる。
  - `wallet_revokePermissions`: `disconnect()`。
  - `personal_sign` / `eth_sendTransaction`: `request(..., 'eip155:<chainId>')` で転送する。転送の前に `onRequest` を呼び、画面に「ウォレットで承認してください」と「ウォレットを開く」を出す。
  - それ以外: `{ code: 4200 }`。
- イベントの変換:
  - `session_event` の accountsChanged / chainChanged をそのまま流す。
  - `session_delete` / `disconnect` は `accountsChanged([])` に変える。既存の localDisconnect が動く。
- セッションの保存:
  - universal-provider は localStorage にセッションと鍵を保存する (標準の動作)。
  - 再読み込み後、セッションが残っていれば QR なしで再利用する。署名 (SIWE) は接続ごとに必ずやり直す。
  - Disconnect でセッションを消す。

## 4. ビルド (scripts/build.mjs のクライアント)

- `splitting: true` と `chunkNames: 'chunks/[name]-[hash]'` を足す (ESM 出力はすでに使っている)。
- `jsPath` / `particlesPath` の選び方を、出力ファイル名の部分一致から metafile の `entryPoint` に変える。chunk の名前と取り違えないため。
- `src/client/evm-integration.js` は `() => import('./walletconnect.js')` と `() => import('@walletconnect/universal-provider')` を、注入できる `loadWalletConnect` として持つ。テストでは偽物を渡す。

## 5. 画面

- **EVM タブの接続ボタン:** `PUBLIC_WALLETCONNECT_PROJECT_ID` があれば、ウォレット一覧の最後に「WalletConnect」を出す。
  - アイコンは自前の data: SVG。
  - 一覧に WalletConnect が常にあるので、「No EVM wallet found」は出なくなる。
  - スマホで注入ウォレットが無いときは、WalletConnect を先頭に出す。
- **接続の画面 (パネル内):**
  - 「Connecting to WalletConnect…」 → URI が来たら:
    - **PC (isTouch でない):** QR コード (`uqr` の SVG)、「Scan with your wallet app」、「Copy link」。
    - **スマホ:** 「Open MetaMask」「Open Trust Wallet」「Open Rainbow」と「Other wallet (copy link)」。
      - 各リンクは `<universal>/wc?uri=<encodeURIComponent(uri)>`。universal link は MetaMask `https://metamask.app.link`、Trust `https://link.trustwallet.com`、Rainbow `https://rnbwapp.com`。
  - 「Cancel」で接続をやめる。
- **署名・送金の承認待ち (スマホ):**
  - パネルとフォームに「Approve in your wallet app」と「Open wallet」を出す。
  - リンク先は、セッション相手の `metadata.redirect.universal` (無ければ `native`)、無ければ接続に使ったウォレットのリンク。
  - 2026-11-09 変更 (phase6 §1 リンクの形式): 相手の `native` → 接続に使ったウォレットのスキーム → 相手の `universal` の順。

## 6. エラーとセキュリティ

- URI と QR は利用者の画面にだけ出す (サーバーへは送らない)。`Copy link` の文字列にはペアリングの鍵が入るので、注意を一行添える。
- SIWE の確認はサーバーが今まで通り行う (EOA)。スマートコントラクト型ウォレットは `signature_invalid` になる。案内文は「This wallet signs with a smart contract, which is not supported yet」(WalletConnect 経由で失敗したときに限る)。
- 動的 import の失敗 (ネットワーク・ブロッカー) は、トーストで「WalletConnect could not load」とする。
- 接続の途中で dispose / disconnect / パネルを閉じた場合: `connect` の約束が残っても結果は捨て、セッションがあれば `disconnect()` する。

## 7. テスト

- **ユニット:**
  - `walletconnect.js`: 偽の UniversalProvider で次を確かめる。
    - request の対応、`<chainId>` の口座が無いときの失敗、イベントの変換、disconnect、`onUri` / `onRequest`。
    - 深いリンクの書式 (エンコード)。
  - `evm-integration`: WalletConnect の項目が出ること、注入した `loadWalletConnect` で接続から SIWE まで通ること、dispose で切断されること。読み込みに失敗したときの案内。
  - ビルド: `jsPath` が entry を指し、chunk が別に出ること (build.mjs のテストがあれば足す。無ければ e2e で確認)。
- **e2e** (`evm-wallet.mjs` に足す。CI では relay に依存しない):
  - 設定ありで WalletConnect ボタンが出ること。
  - 押すと lockdown 下で chunk が読み込まれ、エラーが無く「Connecting…」の画面になること (relay は遮断する)。
  - スマホの画面幅とタッチ環境では、ウォレットのボタンが並ぶこと (URI はユニットで確かめる)。

## 8. レビューしてほしい論点

1. AppKit を使わず universal-provider と自前の画面にする判断 (audit・SES・重さ) と、その代償 (ウォレット一覧が限られる、保守)。
2. optionalNamespaces で 137 を任意にして、接続後に確かめる判断 (required にするとウォレットが接続を断ることがある)。
3. スマホの深いリンクを 3 社に固定する判断と、「Other wallet (copy link)」で足りるか。
4. セッションの localStorage 保存 (鍵を含む) と、再読み込み時の再利用。
5. esbuild の splitting を有効にすることの影響 (sourcemap、`jsPath`、キャッシュ、e2e の静的配信)。
6. スマートコントラクト型ウォレットを次の段階に回す判断と、そのときの案内。
7. ライセンスの閾値 (MAU 500) を README に書く範囲。

## 11. 計画レビューの結果と v2 の決定 (Fable, 2026-11-08)

判定は CONDITIONAL GO。以下を取り込む (§3〜§7 と食い違うところは、この節を優先する)。

### 必須 (GO の条件)
- **B1 戻り先リンクの検証。** `peer.metadata.redirect` はウォレットが relay 越しに送る値なので、`href` に入れる前に確かめる。
  - universal は `https:` (ユーザー名とパスワードなし) だけを通す。
  - native は `^[a-z][a-z0-9+.-]*:` の独自スキームだけを通す。`javascript:` `data:` `blob:` `file:` `http:` `https:` `about:` `vbscript:` は通さない。空白を含まないこと、200 文字以内であること。
  - それ以外は、利用者が押したウォレットのリンクに戻す。
  - 相手の `metadata.icons` は出さない (外部 URL の読み込みによる追跡を避ける)。リンクには `rel="noopener noreferrer"` を付ける。
- **B2 アダプターで値をそろえる。**
  - `eth_requestAccounts` / `eth_accounts` / `eth_chainId` / `wallet_switchEthereumChain` は UniversalProvider に渡さない。UP の `eth_chainId` は数値を返すため。
  - 口座はセッションの `eip155:<chainId>:` だけから取り、`eth_requestAccounts` で渡した口座を先頭にする (S3)。
  - UP の `accountsChanged` / `chainChanged` はそのまま流さない。これらを受けたらセッションから口座を数え直し、変わったときだけ `accountsChanged` を出す。
    - ウォレット側でネットワークを切り替えただけ (UP は `[]` を出す) では切断しない。
  - `accountsChanged([])` を出すのは、セッションを失ったとき (`session_delete` / `disconnect` / `session_expire`、またはセッション消失のエラー) だけにする。
  - `chainChanged` は流さない。要求は常に `eip155:<chainId>` を指定して送るので、ウォレット側のネットワークに左右されない。
  - 拒否 (5000〜5003、4001、文言に reject / denied / cancel を含むもの) は `code: 4001` にそろえる。
- **B3 relay と接続の頑健さ。**
  - `display_uri` が 20 秒来なければ `relay_unreachable` として失敗させ、案内文を出す。
  - 接続は直列にする (同時の 2 回目は同じ Promise を返す)。
  - 取り消し (Cancel・別の接続・dispose) で待ちを終える。遅れて成立したセッションは `disconnect()` する。
  - `disconnect()` はセッションがあるときだけ呼び、例外は飲み込む。
  - 要求の後にセッションが無くなっていたら `accountsChanged([])` を出す。
- **S1 メタデータ。** `metadata.url = location.origin`、icons は空にし、`telemetryEnabled: false` にする。
- **S2 dispose の扱い。** 成立済みのセッションは残す (再読み込み後に QR なしで再利用するため)。接続途中なら取り消す。

### 取り込む推奨
- **S3** 渡した口座を先頭にする (上記 B2)。
- **S4 ウォレットを自動で開く仕組みは使わない。** `WALLETCONNECT_DEEPLINK_CHOICE` は、ユーザー操作の外の `window.open` に頼り、iOS では止められうるため。ウォレットを開くのは利用者が押す「Open wallet」(ユーザー操作) に限る。
- **S5 e2e の範囲。**
  - CI では relay を遮断し、chunk が lockdown 下で読み込まれて「Connecting…」になるところまでを確かめる。
  - QR の表示・ウォレットのリンク・承認後の流れは、偽の UP を使ったユニットテストで確かめる。偽の relay は今回作らない。
- **N1 スマホ・タッチ端末の画面。**
  - 「Other wallet」は、Android では `wc:` リンク (OS が選択肢を出す)、iOS ではリンクのコピー。
  - タッチ端末にも「Show QR」の切り替えを付ける (iPad など)。
  - アプリが入っていない場合は App Store に飛ぶ、と注記する。
- **N2 その他。**
  - 失敗時の文言を和らげる: 「Signature not accepted. Smart-contract wallets are not supported yet.」(WalletConnect 経由のときだけ)。
  - README にライセンスの段落を書く。
  - `uqr` を依存に足す。
  - chunk の読み込みに失敗したら、再読み込みを促す。
- QR (`uqr`) は遅延読み込みの chunk の中で SVG の data URL にし、状態として画面に渡す。本体の bundle には入れない。

## 12. コードレビュー (Codex, 2026-11-08) を受けた最終設計: SignClient を直接使う

§3 までの UniversalProvider 前提は、この節で置き換える。

### UniversalProvider をやめた理由

レビューを 3 回重ねて、競合の不具合が出続けた。原因はどれも UniversalProvider の作りにあった。

- **セッションが 1 つしかない。** ペアリングが重なると、互いのセッションを上書きする。`connect()` が返る前にセッションを差し替えるので、その隙間で別の試行が拾うこともある。
- **後片付けを非同期に走らせる。** `cleanup()` は、その時点で持っているセッションを丸ごと消す。SDK が期限切れのセッションを消したときにも、`session_delete` 経由で動く。
- **ペアリングのリンクが共通のイベントで届く。** すべてのリンクが `display_uri` から出てくるので、どの試行のリンクか区別できない。
- **アカウント変更でセッションを更新しない。** `accountsChanged` が来ても namespaces はそのまま。

依存を `@walletconnect/sign-client@2.26.0` に替えた。UniversalProvider の下で使われていたものと同じ版で、npm audit は変わらない (13 件)。

### 設計

- **ペアリングごとに別のリンクと承認。** `client.connect()` は、ペアリングごとに `{ uri, approval }` を返す。
  - 戻ったらすぐ `approval()` を呼んで承認待ちを始める。`createDelayedPromise` は、待ちが始まる前の reject を捨ててしまうため。
  - あきらめたペアリングは、proposal とペアリングのトピックを expirer で即座に期限切れにする。リンクがまだ出ていなければ、出た時点でそうする。
  - あきらめたペアリングに遅れてセッションが届いたら、そのトピックだけを閉じる。
  - ペアリングを直列にする必要はない。次の試行はすぐ始められる。
- **使うセッションはアダプターが持つ。** トピックを `current` として 1 つ持つ。
  - イベント (`session_event` / `session_update` / `session_delete` / `session_expire`) は、`current` のトピックのものだけを扱う。
  - 要求は `client.request({ topic: current, chainId, request })` で送る。
  - 起動時は、保存されているセッションのうち、サインインチェーンにアカウントがあって期限内のものを使う。複数あれば期限が最も遅いものにする。
- **セッションの終了はトピックを名指しする。** `client.disconnect({ topic })` で、待つのは最大 10 秒。
  - 失敗したとき、または時間切れのときは `client.session.delete(topic)` で消す。この保存の完了は誰も待たない。
  - 終了済みのトピックは二度と使わない。
  - 使えなくなったセッションの片付けは裏で走らせる。新しいペアリングはそれを待たない。
- **アカウント。** ウォレットがサインインチェーンについて `accountsChanged` で知らせてきた並びを、セッションのアカウントで絞って使う。
  - 空の配列は「アカウントを引き上げた」と扱う。
  - 何も知らせてこなければ、セッションの並びを使い、渡したアカウントを先頭にする。
- **そのまま残したもの:**
  - 状態表示の持ち主
  - キャンセル
  - 中継サーバーの待ち時間 (20 秒)
  - ネットワーク違い (4901) の扱い
  - 拒否は 4001 に正規化する
- **画面で直したこと:**
  - 新しいペアリングのリンクが出たら、前に選んだウォレットの記憶を消す。「Other wallet」を押しても消す。
  - 別のウォレットに切り替えたら、WalletConnect の QR を画面から消す。
  - サインインの署名待ちには Cancel を出し、サーバー側の試行も取り下げる。送金の承認待ちには出さない。

### 確認 (Codex 3 回目) を受けた追加の決定

- **ペアリングが残したセッションも閉じる。** SDK は、承認の確定を伝え終える前にセッションを保存する。伝えるのに失敗すると、承認は解決しないまま残る。
  - そこで、あきらめたペアリングや承認が失敗したペアリングについては、同じ `pairingTopic` を持つ保存済みのセッションを探して閉じる。使っている `current` は除く。
- **ペアリングのトピックは、こちらから期限切れにしない。** そのトピックに対する Core の期限切れ処理は非同期で、購読解除の失敗が unhandled rejection になる。proposal だけを即座に期限切れにし、ペアリング自体は SDK の 5 分の期限に任せる。
- **Cancel の直後の接続は、新しい接続として始める。** キャンセル済みの待ちに合流させない。
- **署名待ちの Cancel では、ウォレットを外さない。** 失敗したときと同じく付けたままにする。「Sign」で同じウォレットをもう一度使え、「Disconnect」でそのセッションを終えられる。
- **残る P3 (SDK 側、ページを開いている間だけのもの):**
  - キャンセルを繰り返すと、proposal 用の鍵ペアが残る。
  - proposal の送信が失敗すると、内部のリスナーが残る。
  - `client.session.delete` に頼った場合は、鍵や expirer の後片付けがされない。
  - どれも量が小さいので、今は対処しない。
