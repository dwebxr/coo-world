# 共通コンテキスト (全ゴールファイル共通・必読)

このリポジトリ `coo-world` は `hyperfy-xyz/hyperfy` (3D web world エンジン, 純 JS ES modules, TypeScript 不使用, esbuild, React系 client UI) のフォークです。あなたは1つのゴールファイルを割り当てられた実装エージェントです。以下の制約を**厳守**してください。

## 絶対の禁止事項
1. **ベンダーコードに触れない**: `src/core/physx-js-webidl.js`, `src/core/libs/**` (three-vrm, gltfloader, csm, stats-gl 等) は一切編集しない。
2. **自分のゴールファイルの「対象ファイル」以外を編集しない**。他タスクと並列実行されるため、範囲外ファイルを触ると競合する。範囲外に問題を見つけたら**報告のみ**して修正しない。
3. **スコープ外の大規模改変をしない** (将来の upstream マージを壊すため意図的に見送り中):
   - `getProxy()` 定型 2192行の共有ヘルパ化 (nodes/*)
   - setter 前置き ~253箇所の共通化
   - `ClientBuilder.update()` 427行関数の分割
   - `Sidebar.js` 1904行のディレクトリ分割
   - blueprint/app-entity リテラルの全 factory 化 (実バグ修正のみ許可されるタスクは別途明記)
4. **外部から観測可能な挙動を変えない**。バグ修正・デッドコード除去・重複統合はいずれも「同じ入力に同じ結果」を保つ。挙動変更が必要な設計判断が出たら実装せず報告する。

## コーディング規約
- 既存のコードスタイル・命名・インデントに合わせる。`.prettierrc` / `.eslintrc` に従う。
- コメントは既存の密度・言語に合わせる (このリポは日本語コメントが混在するファイルあり)。冗長な「何をしたか」コメントは書かない。
- import は既存の相対パス慣習に合わせる (例: `import * as THREE from '../extras/three'`)。

## 検証 (テストは Phase 0 で導入。それ以前は lint + build + 起動スモークのみ)
- `npm run lint` — 自分が触ったファイルのエラーを**増やさない** (できれば減らす)。
- `npm run build` — server ビルド。UI/client を触ったら `npm run client:build`、viewer は `npm run viewer:build`、node-client 経路は `npm run node-client:build` も確認。
- 起動スモーク: `node build/index.js` が起動すること。
- 各ゴールファイルの「検証手順」に従い、該当機能が壊れていないことを確認。

## 完了報告フォーマット
実装後、以下を簡潔に報告 (これがあなたの最終出力=機械可読):
- `changed_files`: 実際に編集/作成/削除したファイル一覧
- `summary`: 各 finding をどう直したか (file:line)
- `verification`: 実行した lint/build/smoke の結果 (成否と要点)
- `deviations`: 計画と違えた点・範囲外で気づいた問題 (あれば)
