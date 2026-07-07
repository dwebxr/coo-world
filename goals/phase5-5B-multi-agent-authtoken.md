# Goal 5B — multi-agent authToken 分離

**Phase 5 (AI 基盤) | 実装: Sonnet | Risk: 低 | Effort: M | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
複数の node-client エージェントを同一マシンで同時起動すると、共有の `localstorage.json` (単一 authToken) を奪い合い、サーバが2体目を `duplicate_user` で kick する (finding 6.2/agent.mjs の既知 TODO)。authToken をインスタンスごとに分離できるようにする。

## 対象ファイル (単独所有)
- `src/core/systems/ClientNetwork.js` (**注意: Phase 2D も ClientNetwork の onSnapshot 1行を触ったが 2D は前フェーズで完了済み。あなたは init の authToken 経路のみ、~3行の純加算**)
- (`agent.mjs` は 5A が所有。5B は ClientNetwork の API を用意するだけ。5A がそれを使う。両者の連携点は authToken オプション名で合意)

## やること (finding 6.2)

### ClientNetwork.init に optional authToken を通す
現状 `ClientNetwork.js:28` が `storage.get('authToken')` (`storage.js` の singleton `localstorage.json`) を無条件参照し、`:145` で `storage.set('authToken', ...)` する。
- `ClientNetwork.init` の分割代入オプション (`:27`) に optional `authToken` を追加。
- 与えられたら `storage.get('authToken')` の代わりにそれを使う。
- caller 供給の場合は無条件 `storage.set('authToken', ...)` (`:145`) を**スキップ** (singleton を汚さない)。
- **純粋に additive**: authToken オプション未指定時 (ブラウザ/単一エージェント) の挙動は完全不変。

これにより 5A の agent.mjs は `AGENT_ID` から導出した per-instance token を渡せ、N 体が同一マシンで共存できる。

## やらないこと
- `storage.js` (NodeStorage) の本体を変えない (upstream 影響を最小化。init 経由のオーバーライドで解決)。
- onSnapshot 等 2D が触った箇所を変えない。
- agent.mjs は触らない (5A 所有)。

## 検証手順
- `npm run build && npm run node-client:build` 成功、`npm run lint` 悪化なし。
- 後方互換: authToken オプションを渡さない通常の client/agent 起動が従来通り接続すること。
- (5A と統合後) `AGENT_ID=a node agent.mjs` と `AGENT_ID=b node agent.mjs` を同時起動し両方 `ready` に到達・同時接続維持 (duplicate_user kick が起きないこと)。
