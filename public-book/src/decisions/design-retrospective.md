# 設計ふりかえり

構築を通じて得た構造上の知見を記録します。

「PoC の制約」が意図的な割り切りを扱うのに対し、本章は実装・運用を経て見えた改善余地を共有します。

## 記録方針

各項目は「背景（現状の構造とその成立経緯）」「知見（構築・運用を経て見えた課題）」「改善方針（次のフェーズで取りうるアプローチ）」の 3 軸で記述します。

## 知見の全体像

| #   | 項目                           | カテゴリ           |
| --- | ------------------------------ | ------------------ |
| 1   | Store インターフェースの肥大化 | 永続化層           |
| 2   | SessionData の責務混在         | 型設計             |
| 3   | 設定の組み合わせ爆発           | 構成管理           |
| 4   | Verified 判定ロジックの分散    | 検証パイプライン   |
| 5   | `/api/verify` の責務過多       | API 設計           |
| 6   | 検証ドメインへの I/O 混入      | アーキテクチャ境界 |
| 7   | Silent fallback の危険性       | 起動・初期化       |

---

## 1. Store インターフェースの肥大化

### 背景

`VoteStore` インターフェースは 15 メソッド（+ optional 4）を持ち、3 つの大きな実装（Mock / FileMock / Amplify）が存在する。

### 知見

セッション管理・投票操作・ファイナライズ状態遷移・成果物保存の 4 責務が 1 インターフェースに混在している。特にファイナライズ状態遷移の 5 メソッド（`markFinalizationQueued` 〜 `markFinalizationTimedOut`）は全実装で類似のバリデーションロジックを個別に持つ。

### 改善方針

インターフェース分離原則（ISP）を適用し、Session / Vote / FinalizationState / Artifact の 4 インターフェースに分割する。ファイナライズ状態遷移は共通のステートマシンとして抽出し、各 Store が永続化のみを担う構造にする。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

---

## 2. SessionData の責務混在

### 背景

`SessionData` 型は 16 フィールド（うち 9 が optional）を持つ。ネストされた `finalizationResult` だけで 30 サブフィールドを含む。

### 知見

永続データ（`sessionId`、`electionId`）、実行時状態（`votes`、`bulletin`、`lastActivity`）、検証結果（`finalizationResult`、`finalizationState`）が 1 型に同居している。optional フィールドの多さは、ライフサイクルの各段階で「存在するはずだが型で保証されない」フィールドがあることを意味する。

### 改善方針

Session（最小の identity）、VoteLog（append-only の投票記録）、FinalizationJob（非同期ジョブの状態）、VerificationArtifact（検証結果と成果物）に型を分割する。各段階で必要なフィールドを required として型安全に扱う。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

---

## 3. 設定の組み合わせ爆発

### 背景

`.env.local.example` に 62 変数が定義されている。`USE_MOCK_ZKVM`、`RISC0_DEV_MODE`、`FINALIZE_ASYNC_MODE` などの切り替えフラグが独立して存在する。

### 知見

フラグの組み合わせによって意図が曖昧になる状態が生じうる（例: `USE_MOCK_ZKVM=true` と `RISC0_DEV_MODE=1` の同時有効）。`zkvm-mode.ts` で production 時の不正モードは検出できるが、起動時に全組み合わせを網羅的に検証していない。

### 改善方針

プロファイルベースの設定体系（`local` / `dev` / `staging` / `prod`）を導入し、個別フラグを廃止する。プロファイルが各フラグの値を暗黙的に決定し、シークレットのみを環境変数として残す。起動時バリデーションで無効な組み合わせを fail-fast で検出する。

---

## 4. Verified 判定ロジックの分散

### 背景

「Verified を表示してよいか」の判定ロジックが複数箇所に分散している。主系は `verification-summary.ts` の `deriveVerificationSummary`（チェック群から総合判定）と `page.tsx` の `overallStatusOverride`（UI 表示制御）で、補助系として `consistency-verifier.ts` の `validateVotingIntegrity` がフォールバック経路を持つ。さらに `verify.ts` ハンドラにも `verificationStatus` の許可ステータス判定が存在する。

### 知見

判定基準の責務境界が明確でない。チェック評価（engine）、総合判定（summary）、最終表示 override（UI）が別々に進化しており、仕様変更時に複数モジュールを同時修正する必要がある。フォールバック経路（`integrityStatus`）も残っているため、仕様の二重管理が起きやすい。

### 改善方針

VerificationPolicy を単一モジュールに集約し、「Verified を出す条件」を 1 箇所で定義する。API と UI の双方がこのモジュールを参照する構造にし、判定基準の分散を解消する。

詳細: [ゲーティングロジック](../verification/gating-logic.md)

---

## 5. `/api/verify` の責務過多

### 背景

`verify.ts` ハンドラは 600 行超で、単一の GET エンドポイントとしては大きい。

### 知見

セッション検証、`finalizationResult` からの 20 以上のフィールド抽出と正規化（143 行）、S3 メタデータの条件付きリフレッシュ、検証ステップの生成、改ざん検出状態の計算、レスポンスの組み立てが 1 ハンドラに集中している。

### 改善方針

Command/Query 分離を適用する。データ取得と正規化を `/api/verification/snapshot`（Query）、判定実行を `/api/verification/evaluate` に分離し、各ハンドラの責務を限定する。

詳細: [エンドポイント一覧](../api/endpoints.md)

---

## 6. 検証ドメインへの I/O 混入

### 背景

`consistency-verifier.ts` は検証ドメインロジックを担うが、内部で `fetch()` を直接呼び出している（整合性証明の取得および STH の第三者検証）。

### 知見

ドメインロジックが HTTP 可用性に依存しており、テストではモックが必須になる。また、fetch 失敗時のエラー伝播が暗黙的で、呼び出し元の `useVerificationPipeline` は例外を捕捉して状態を null にするのみである。本プロジェクトの方針「ドメイン層は Result パターン、境界でのみ例外捕捉」に反する。

### 改善方針

検証関数を純関数化し、必要なデータ（整合性証明、STH レスポンス等）を全て引数で受け取る構造にする。I/O はアプリケーション層（hooks または handler）に移動し、ドメイン層を HTTP 非依存にする。

詳細: [検証パイプライン](../verification/index.md)

---

## 7. Silent fallback の危険性

### 背景

`storeInstance.ts` では `AmplifySessionStore` の初期化が `try/catch` で囲まれており、失敗時に `MockSessionStore` へフォールバックする。

### 知見

`catch` が全例外を捕捉し、`logger.warn` でログを出力するのみで処理を継続する。デプロイ環境で Amplify エンドポイントの誤設定があった場合、インメモリ Store で動作し、セッション消失やデータ不整合が表面化しにくくなる。

### 改善方針

テスト環境以外では fail-fast（例外の再送出）を原則とする。`validate.ts` の起動時バリデーションと組み合わせた二重防御とし、silent な品質劣化を防止する。

<!-- source: src/types/voteStore.ts, src/lib/store/mockSessionStore.ts, src/lib/store/fileMockSessionStore.ts, src/lib/store/amplifySessionStore.ts, src/types/server.ts, .env.local.example, src/lib/env/validate.ts, src/lib/zkvm/zkvm-mode.ts, src/lib/verification/consistency-verifier.ts, src/lib/verification/verification-summary.ts, src/server/api/handlers/verify.ts, src/app/(routes)/verify/page.tsx, src/app/(routes)/verify/hooks/useVerificationPipeline.ts, src/lib/store/storeInstance.ts -->
