# coo-world リファクタ ゴールファイル索引

各ファイルは1タスク=1並列実装単位。まず `_CONTEXT.md` (共通制約) を読むこと。
フェーズは**逐次** (前フェーズの監査通過後に次へ)。フェーズ内タスクは**ファイル非重複で並列実装**。
全体設計は `../REFACTOR_PLAN.md`。

| Phase | Task | ファイル | 実装 | 概要 |
|---|---|---|---|---|
| 0 | 0A | phase0-0A-eslint-repair.md | Sonnet | eslint globals/overrides、lint スコープ拡張、ai.js パースエラー |
| 0 | 0B | phase0-0B-test-harness.md | Sonnet | node:test 導入、utils/packets/ranks テスト |
| 0 | 0C | phase0-0C-ci-gate.md | Sonnet | GitHub Actions で lint+build4種+test |
| 1 | 1A | phase1-1A-solana-security.md | **Fable** | トークンゲーティング再設計 (署名nonce+サーバ残高検証)、client 堅牢化、feature-flag |
| 1 | 1B | phase1-1B-docker-env-leak.md | Sonnet | .dockerignore に .env、鍵ローテ報告 |
| 2 | 2A | phase2-2A-nodes-yoga-bugs.md | Sonnet | flexWrap再帰/rturn/Yoga enum/validator |
| 2 | 2B | phase2-2B-client-ui-bugs.md | Sonnet | AppModelBtn/NodeHierarchy/particles クラッシュ |
| 2 | 2C | phase2-2C-server-entity-bugs.md | Sonnet | autosave停止/Chat createdAt/ReferenceError/guard/hasOwnProperty/frozen |
| 2 | 2D | phase2-2D-ai-path-crashes.md | Sonnet | node-client import crash / onSnapshot ai.deserialize |
| 2 | 2E | phase2-2E-extras-misc-bugs.md | Sonnet | downloadFile revoke / simulateButton text / 未使用import |
| 3 | 3A | phase3-3A-ui-dead-code.md | Sonnet | Menu/Inputs 削除 + CoreUI/Sidebar コメント除去 |
| 3 | 3B | phase3-3B-core-dead-code.md | Sonnet | Entities.removed / 未使用import / octree debug |
| 3 | 3C | phase3-3C-lint-to-zero.md | Sonnet | 残存 lint error ~41 (no-var/async-executor/getter-return 等) をゼロに |
| 4 | 4A | phase4-4A-network-dispatch-dedup.md | Sonnet | enqueue/flush + builder-check dedup |
| 4 | 4B | phase4-4B-player-dedup.md | Sonnet | Modes/認可/aura/App proxy dedup |
| 4 | 4C | phase4-4C-client-dedup.md | Sonnet | XR gamepad/video prepare/loader result dedup |
| 4 | 4D | phase4-4D-small-dedup-hygiene.md | Sonnet | Fields/hint/buttons/assets/lodash-es/esbuild plugin |
| 5 | 5A | phase5-5A-agent-runtime.md | **Fable** | agent.mjs runtime化 (再接続/perceive-decide-act) |
| 5 | 5B | phase5-5B-multi-agent-authtoken.md | Sonnet | ClientNetwork.init に authToken オプション |

## スコープ外 (意図的見送り・高マージコスト)
getProxy 2192行 / setter 253箇所 / ClientBuilder.update 分割 / Sidebar 分割 / blueprint 全factory化。詳細は REFACTOR_PLAN.md。
