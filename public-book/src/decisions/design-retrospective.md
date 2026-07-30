# 設計ふりかえり

本章は、実装と運用を経て見えた構造課題と、制約が見えた後に整理し直した設計判断を記録します。

## 記録方針

各項目は、背景、知見、改善候補の 3 軸で記述します。
改善候補は確定計画ではなく、ふりかえりを通じて見えた検討中の選択肢です。

項目はカテゴリ A とカテゴリ B に分けて並べます。

| カテゴリ | 意味                                 |
| -------- | ------------------------------------ |
| A        | 実装を通じて今も残る構造的課題       |
| B        | 制約が見えた後に整理し直した設計判断 |

## 知見の全体像

| #   | 項目                                          | カテゴリ              |
| --- | --------------------------------------------- | --------------------- |
| 1   | Store 境界の分離途上                          | A. 永続化層           |
| 2   | SessionData の責務混在                        | A. 型設計             |
| 3   | 設定の組み合わせ爆発                          | A. 構成管理           |
| 4   | Verified 判定ロジックの分散                   | A. 検証パイプライン   |
| 5   | 検証ドメインと runtime adapter 境界           | A. アーキテクチャ境界 |
| 6   | Amplify 単独構成からハイブリッド構成への移行  | B. クラウド境界       |
| 7   | Terraform root module と lifecycle の分離不足 | B. IaC 運用           |
| 8   | proof-bound authority と表示用 cache の分離   | B. 型とデータ権威     |
| 9   | 公開可能 artifact の allowlist 化             | B. セキュリティ境界   |

## A. 実装を通じて残る構造的課題

### 1. Store 境界の分離途上

#### 背景

`VoteStore` インターフェース（`packages/domain/src/types/voteStore.ts`）は、現在はセッションと投票の最小操作に寄せられ、10 メソッドを持ちます。
optional なメソッドは軽量な ポーリング用の `getSessionSummary` だけです。
非同期 finalization の状態遷移は、`packages/application/src/finalize/finalization-store.ts` の `FinalizationLifecycleStore` / `FinalizationStore` 側に分離されています。
永続化実装は Mock、FileMock、DynamoDB の 3 種類です。

#### 知見

以前は 1 つの store 境界に、セッション管理、投票操作、finalization 状態遷移、成果物保存の責務が混在していました。
現在はインターフェース分離が進み、domain 側の `VoteStore` は vote/session の基本契約に縮小されています。
一方で、実体としての store 実装は引き続き vote/session 永続化と finalization persistence の両方を担い、`markFinalizationQueued` 〜 `markFinalizationTimedOut` の状態遷移や fail-closed artifact guard を実装ごとに扱っています。
そのため、抽象境界は改善したものの、永続化 I/O と状態遷移ポリシーの分離はまだ途上です。

#### 改善候補

現行の分離をさらに進め、Session/Vote の永続化、Finalization lifecycle、Artifact metadata/bitmap persistence を実装境界でも明確に分ける案が考えられます。
特に「永続化 I/O」と「状態遷移ポリシー」を分離し、finalization 状態遷移を共通のステートマシンとして抽出できれば、各 Store は永続化に集中しやすくなります。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

### 2. SessionData の責務混在

#### 背景

`SessionData` 型（`packages/domain/src/types/server.ts`）は 20 フィールドを持ち、そのうち 14 フィールドは optional です。
現在の domain 型では、`finalizationResult` と `finalizationState` は opaque な persistence branch として扱われ、詳細な authority / delivery metadata の形は application 層と AWS adapter 層で admit / parse されます。

#### 知見

`SessionData` には、永続データ（`sessionId`、`electionId`）、実行時状態（`votes`、`bulletin`、`lastActivity`）、finalization artifact branch（`finalizationResult`、`finalizationState`）が同居しています。
optional フィールドが 14 あることは、「ライフサイクルの各段階で存在するはずだが、型では保証されないフィールド」が多いことを意味します。
opaque branch により domain 型が AWS 固有の詳細形を直接所有しない境界は改善されましたが、セッション identity、投票ログ、finalization 状態、verification artifact の lifecycle はまだ 1 つの session aggregate に集約されています。

#### 改善候補

Session（最小の identity）、VoteLog（append-only の投票記録）、FinalizationJob（非同期ジョブの状態）、VerificationArtifact（検証結果と成果物）に型を分ける案が考えられます。
各段階で必要なフィールドを required として扱える構造に寄せることで、ライフサイクル上の前提を型で表しやすくなります。

詳細: [セッションライフサイクル](../api/session-lifecycle.md)

### 3. 設定の組み合わせ爆発

#### 背景

`.env.local.example` には、ローカル実行用の active assignment だけでなく、deployed API、DynamoDB、S3、SQS、Step Functions、Lambda、Terraform handoff 用のコメント付きテンプレート値も多数含まれます。
`USE_MOCK_ZKVM`、`RISC0_DEV_MODE`、`FINALIZE_ASYNC_MODE`、`TARGET_AWS_RUNTIME` などの切り替えフラグも独立して存在します。

#### 知見

問題の本質は変数の数ではなく、「プロファイル化されていない構成契約」です。
フロントエンド、API、永続化、非同期証明パイプライン、zkVM の境界をまたいで個別フラグが増えると、フラグの組み合わせによって実行意図が曖昧になります。
たとえば、`USE_MOCK_ZKVM=true` と `RISC0_DEV_MODE=1` が同時に有効な状態です。
`zkvm-mode.ts` や `packages/runtime-config/src/env/validate.ts` で production / target runtime 時の不正モードは検出できますが、すべてのローカル・テスト・target 組み合わせが profile として宣言されているわけではありません。

#### 改善候補

プロファイルベースの設定体系（`local` / `dev` / `staging` / `prod`）を導入し、個別フラグを段階的に減らす案が考えられます。
プロファイルが各フラグの値を決め、シークレットのみを環境変数として残す形に寄せられれば、起動時バリデーションで無効な組み合わせを fail-fast に検出しやすくなります。

### 4. Verified 判定ロジックの分散

#### 背景

「Verified を表示してよいか」の判定ロジックは複数箇所に分散しています。
主系は `verification-summary.ts` の `deriveVerificationSummary`（チェック群から総合判定）と `page.tsx` の `overallStatusOverride`（UI 表示制御）です。
補助系として、`consistency-verifier.ts` の `validateVotingIntegrity` がフォールバック経路を持ちます。
さらに、`verify.ts` ハンドラにも `verificationStatus` の許可ステータス判定が存在します。

#### 知見

判定基準の責務境界が明確ではありません。
チェック評価（engine）、総合判定（summary）、最終表示 override（UI）、API レスポンス、第三者検証、bundle 監査が同じ判定根拠を別々に参照しています。
フォールバック経路（`integrityStatus`）も残るため、仕様の二重管理が起きやすい状態です。

#### 改善候補

`VerificationPolicy` のような単一モジュールに「Verified を出す条件」を集約する案が考えられます。
API、UI、CLI、第三者検証、bundle 監査が同じ判定根拠を参照できれば、判定基準の分散を減らせます。

詳細: [ゲーティングロジック](../verification/gating-logic.md)

### 5. 検証ドメインと runtime adapter 境界

#### 背景

`consistency-verifier.ts` は検証ドメインロジックを担い、現在は `fetch()` を直接呼び出さず、整合性証明を `consistencyProofProvider` から受け取り、STH の第三者検証結果を `sthVerification` として受け取ります。
整合性証明や STH の取得 I/O は API handler や adapter 側に寄せられています。

#### 知見

provider 注入により、検証ロジックが特定の HTTP transport に直接依存する状態は解消されています。
一方で、`verifyConsistencyProof` / `validateVotingIntegrity` は async provider の失敗を検証結果に変換するため、純粋な検証計算と runtime adapter からの evidence 取得境界は完全には分離されていません。
STH verification も API 境界で解決してから engine に渡す形になっており、adapter で失敗した evidence 取得をどの検証ステータスとして表すかは引き続き重要な設計点です。

#### 改善候補

検証関数をさらに純関数に寄せ、必要な evidence（整合性証明、STH consensus result、bitmap proof 等）をすべて検証済み入力として受け取る構造が候補になります。
I/O と admission をアプリケーション層または handler の adapter に閉じ込められれば、verification package は transport 非依存かつ fixture テストしやすい状態にできます。
provider/admission エラーも Result 型で明示伝播させる余地があります。

詳細: [検証パイプライン](../verification/index.md)

## B. 制約後に整理した設計判断

### 6. Amplify 単独構成からハイブリッド構成への移行

#### 背景

この項目は、Amplify、AppSync、Next.js を現行の実行基盤として扱うものではありません。
PoC 初期には、Amplify Gen 2 を中心に Web、API、データ、認証、証明生成まわりまで完結できると想定していました。
しかし STARK 証明生成は 16 vCPU / 32 GB で約 6 分を要し、当時の 60 秒同期実行枠には載りませんでした。
実装が進むにつれて、ECS Fargate、Step Functions、SQS、ECR、イメージ署名、S3 artifact 配布を組み合わせた非同期実行基盤が必要になりました。

#### 知見

単独のアプリケーション hosting / backend フレームワークに、長時間かつ高リソースの証明生成と公開可能 artifact 管理まで載せようとすると、あとから非同期基盤を足す段階で境界が複雑になります。
旧構成では、Terraform から Amplify への環境変数同期（SFN ARN、SQS ARN、SQS URL、S3 bucket 名）と、Amplify から Terraform への callback Lambda ARN 注入が手動同期点になりました。
この双方向の同期契約により、デプロイ順序、設定ドリフト、Amplify branch override の実効値確認が運用負荷になりました。
この経験から、現在の公開設計では Vite / React Router の静的フロントエンド、Hono API、DynamoDB store、Terraform 管理の非同期証明パイプラインを分けて説明しています。

#### 改善候補

同種の構成では、初期段階から「ユーザー向け Web/API」と「長時間実行の証明生成基盤」を別 lifecycle として扱うのが望ましい方向です。
実行時に必要な参照値や信頼情報は、コピーアンドペーストの設定ではなく、IaC、SSM Parameter Store、ビルド成果物の metadata などから一貫して参照できる形に寄せると、手作業の同期点と設定ドリフトを減らせます。
必須 ARN や bucket 名の欠落は、deploy 時点の検査対象にできます。
手動同期が残る値は、runbook と CI check の確認対象にできます。

cross-ref: [現行構成とサービス一覧](../aws/design-and-services.md)

### 7. Terraform root module と lifecycle の分離不足

#### 背景

この項目は、過去の legacy/root Terraform から得た学びです。
初期の構成では、`develop` と `main` を Terraform workspace と git 管理外の `*.local.tfvars` の組み合わせで分離していました。
S3 remote backend は named workspace ごとに state path と lockfile path が分かれます。
ただし、同じ backend bucket と root module に複数の lifecycle を同居させると、長期運用には粒度不足が見えてきます。

特に、bootstrap（state bucket、lock、共通 IAM）、共有リソース（RISC Zero toolchain ECR、共有 CodeBuild、署名プロファイル）、環境別 prover runtime（ECS / Step Functions / SQS / S3 / CloudWatch）が同じ root module 内に同居すると、変更の影響範囲が読み取りにくくなります。

#### 知見

PoC としては workspace 分離と `terraform-guarded.sh` の principal guard で取り違えは抑止できました。
しかし root module を共有してしまうと、共有リソースの変更が環境別 plan/apply の影響範囲に紛れ込み、ライフサイクル、アクセス制御、レビュー粒度を分けるのが難しくなります。
現在の公開説明では、legacy/root Terraform を現行の実行基盤から切り離し、静的フロントエンド、API、DynamoDB、非同期証明パイプラインなどの runtime 責務を Terraform 管理対象として整理しています。

#### 改善候補

長期運用を前提にするなら、Terraform は lifecycle ごとに root を分け、変更の影響範囲を plan の時点で読み取れる構成に寄せるのが望ましい方向です。

```text
infra/terraform/
  bootstrap/   # state backend と deployment-control lane
  foundation/  # ECR、manifest storage、secret/config container、networking input
  app/         # frontend、API、DynamoDB、SQS/SFN/ECS、Lambda、artifact S3
  legacy/      # retained historical context（現行 runtime authority ではない）
```

このように root を分けることで、app runtime、前提リソース、deployment-control の plan/apply の影響範囲を小さくし、アクセス制御、レビュー粒度、ロールバック判断を分離しやすくなります。
現行の公開仕様では、この学びを踏まえて `app` / `foundation` / `bootstrap` / `legacy` の責務境界として整理しています。

cross-ref: [Terraform](../aws/terraform.md)

### 8. proof-bound authority と表示用 cache の分離

#### 背景

検証パイプラインで扱う情報には、`journal`、`public-input.json`、`election-manifest.json`、`close-statement.json` のように証明に束縛された権威データがあります。
一方で、UI 表示用の `tally` や `tamperDetected` のように派生値として組み立てた表示 cache もあります。

#### 知見

これらを同列に扱うと、「画面では正しそうに見えるが、検証側では根拠が示せない」状態を作りやすくなります。
データの権威性は型レベルで区別すべきであり、UI が表示 cache を消費する流れと、検証エンジンが authority を消費する流れは別であるべきです。

#### 改善候補

authority と presentation cache を別の型として扱う案が考えられます。
UI から authority への参照を一方向に保ち、表示用派生値を authority から純関数で導出した結果として扱えれば、画面状態のために authority を書き換えるリスクを減らせます。

cross-ref: [4 段階検証モデル](../verification/four-stage-model.md), [入力コミットメント](../protocol/input-commitment.md)

### 9. 公開可能 artifact の allowlist 化

#### 背景

検証用に配布する `bundle.zip` は明示的な許可リストで管理し、`input.json` や `verification.json` などの保護対象 artifact は公開対象外です（現行の許可リストと除外は [公開境界](../verification/public-boundary.md) を参照）。

#### 知見

セキュリティ設計では、「秘密を隠すこと」だけでなく、「第三者検証に必要な最小限を allowlist として明示的に公開すること」も必要です。
non-public artifact を都度判断するブロックリスト方式では、新しい artifact を追加した時に取りこぼしが起きます。

#### 改善候補

`bundle.zip` の内容は明示的な allowlist として 1 箇所で管理するのが望ましい方向です。
生成側（sync の `verification-bundle.ts`、async の `infra/docker/entrypoint.sh`）と配信側（`verificationBundles.ts`）の 3 点を契約として照合できれば、新しい artifact を追加した時の取りこぼしを減らせます。
詳細仕様と allowlist は [バンドル構造](../verification/bundle-structure.md) に集約しています。

<!-- source: packages/domain/src/types/voteStore.ts, packages/domain/src/types/server.ts, packages/domain/src/types/finalization.ts, packages/application/src/finalize/finalization-store.ts, packages/application/src/finalize/finalization-types.ts, packages/aws-adapters/src/finalize/finalizationPersistenceEnvelope.ts, .env.local.example, packages/runtime-config/src/env/validate.ts, packages/node-adapters/src/zkvm/zkvm-mode.ts, packages/verification/src/verification/consistency-verifier.ts, packages/verification/src/verification/verification-summary.ts, packages/verification/src/verification/verification-bundle.ts, apps/api/src/server/api/handlers/verify.ts, apps/web/src/routes/verify/page.tsx, apps/web/src/routes/verify/hooks/useVerificationData.ts, apps/web/src/routes/verify/hooks/useVerificationSequence.ts, infra/terraform/, infra/lambdas/, infra/docker/entrypoint.sh -->
