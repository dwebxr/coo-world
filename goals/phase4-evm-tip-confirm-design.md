# Phase 4 設計: 投げゼニの確定確認と告知 (P2b)

状態: v1 (計画レビュー前)。前提は main の P2a (`goals/phase3-evm-tips-gates-design.md`、PR #21)。§11 の持ち越し (B2〜B5、S1、S4、S5、S7、S8) をここで解く。

## 0. スコープ

- 送り手のクライアントが送金の tx ハッシュをサーバーへ報告する。
- サーバーはチェーン上で Transfer を確認し、確定を待つ。
- 確定したら次の3つを行う:
  - ワールド全体へチャットで告知する。
  - 送り手に結果を返す。
  - サーバースクリプトへ `tip` イベントを出す。
- サーバーは資金・鍵を持たず、手数料も取らない (P2a と同じ)。

範囲外: 告知や `tip` の DB 永続化、サーバー再起動をまたぐ確認の継続、クライアントスクリプト向けの `tip`、P1.5。

## 1. 調査で分かった事実

### 外部 (2026-11-08)
- **Polygon PoS の確定。** Heimdall v2 の milestone により決定的な確定があり、取り込みから確定まで 2〜5 秒 (VERIFIED: Polygon docs の finality ページ)。`eth_getBlockByNumber("finalized")` が確定済みの最新ブロックで、`finalized.number >= receipt.blockNumber` なら取り消されない。
- **プロバイダーの対応。** 主要プロバイダーで `finalized` に対応しているかは一次資料で未確認。対応しない・`latest` を返すものがあるという報告はある (REPORTED)。
- **EIP-7702。** Bhilai (2025-07) から有効 (VERIFIED)。
  - 委任された EOA の一括実行や、スポンサーが出す type-4 tx では、`receipt.from` と `receipt.to` が論理的な送り手と一致しない。ERC-4337 でも同様。
  - Transfer ログの `topics[1]` は、トークンを持つアドレス (EOA) のまま。→ `receipt.from` / `receipt.to` は使わず、ログだけで照合する。
- **JPYC。** 0xE7C3…3c29 は JPYC 社の電子決済手段の JPYC (VERIFIED: jpycoin GitHub)。
  - 設計は ERC1967 のプロキシで、停止 (pause) と凍結 (blocklist) の役割がある (jcam1/JPYCv2、VERIFIED)。
  - 送金手数料 (fee-on-transfer) の記述はない。
- **USDC (ネイティブ)。** 0x3c49…3359 (VERIFIED: Circle)。
- **ポーリングの費用。** 保留 16 件を 3 秒ごとに確認すると約 5.3 req/s。Alchemy の無料枠は 500 CU/s (VERIFIED) で、十分に収まる。
- **法務。** 第三者アプリが送金を告知することについて、金融庁や JPYC 社の見解は見つからない。公開前の確認事項として残す。

### 内部
- **`evmTipVerify.js` の照合。**
  - `matchTipReceipt` は `receipt.from` と `receipt.to` を照合している。→ どちらも外す (S4)。
  - 最初に一致したログだけを返し、`logIndex` / `blockHash` は返さない。
- **`evmRpc.js` の不足。**
  - 期限・同時数・予算がない。呼び出し側が `AbortSignal` で切る。
  - JSON-RPC の `error` は中身を捨てて例外にする。tx が無いときは `result: null` で返る。
- **ServerNetwork の後始末。**
  - `onDisconnect` は EVM の状態を消さない (プレイヤーごと消える)。
  - 終了処理は `stopForFatal` だけ (通常終了はプロセス終了)。
  - `init` は `createEvmRpcs()` の結果を保持していない。
- **チャット。**
  - `world.chat.add(msg, true)` で全員に配られる。直近 50 件はスナップショットに入る。
  - サーバースクリプトにも `chat` イベントとして届く。
  - 流量制限はない。
- **クライアント。**
  - トーストはクライアント内だけ (パケットなし)。
  - `TipForm` の送信済みの表示に「まだ確認・告知しない」とある。
- **テスト。** ハーネスはメソッド名の一覧で抜き出すので、新しいメソッドと依存を登録する。

## 2. 流れ

```
送り手 C                         サーバー S                          RPC
requestEvmTipIntent ───────────▶ intent を検証 (P2a)
                   ◀─────────── evmTipIntent {…, ticket}           (チケットを控える)
eth_sendTransaction (ウォレット)
evmTip {ticket, txHash} ────────▶ チケット・重複・上限を検証
                   ◀─────────── evmTipStatus {ticket, state:'watching'}
                                 監視 (共有ループ) ───────────────▶ getTransactionReceipt / finalized / getBlockByNumber
                   ◀─────────── evmTipStatus {ticket, state:'confirmed' | 'failed' | 'unverified', reason?}
全員               ◀─────────── chatAdded (告知、間引きあり)
サーバースクリプト ◀─────────── world event 'tip'
```

## 3. チケット (intent の控え)

- intent 成功時に、サーバーがランダムな `ticket` (16 バイトの 16 進 = 32 文字) を作り、送り手のソケットに控える。返信 `evmTipIntent` に `ticket` を足す。
- 控える内容:
  - `ticket`、`from` (送り手の検証済みアドレス)。
  - `toPlayerId`、`toSocket` (受取人のソケット参照)、`recipient` (受取人アドレス)。
  - `token {symbol, address, decimals}`、`units` (BigInt)。
  - `issuedAt` (サーバー時刻)、`generation` (送り手の `evmWallet.generation`)。
  - `state`: `issued` → `watching` → `done`。再提出待ちのときは `retryable`。
  - `retriesLeft` (1)。
- 上限:
  - 寿命は発行から 10 分。
  - ソケットあたり生きているチケットは 3 件。超えたら、古い未使用のものから捨てる。
  - `invalidateEvmWallet` (送り手の検証が変わった時) で全部捨てる。
- B2 (古い tx の再利用) への対策。チケット発行時にブロック番号を取りに行く RPC 呼び出しはしない。代わりに確定時にブロックを 1 回取り、次の2つを確かめる。
  - `block.hash === receipt.blockHash` (B4 の巻き戻し確認と同じ呼び出し)。
  - `block.timestamp >= issuedAt − 120 秒` (時計のずれを見込む)。
  - 発行前に送られた tx は、120 秒以内のものを除いて弾かれる。その 120 秒の窓に入る再利用は、§4 の既読集合 (30 分) が弾く。

## 4. tx の報告 `evmTip {ticket, txHash}` (C→S)

### 受け付けの条件
- EVM が有効で、送り手が `currentEvm` を満たす。
- チケットがこのソケットにあり、期限内である。
- 状態が `issued`、または `retryable` かつ同じ `txHash` (S8: 確認できなかった後に 1 回だけ再提出できる)。
- `txHash` が `/^0x[0-9a-fA-F]{64}$/` に合う。
- `txHash` が既読集合にない。既読集合は小文字の txHash → {ticket, 期限}、寿命 30 分、上限 4096 件で、古いものから捨てる。同じチケットの再提出は通す。
- 送り手の検証済みアドレスが `ticket.from` と同じで、世代 (`generation`) が同じ。
- 監視数の上限: ソケットあたり 2 件、全体で 16 件。超えたら `unverified` / `busy`。

### RPC が無い場合
- `EVM_RPC_URL_<chainId>` が無い場合は、すぐに `evmTipStatus {state:'unverified', reason:'no_rpc'}` を返す。チケットは `done` にする。

### 受け付けた後
- チケットを `watching` にし、既読集合に入れて、監視に渡す。
- `evmTipStatus {ticket, txHash, state:'watching'}` を返す。

### 受け付けない場合
- `evmTipStatus {ticket, txHash, state:'failed', reason}` を返す。
- reason は固定の語彙:
  - `not_verified`、`unknown_ticket` (無い・期限切れ・使用済みを区別しない)、`bad_tx`、`duplicate`。
- 黙って捨てるもの: 形の不正。古い世代のパケットも黙って捨てる (P1 の作法)。
- 受信上限は inboundPolicy に `evmTip: 160` バイトとして足す。

## 5. 監視 `src/server/evmTipWatcher.js` (新規、I/O は注入)

```js
createTipWatcher({ rpc, now, setTimeout, clearTimeout, log, limits }) → { watch(job), cancel(pred), stop(), size() }
```

- **ジョブ。**
  - 中身: `{ txHash, from, recipient, token, units, issuedAt, isLive(), onDone(result) }`。
  - `isLive()` は ServerNetwork が渡す。次をすべて満たすときだけ真になる (S1)。
    - 送り手・受取人のソケットが同じもののまま接続している。
    - 送り手の検証済みアドレスが `from` のまま、受取人の検証済みアドレスが `recipient` のまま。
- **共有ループ。**
  - タイマーは1本で、ジョブが無い時は止める。周期は 1 秒。
  - 各ジョブは自分の次の確認時刻を持つ。最初の 30 秒は 3 秒ごと、それ以降は 10 秒ごと (B3 のバックオフ)。
- **RPC の予算。** 全体で 1 本のトークンバケット (8 回/秒、バースト 16)。
  - 1 回の呼び出しの期限は 5 秒 (`AbortController`)。
  - 同時に飛ばす呼び出しは 4 本まで。
  - 予算が無ければ、そのジョブは次の周期へ回す。待つだけで失敗にはしない。
- **確定ブロックの共有。** 1 周期に 1 回だけ取る。取るのは、確定待ちのジョブがある周期だけ。
  - `eth_getBlockByNumber("finalized", false)` が使えないと分かった場合 (エラー、または number が無い):
    - ログに1回だけ書く。
    - 確定待ちのジョブは `unverified` / `no_finality` にする。
    - 以後の監視も同じ理由で返す。60 秒後にもう一度試す。
- **1 ジョブの流れ。** どの時点でも、`isLive()` が偽なら `unverified` / `left` で終える。
  1. `eth_getTransactionReceipt(txHash)` を呼ぶ。
     - `null` は保留。
       - 経過 60 秒以降は、`eth_getTransactionByHash` を 1 回だけ呼ぶ。null なら `unverified` / `not_found` (B3 の早期打ち切り)。
     - レシートがあれば `matchTipReceipt` で照合する (§6)。
       - 不一致なら `failed`。理由は `reverted` / `no_transfer`。
       - 一致したら、`blockNumber`・`blockHash`・`logIndex` を控えて確定待ちに移る。
  2. 確定待ちでは、`finalized >= blockNumber` になったら次を行う。
     - レシートを取り直して、同じ照合と `blockHash` の一致を確かめる (B4)。食い違ったら、巻き戻しとみなして 1. に戻る。
     - `eth_getBlockByNumber(blockNumber, false)` を取り、`hash === blockHash` と `timestamp >= issuedAt/1000 − 120` を確かめる。古ければ `failed` / `too_old`。
     - 通れば `confirmed`。
  3. 期限は報告から 3 分。過ぎたら `unverified` / `timeout`。
- **RPC の失敗。** 例外・期限切れ・不正な形は、そのジョブの次の周期で再試行する。期限内に回復しなければ `timeout`。
- **終了。** `stop()` はタイマーを止め、飛んでいる呼び出しを中断する。ジョブは結果を出さずに捨てる。`stopForFatal` から呼ぶ。

## 6. 照合 `evmTipVerify.js` の変更

- `receipt.from` / `receipt.to` の照合をやめる。EIP-7702・スポンサー付き・一括実行に対応するため (S4)。
- 送り手の確認は、ログの `topics[1] === from` (検証済みアドレス) だけで行う。
- 一致したログの `logIndex` を返す。`blockHash` の形 (`0x` + 64 桁) も確認して返す。
- 新しい関数 `checkTipBlock(block, { blockHash, notBeforeSec })` → `ok` / `reorged` / `too_old` / `bad_block`。
- S5 (fee-on-transfer): ログの金額はチケットの `units` と完全一致でなければならない。手数料を引くトークンは一致せず `no_transfer` になる。送金自体は届くので、docs に「手数料付きトークンは確認できない」と書く。JPYC / USDC に手数料はない。

## 7. 確定後

### 送り手
- `evmTipStatus {ticket, txHash, state:'confirmed'}` を返す。

### 告知 (B5)
- 本文は `"<送り手名> tipped <受取人名> <金額> <記号>"`。
  - 名前は、確定時点のプレイヤーの表示名を使う。改行と制御文字は空白にし、64 文字で切る。
  - 金額は `formatUnits(units, decimals)` で正規化する (入力の「0100」などを「100」にする)。
  - アドレスと tx ハッシュは出さない。
- 送り方は `world.chat.add({ id, from: null, fromId: null, body, createdAt }, true)`。システムメッセージになる (B1 で偽装できない)。
- 間引き:
  - 告知キューは上限 20 件で、ワールド全体で 1 秒に 1 件ずつ出す。キューが満杯なら、その告知は捨てる。
  - 送り手ごとのクールダウンは 30 秒。その間の確定は告知しない。
- 告知を出さなかった場合 (クールダウン・満杯) は、受取人にだけ同じ文を `socket.send('chatAdded', …)` で送る。受取人が気づけるようにするため。

### サーバースクリプトの `tip` イベント
- 中身は凍結した `{ tipId, fromPlayerId, toPlayerId, token, amount, units, decimals, chainId }`。
  - `tipId` はチケットで、重複を除くために使う。
  - `token` は記号。`amount` は正規化した 10 進文字列、`units` は最小単位の 10 進文字列。
- アドレスと tx ハッシュは含めない。tx ハッシュからは両者のアドレスが分かるので、スクリプトにアドレスを見せない P3 の方針を保つ。
- `internalEvents` に `tip` を足して、スクリプトやネットワークからの偽装を防ぐ。
- 告知の間引きとは関係なく、確定ごとに必ず出す。

### 失敗・未確認
- 送り手にだけ `evmTipStatus {state:'failed' | 'unverified', reason}` を返す (S7)。
- `unverified` は、`no_rpc` と `left` を除いてチケットを `retryable` にする (S8、1 回だけ)。

## 8. クライアント

- **`tip()`。**
  - `eth_sendTransaction` が成功したら、`evmTip {ticket, txHash}` を送る。
  - 戻り値に `ticket` を足す。
- **`world.evm.recheckTip(ticket, txHash)`。** 再提出を 1 回だけ行う。
- **`evm:tipStatus` の中継。** ClientNetwork の `onEvmTipStatus` から `world.emit('evm:tipStatus', data)` で流す。
- **TipForm の送信後の状態。**
  - `watching`: 「Confirming on Polygon…」。
  - `confirmed`: 「Confirmed. Everyone here can see your tip.」(告知が間引かれた場合も同じ文でよいか → §10)。
  - `failed`: 理由の文。
  - `unverified`: 「Sent, but this world could not confirm it.」と理由。`retryable` なら「Check again」ボタン。`no_rpc` なら「This world does not confirm tips.」。
  - 6 分待っても状態が来なければ `unverified` 扱い。
  - 「まだ確認・告知しない」の注記は消す。
- **chain_changed の警告が出た場合も報告する。** 別チェーンの tx ならサーバーには見つからず、`not_found` になる。

## 9. 互換性・設定

- パケットは末尾に追加する。`evmTip` (38)、`evmTipStatus` (39)。`PROTOCOL_VERSION` は 2 のまま。
- `evmTipIntent` に `ticket` を足すが、P2a のクライアントは無視する。
- 設定の追加はない。`EVM_RPC_URL_<chainId>` があれば確認・告知し、無ければ P2a と同じ (送金のみ)。
- docs:
  - World.md に `tip` イベントを足す。有料の特典・景品・ランキングに使う場合は app 作者の販売になる旨 (特商法・景表法・賭博) を書く。
  - README の Tips 節。
  - CHANGELOG。
  - `.env.example` の `EVM_RPC_URL_137` の説明 (確認・告知にも使う)。

## 10. レビューしてほしい論点

1. B2 を「チケット発行時のブロック番号」ではなく「確定時のブロック時刻 ≥ 発行時刻 − 120 秒」+ 既読集合 30 分で解く判断。
2. `finalized` が使えないプロバイダーでは、深さによる代替をせず `no_finality` で未確認にする判断。
3. 送り手・受取人のどちらかが途中で離脱した、または検証を失った時は告知も `tip` も出さない (S1)。tx 自体は有効なので、受取人が離脱したときにも告知しないことの是非。
4. 告知の間引き (全体 1 件/秒、キュー 20、送り手 30 秒) と、告知しなかった時に受取人にだけ知らせること。
5. `tip` イベントに tx ハッシュとアドレスを入れない判断。
6. 予算 (全体 16 件、ソケット 2 件、バケット 8/秒・バースト 16、同時 4、3→10 秒、期限 3 分、60 秒で `getTransactionByHash`) の妥当性と増幅の見落とし。
7. 名前を含む告知文の偽装 (名前に「tipped」などを入れて誤読させる) の扱い。
8. 一つの tx に同じ受取人・同額の Transfer が複数ある一括送金で、チケットごとに数えず tx ハッシュ単位で 1 回にする判断。

## 11. 計画レビューの結果と v2 の決定 (Fable, 2026-11-08)

判定は CONDITIONAL GO。以下を取り込む。§3〜§8 と食い違うところは、この節を優先する。

### 必須 (GO の条件)
- **B-1 `finalized` の判定。**
  - `evmRpc` は、JSON-RPC の `error` を `RpcError {code}` として投げる (通信の失敗とは区別する)。
  - `no_finality` にするのは、`RpcError` か、number の無い (または形の悪い) 非 null のブロックのときだけ。通信の失敗・期限切れは、次の周期に再試行する。
  - プロバイダーが `finalized` を `latest` として返す場合は見分けられない。docs に書く。
- **B-2 既読集合の妨害。**
  - 受け付け時には、同じ txHash を監視中のチケットを数えるだけにする (上限 2)。既読集合 (30 分) へは確定時に入れる。
  - 確定時に既読なら `failed` / `duplicate` にする。
  - 他人の txHash を先に報告されても、ログの `topics[1]` が自分ではないので確定しない。本人の報告は妨げられない。
- **B-3 後始末。**
  - `stopForFatal` で `tipWatcher.stop()` を呼び、告知のタイマーも止める。
  - `onDisconnect` では、そのソケットのチケットを捨て、そのソケットが送り手のジョブを `cancel` する。
  - `stop()` 後の続き (await の後) は何もしない。
  - 結果を出すところ (onDone) では `stopping` を確かめ直し、チケットが無い場合にも耐える。
- **S-2 照合の強化。**
  - `receipt.transactionHash === txHash` を確かめる。
  - ログに `transactionHash` / `blockHash` があれば、レシートと一致することを確かめる。
  - ログの上限を 1024 にする (本文は 256 KiB で切れる)。
  - `wrong_sender` / `wrong_contract` は削る。
  - 戻り値は `{ blockNumber, blockHash, logIndex }`。
- **S-7 テスト。**
  - ハーネスに新しいメソッドを登録し、`init` で `tipWatcher` を注入できるようにする。
  - 監視のユニットテストは時計とタイマーを注入して行う。対象: 保留 → 一致 → 確定、巻き戻し、`too_old`、`no_finality` は RpcError のときだけ、予算切れ → `timeout`、停止。
  - 照合のテストに、7702 型 (`receipt.from` ≠ `topics[1]`) と `transactionHash` の不一致を足す。
  - e2e は、偽 RPC がレシートと確定ブロックを返すようにし、告知が第三者にも届くことを確かめる。

### 取り込む推奨
- **S-1 受取人は離脱してもよい。**
  - 監視中に要るのは、送り手のソケットが同じもののまま接続していることだけ。送り手の検証済みアドレスが一時的に消えても止めない。真偽は、チケットに控えた `from` とログで決まる。
  - 受取人は、チケットに控えた `toPlayerId` とアドレスで確定する。受取人が離脱しても確定・`tip` イベントは出す。
  - 告知では、名前をそのときの表示名 (いなければ intent 時に控えた名前) で出す。
- **S-3 チケットの捨て方。**
  - 古い `issued` から捨て、次に古い `retryable` を捨てる。`watching` は捨てない。ソケットの監視は 2 件まで、チケットは 3 件までなので、空きは必ずできる。
  - 全体の上限 (16) に当たったら `unverified` / `busy` を返し、チケットは `issued` のまま残す。再提出の回数は減らない。待ち行列は作らない。
- **S-4 時計のずれの許容を 30 秒に縮める** (`timestamp >= issuedAt/1000 − 30`)。
  - 再起動で既読集合が消えるため、再起動をまたぐと、直前約 30 秒の確定が新しいチケットで二重に告知されうる。docs に書く。
- **S-6 クライアント。**
  - `ticket` は送金の前に控える。
  - `evmTip` を送れなければ、その場で `unverified` / `unavailable` とする。
  - TipForm は `ticket` で状態を絞り込む。再提出はクライアント側でも 1 回だけ。
- **N-1 告知は全体で 3 秒に 1 件、バースト 3。** キューは 20 件、送り手ごとのクールダウンは 30 秒。
- **N-2 確定確認の手順。** `finalized >= blockNumber` の後は、レシートを取り直さず、`getBlockByNumber(blockNumber).hash === receipt.blockHash` で正規の鎖にあることを確かめる。食い違えば巻き戻しとして、レシートの確認からやり直す。
- **N-3** inboundPolicy に `evmTip: 160` を足す。
- **N-4** `tip` イベントに `at` (ミリ秒) を足す。docs に、手数料付きトークンは確認できないこと、一括送金は tx ごとに 1 回であることを書く。
- **受取人だけへの通知の文面。** 公開告知と区別する (「(only you) Alice tipped you 100 JPYC」)。

### 見送り
- **S-5 チャットに構造化した `tip` 欄を足す案。**
  - `chatEnvelope` はスクリプトの `world.chat.add` も通るので、スクリプトが偽の投げゼニ表示を作れる経路になる。今回は文面での区別にとどめる。
  - 名前は制御文字と改行を除き、32 文字で切る。
  - 信頼できる経路はスクリプト向けの `tip` イベントである旨を docs に書く。
- **全体上限に当たったときの待ち行列。** `busy` + 再提出で代える。

## 12. 実装記録 (2026-11-08)

- **RPC**: `src/server/evmRpc.js` に `RpcError {code}` を追加した。ノードの文字列は持たない。
  - `error` と `result` が並ぶ応答と、オブジェクトでない `error` は、これまでどおり通常の失敗とする。
- **照合**: `src/server/evmTipVerify.js` の変更。
  - `matchTipReceipt(receipt, { txHash, from, recipient, token, units })` は `receipt.from` / `receipt.to` を見ない。
  - `transactionHash` の一致を確かめ、ログの `transactionHash` / `blockHash` があれば一致を確かめる。
  - ログは 1024 件まで。
  - 戻り値は `{ blockNumber, blockHash, logIndex }`。
  - 新しい関数 `checkTipBlock` は `ok` / `reorged` / `too_old` / `missing` / `bad_block` を返す。
- **監視**: 新しい `src/server/evmTipWatcher.js`。
  - 1 本のタイマーで 1 秒周期。各ジョブは 30 秒まで 3 秒ごと、その後 10 秒ごとに確認する。期限は 3 分。
  - 60 秒たってもレシートが無ければ `getTransactionByHash` を 1 回呼び、null なら `not_found`。
  - RPC の予算は、バケット 8/秒・バースト 16、同時 4、1 回の期限 5 秒。枠は呼び出しが実際に終わるまで持つ。
  - 予算が無いときは待つだけで、失敗にはしない。
  - `finalized` は 1 周期に 1 回だけ取る。`no_finality` にするのは、`RpcError` か number の無いブロックのときだけ。60 秒後にもう一度試す。
  - `bad_receipt` は取り直す (RPC 側の問題かもしれないため)。巻き戻しはレシートの確認からやり直す。
  - `stop()` と `cancel()` は結果を出さず、飛んでいる呼び出しを中断する。
- **サーバー**: `ServerNetwork` の変更。
  - チケットは `issueTipTicket`。intent の返信に `ticket` を足した。
  - 報告は `onEvmTip`、結果は `onTipResult`。
  - 確定後は `tipConfirmed` (`tip` イベントと告知) と `announceTip` / `drainTipAnnouncements` (バケットとキュー)。
  - 切断時は `dropTipTickets`、停止は `stopForFatal` で `tipWatcher.stop()` と告知タイマーの解除。
  - `invalidateEvmWallet` では、見張り中でないチケットを捨てる。
  - パケットは `evmTip` (38)、`evmTipStatus` (39)。inboundPolicy に `evmTip: 160` を足した。
  - `internalEvents` に `tip` を足した。
- **クライアント**:
  - `tip()` は intent の `ticket` を検査して控え、送金後に `evmTip` を送る。戻り値に `ticket` / `reported` を足した。
  - `recheckTip` はチケットごとに 1 回だけ。
  - `getTipStatus` は、状態をチケットごとに最大 32 件控える。フォームが購読する前に届いた確定を失わないため。
  - TipForm の状態は「Confirming on Polygon…」「Confirmed on chain.」「Not counted: …」「Sent, but not confirmed: …」。待ちは最大 6 分で、「Check again」は 1 回だけ。
- **テスト**:
  - ユニット 1299 件。新しく `evmTipWatcher` を 9 件、`serverEvmWallet` に P2b の 12 件を足し、`evmRpc` / `evmTips` / `evmClient` / `packets` / `inboundPolicy` / `evmGating` / `inboundNetwork` を更新した。
  - e2e `evm-tips-gate.mjs` の偽 RPC が、レシート・ブロック・確定ブロックを返すようにした。新しい手順「確定 → 第三者への告知 → `tip` イベント (凍結、アドレス・tx ハッシュなし)」を足した。プローブ app は `test/e2e/apps/tip-listener.js`。
- **docs**: World.md (`tip`)、README の Tips、CHANGELOG、`.env.example`。

## 13. コードレビュー (Codex GPT-6 Astra xhigh, 2026-11-08)

Blocker なし。Major 3 件・Minor 2 件で、すべて直した。§11 の決定のうち、次の2つはここで改めた。
- B-2 で入れた「同じ txHash を見張るチケットは 2 件まで」を廃止した (下の 2)。
- 「検証が変わったら未使用のチケットを捨てる」をやめた (下の 3)。

1. **Major: 予算の枠の取り合いで、後ろのジョブが一度も確認されない。**
   - 原因: 予算切れのジョブが通常の間隔で再試行されるため、各ジョブの周期が揃い、毎回同じ先頭のジョブが枠を取っていた。
   - 修正:
     - 予算切れは確認の間隔を進めず、次の周期 (1 秒後) に回す。
     - 期日が来たジョブは、最後に RPC を呼べた時刻の古い順に呼ぶ。
   - テスト: 既定の予算で 5 件を見張り、5 件目だけが採掘済みの場合に確定することを確かめた。修正前のコードでは失敗することも確認した。
2. **Major: 他人の 2 件の報告で、同じ txHash の枠が埋まる。** 本人の報告が `busy` になり、1 回きりの再提出まで使い切ってしまう。
   - 修正: 同じ txHash ごとの上限をなくした。上限はソケットあたり 2 件・全体で 16 件のまま。
   - 他人の見張りは、チケットの `from` (その報告者) がログの `topics[1]` と合わないので確定しない。
3. **Major: 送金中のアカウント切替で、送ったチケットが消える。** クライアントは `revokeEvmWallet` を `evmTip` より先に送る。サーバーは取り下げで未使用のチケットを捨てていたため、本当の送金が `unknown_ticket` で弾かれていた。
   - 修正:
     - 取り下げではチケットを捨てない。チケットの `from` は、発行時にこの接続で検証済みのアドレスで固定されている。
     - `onEvmTip` は今の検証状態を問わない。確定は、その `from` のログでしか起きない。
     - チケットは寿命 (10 分) と件数 (3 件) で消える。
   - テスト: サーバーで「取り下げ → 報告」の順でも見張りに入ること、クライアントで送信中の切替でも取り下げの後に報告が出ることを確かめた。
4. **Minor: `finalized` が一時的に null を返すと、未対応と誤判定して 60 秒止まる。**
   - 修正: null は通常の失敗として、確定待ちの間隔 (3 秒) で再試行する。未対応とするのは、`RpcError` と、number の無い非 null のブロックだけ。
   - テスト: null の後に回復すること。
5. **Minor: 停止時に、共有の確定ブロックの取得が中断されない。**
   - 修正: 飛んでいるすべての呼び出しを監視全体の集合で持ち、`stop()` で中断する。
   - テスト: 確定ブロックの取得中に停止すること。

修正差分の確認 (Codex): 5 件とも FIXED、リグレッションなし。
最終監査 (メインセッション): 監視・サーバー・フォームを通読した。
結果: ユニット 1304/1304、lint エラー 0、e2e は evm-tips-gate 7/7 (Chromium・WebKit)、evm-wallet 8/8、token-gate 10/10。
