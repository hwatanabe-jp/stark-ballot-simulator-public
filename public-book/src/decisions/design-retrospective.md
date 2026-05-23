# 設計ふりかえり

本章は、実装・運用を経て見えた構造課題と、制約が見えた後に整理し直した設計判断を記録します。

## 記録方針

各項目は背景 / 知見 / 改善候補の 3 軸で記述します。改善候補は確定計画ではなく、ふりかえりを通じて見えた検討中の選択肢です。

項目はカテゴリ A / B に分けて並べます。

| カテゴリ | 意味                                 |
| -------- | ------------------------------------ |
| A        | 実装を通じて今も残る構造的課題       |
| B        | 制約が見えた後に整理し直した設計判断 |

## 知見の全体像

| #   | 項目                                          | カテゴリ              |
| --- | --------------------------------------------- | --------------------- |
| 1   | Store インターフェースの肥大化                | A. 永続化層           |
| 2   | SessionData の責務混在                        | A. 型設計             |
| 3   | 設定の組み合わせ爆発                          | A. 構成管理           |
| 4   | Verified 判定ロジックの分散                   | A. 検証パイプライン   |
| 5   | 検証ドメインへの I/O 混入                     | A. アーキテクチャ境界 |
| 6   | Amplify 単独構成からハイブリッド構成への移行  | B. クラウド境界       |
| 7   | Terraform root module と lifecycle の分離不足 | B. IaC 運用           |
| 8   | proof-bound authority と表示用 cache の分離   | B. 型・データ権威     |
| 9   | 公開可能 artifact の allowlist 化             | B. セキュリティ境界   |

---

## A. 実装を通じて残る構造的課題

### 1. Store インターフェースの肥大化

#### 背景

`VoteStore` インターフェース（`src/types/voteStore.ts`）は 19 メソッド（うち optional 3）を持ち、3 つの大きな実装（Mock / FileMock / Amplify）が存在します。

#### 知見

セッション管理・投票操作・ファイナライズ状態遷移・成果物保存の 4 責務が 1 インターフェースに混在しています。特にファイナライズ状態遷移の 5 メソッド（`markFinalizationQueued` 〜 `markFinalizationTimedOut`）は全実装で類似のバリデーションロジックを個別に持ちます。

#### 改善候補

インターフェース分離原則（ISP）を適用し、Session / Vote / FinalizationState / Artifact の 4 インターフェースに分ける案が考えられます。さらに「永続化 I/O」と「状態遷移ポリシー」を分離し、ファイナライズ状態遷移を共通のステートマシンとして抽出できれば、各 Store は永続化に集中しやすくなります。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

---

### 2. SessionData の責務混在

#### 背景

`SessionData` 型（`src/types/server.ts`）は 20 フィールド（うち 14 が optional）を持ちます。ネストされた `finalizationResult` だけで 30 サブフィールドを含みます。

#### 知見

永続データ（`sessionId`、`electionId`）、実行時状態（`votes`、`bulletin`、`lastActivity`）、検証結果（`finalizationResult`、`finalizationState`）が 1 型に同居しています。optional フィールドが 14 ある事実は、「ライフサイクルの各段階で存在するはずだが、型では保証されないフィールド」が多いことを意味します。

#### 改善候補

Session（最小の identity）、VoteLog（append-only の投票記録）、FinalizationJob（非同期ジョブの状態）、VerificationArtifact（検証結果と成果物）に型を分ける案が考えられます。各段階で必要なフィールドを required として扱える構造に寄せることで、ライフサイクル上の前提を型で表しやすくなります。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

---

### 3. 設定の組み合わせ爆発

#### 背景

`.env.local.example` に 57 変数が定義されており、`USE_MOCK_ZKVM`、`RISC0_DEV_MODE`、`FINALIZE_ASYNC_MODE` などの切り替えフラグが独立して存在します。

#### 知見

問題の本質は変数の数ではなく「プロファイル化されていない構成契約」です。Amplify / Terraform / Hono / S3 / zkVM の境界をまたいで個別フラグが増え、フラグの組み合わせによって意図が曖昧になる状態が生まれます（例: `USE_MOCK_ZKVM=true` と `RISC0_DEV_MODE=1` の同時有効）。`zkvm-mode.ts` で production 時の不正モードは検出できますが、起動時に全組み合わせを網羅的に検証していません。

#### 改善候補

プロファイルベースの設定体系（`local` / `dev` / `staging` / `prod`）を導入し、個別フラグを段階的に減らす案が考えられます。プロファイルが各フラグの値を決め、シークレットのみを環境変数として残す形に寄せられれば、起動時バリデーションで無効な組み合わせを fail-fast に検出しやすくなります。

---

### 4. Verified 判定ロジックの分散

#### 背景

「Verified を表示してよいか」の判定ロジックが複数箇所に分散しています。主系は `verification-summary.ts` の `deriveVerificationSummary`（チェック群から総合判定）と `page.tsx` の `overallStatusOverride`（UI 表示制御）で、補助系として `consistency-verifier.ts` の `validateVotingIntegrity` がフォールバック経路を持ちます。さらに `verify.ts` ハンドラにも `verificationStatus` の許可ステータス判定が存在します。

#### 知見

判定基準の責務境界が明確ではなく、チェック評価（engine）、総合判定（summary）、最終表示 override（UI）、API レスポンス、第三者検証、bundle 監査が同じ判定根拠を別々に参照しています。フォールバック経路（`integrityStatus`）も残るため、仕様の二重管理が起きやすい状態です。

#### 改善候補

`VerificationPolicy` のような単一モジュールに「Verified を出す条件」を集約する案が考えられます。API、UI、CLI、第三者検証、bundle 監査が同じ判定根拠を参照できれば、判定基準の分散を減らせます。

詳細: [ゲーティングロジック](../verification/gating-logic.md)

---

### 5. 検証ドメインへの I/O 混入

#### 背景

`consistency-verifier.ts` は検証ドメインロジックを担いますが、内部で `fetch()` を直接呼び出しています（整合性証明の取得および STH の第三者検証）。

#### 知見

ドメインロジックが HTTP 可用性に依存し、テストではモックが必須になります。また、fetch 失敗時のエラー伝播が暗黙的で、呼び出し元の `useVerificationPipeline` は例外を捕捉して状態を null にするのみです。本プロジェクトの方針「ドメイン層は Result パターン、境界でのみ例外捕捉」に反します。

#### 改善候補

検証関数を純関数に寄せ、必要なデータ（整合性証明、STH レスポンス等）を全て引数で受け取る構造が候補になります。I/O をアプリケーション層（hooks または handler）の adapter に移せれば、ドメイン層を HTTP 非依存かつ fixture テストしやすい状態にできます。エラーも Result 型で明示伝播させる余地があります。

詳細: [検証パイプライン](../verification/index.md)

---

## B. 後から見えた設計判断

### 6. Amplify 単独構成からハイブリッド構成への移行

#### 背景

当初は Amplify Gen 2 のみで Web、API、データ、認証、証明生成まわりまで完結できると想定していました。しかし STARK 証明生成は 16 vCPU / 32 GB で約 6 分を要し、Lambda の 60 秒タイムアウトには載りません。実装が進むにつれて ECS Fargate、Step Functions、SQS、ECR、イメージ署名、S3 artifact 配布を組み合わせた非同期実行基盤が必要になり、結果として Terraform 管理の領域を後追いで切り出しました。

#### 知見

境界を後から切ったことで、Terraform → Amplify への環境変数同期（SFN ARN、SQS ARN、SQS URL、S3 bucket 名）と、Amplify → Terraform への callback Lambda ARN 注入という双方向の手動同期契約が残りました。動作はしますが、デプロイ順序、設定ドリフト、Amplify branch override の実効値確認といった運用負荷を生みます。

#### 改善候補

今後この構成を発展させるなら、Amplify と Terraform の境界を整理するだけでなく、Amplify 依存を段階的に下げ、最終的には Web / API / データ / 非同期プローバー基盤を一貫した IaC とデプロイフローで管理する案が考えられます。

- 短期的には Terraform output と Amplify environment の対応表を contract として生成可能にする
- 必須 ARN や bucket 名が欠落した場合に deploy 時点で検出できるようにする
- 手動同期が残る値を runbook と CI check の確認対象にする
- 中長期的には Amplify 管理領域を別の IaC / hosting / API 実行基盤へ移す選択肢を検討する
- SSM Parameter Store などを介した参照に寄せ、コピー & ペーストの同期点を減らす

cross-ref: [現行構成とサービス一覧](../aws/design-and-services.md)

---

### 7. Terraform root module と lifecycle の分離不足

#### 背景

現行構成では、`develop` と `main` を Terraform workspace と git 管理外の `*.local.tfvars` の組み合わせで分離しています。S3 remote backend は named workspace ごとに state path と lockfile path が分かれますが、同じ backend bucket と root module を共有しているため、長期運用には粒度不足が残ります。

一方で、bootstrap（state bucket・共通 IAM）、共有リソース（RISC Zero toolchain ECR、共有 CodeBuild、署名プロファイル）、環境別 prover runtime（ECS / Step Functions / SQS / S3 / CloudWatch）が同じ root module 内に同居しています。

#### 知見

PoC としては workspace 分離と `terraform-guarded.sh` の principal guard で取り違えは抑止できましたが、長期運用には粒度不足です。root module を共有してしまうと、共有リソースの変更が環境別 plan/apply の影響範囲に紛れ込み、ライフサイクル・アクセス制御・レビュー粒度を分けるのが難しくなります。

#### 改善候補

長期運用を前提にするなら、Terraform を以下のような 3 階層に分ける案が考えられます。

```text
terraform/
  bootstrap/        # state bucket、lock、共通 IAM
  shared/           # toolchain ECR、共有 CodeBuild、signing profile
  envs/develop/     # develop の prover runtime（ECS / SFN / SQS / S3 / CloudWatch）
  envs/main/        # main の prover runtime
```

このように分けられれば、環境ごとの plan/apply の影響範囲を小さくし、`main` と `develop` のアクセス制御、レビュー粒度、ロールバック判断を分離しやすくなります。

cross-ref: [Terraform](../aws/terraform.md)

---

### 8. proof-bound authority と表示用 cache の分離

#### 背景

検証パイプラインで扱う情報には、`journal`、`public-input.json`、`election-manifest.json`、`close-statement.json` のように証明に束縛された権威データと、UI 表示用の `tally` や `tamperDetected` のように派生値として組み立てた表示 cache が混在します。

#### 知見

これらを同列に扱うと「画面では正しそうに見えるが、検証側では根拠が示せない」状態を作りやすくなります。データの権威性は型レベルで区別すべきで、UI が表示 cache を消費する経路と、検証エンジンが authority を消費する経路は別であるべきです。

#### 改善候補

authority と presentation cache を別の型として扱う案が考えられます。UI → authority への参照を一方向に保ち、表示用派生値を authority から純関数で導出した結果として扱えれば、画面状態のために authority を書き換えるリスクを減らせます。

cross-ref: [4 段階検証モデル](../verification/four-stage-model.md), [入力コミットメント](../protocol/input-commitment.md)

---

### 9. 公開可能 artifact の allowlist 化

#### 背景

検証用に配布する `bundle.zip` には、`receipt.json`、`journal.json`、`public-input.json`、`election-manifest.json`、`close-statement.json` を含めます。一方、`input.json`（証拠）、`verification.json`（検証レポート）、`included-bitmap.json`、`seen-bitmap.json` は公開対象外です。

#### 知見

セキュリティ設計として重要なのは「秘密を隠すこと」だけではなく、「第三者検証に必要な最小限を allowlist として明示的に公開する」設計です。non-public artifact を都度判断するブロックリスト方式では、新しい artifact を追加した時に取りこぼしが起きます。

#### 改善候補

`bundle.zip` の内容は明示的な allowlist として 1 箇所で管理するのが望ましい方向です。生成側（sync の `verification-bundle.ts`、async の `docker/entrypoint.sh`）と配信側（`verificationBundles.ts`）の 3 点を契約として照合できれば、新しい artifact を追加した時の取りこぼしを減らせます。詳細仕様と allowlist は [バンドル構造](../verification/bundle-structure.md) に集約しています。

<!-- source: src/types/voteStore.ts, src/types/server.ts, .env.local.example, src/lib/env/validate.ts, src/lib/zkvm/zkvm-mode.ts, src/lib/verification/consistency-verifier.ts, src/lib/verification/verification-summary.ts, src/lib/verification/verification-bundle.ts, src/app/(routes)/verify/page.tsx, src/app/(routes)/verify/hooks/useVerificationPipeline.ts, amplify/, terraform/, docker/entrypoint.sh -->
