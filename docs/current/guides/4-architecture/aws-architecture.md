# AWS Architecture (Current)

本ドキュメントは、STARK Ballot Simulator の **現在の AWS 構成** を「よくある図」として俯瞰できるようにまとめたものです。
（最終確認: 2026-01-04）

```text
┌──────────────────┐
│ Users / Browsers │
└────────┬─────────┘
         │ (web/SSR)
         ▼
┌──────────────────────────────┐
│ Amplify Hosting              │
│ Next.js 16 (App Router)      │
│ static + SSR                 │
└──────────────┬───────────────┘
               │ served app bundle (JS)
               ▼
┌──────────────────────────────┐
│ Frontend Runtime (Browser)   │
└──────────────┬───────────────┘
               │ API calls (NEXT_PUBLIC_API_BASE_URL)
               ▼
┌──────────────────────────────┐     ┌──────────────────────────────┐
│ API Gateway (HTTP API)       │────▶│ Lambda: hono-api             │
│ /api/*                       │     │ (Node.js 22)                 │
└──────────────────────────────┘     └──────────────┬───────────────┘
                                                    │
                     ┌──────────────────────────────┼──────────────────────────────┐
                     │                              │                              │
                     ▼                              ▼                              ▼
         ┌───────────────────────┐    ┌───────────────────────┐    ┌────────────────────────────────────────────┐
         │ AppSync GraphQL       │    │ Lambda: verifier-     │    │ SQS: prover-work queue                    │
         │ (Amplify Data)        │    │ service-runner (Layer)│    │ (`stark-ballot-simulator-prover-work-<env>`) │
         └───────────┬───────────┘    └───────────┬───────────┘    └───────────┬───────────┘
                     │                            │                            │
                     ▼                            ▼                            ▼
         ┌───────────────────────┐    ┌───────────────────────┐    ┌───────────────────────────────┐
         │ DynamoDB (GraphQL)    │    │ S3 Proof Bundles      │    │ Lambda: prover-dispatch-proxy │
         │ • Session tables      │    │ bundle.zip (~15MB)    │    │ (Reserved Concurrency = 2)    │
         └───────────────────────┘    └───────────────────────┘    └───────────────┬───────────────┘
                                                                                   │
         ┌───────────────────────┐                                                 │
         │ DynamoDB (Direct SDK) │ ◀── hono-api Lambda                             │
         │ • RateLimitEvents     │                                                 │
         │ • RateLimitCounters   │                                                 │
         └───────────────────────┘                                                 │
                                                                                   │
                                                                                   ▼
                                                                   ┌────────────────────────────────────────────────────┐
                                                                   │ Step Functions: prover-dispatcher                 │
                                                                   │ (`stark-ballot-simulator-prover-dispatcher-<env>`) │
                                                                   └───────────────┬───────────────┘
                                                                                   │
                                                                   ┌───────────────┴───────────────┐
                                                                   │                               │
                                                                   ▼                               ▼
                                                   ┌───────────────────────────┐   ┌───────────────────────────┐
                                                   │ Lambda: check-image-      │   │ Lambda: finalize-         │
                                                   │ signature (ECR gate)      │   │ callback-runner           │
                                                   └─────────────┬─────────────┘   └─────────────┬─────────────┘
                                                                 │                               │
                                                                 ▼                               ▼
                                                   ┌───────────────────────────┐   ┌───────────────────────────┐
                                                   │ ECS Fargate (ARM64)       │   │ AppSync GraphQL           │
                                                   │ zkVM Prover Task          │   │ finalizationState         │
                                                   └─────────────┬─────────────┘   └───────────────────────────┘
                                                                 │
                                                                 ▼
                                                   ┌───────────────────────────┐
                                                   │ S3 Proof Bundles          │
                                                   └───────────────────────────┘
```

```text
┌────────┐   ┌───────────────────────┐   ┌─────────────────────┐   ┌────────────────────────┐
│ User   │──▶│ Amplify Hosting       │──▶│ Browser Runtime     │──▶│ API Gateway (HTTP API) │
│        │   │ Next.js 16            │   │                     │   │                        │
└────────┘   └───────────────────────┘   └─────────────────────┘   └───────────┬────────────┘
                                                                               │
                                                                               ▼
                                                                   ┌───────────────────────┐
                                                                   │ Lambda: hono-api      │
                                                                   └───────────┬───────────┘
                                                                               │
                     ┌─────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┐
                     │                                                         │                                                         │
                     ▼                                                         ▼                                                         ▼
         ┌───────────────────────┐                             ┌───────────────────────────────┐                         ┌────────────────────────────────────────────┐
         │ AppSync GraphQL       │                             │ Lambda: verifier-service-     │                         │ SQS: prover-work queue                    │
         │                       │                             │ runner (Layer)                │                         │ (`stark-ballot-simulator-prover-work-<env>`) │
         └───────────┬───────────┘                             └───────────────┬───────────────┘                         └─────────────┬─────────────┘
                     │                                                         │                                                       │
                     ▼                                                         ▼                                                       ▼
         ┌───────────────────────┐                             ┌───────────────────────────────┐                         ┌───────────────────────────┐
         │ DynamoDB (GraphQL)    │                             │ S3 Proof Bundles              │                         │ Lambda: prover-dispatch-  │
         │ • Session tables      │                             │                               │                         │ proxy                     │
         └───────────────────────┘                             └───────────────────────────────┘                         └─────────────┬─────────────┘
                                                                                                                                       │
         ┌───────────────────────┐                                                                                                     │
         │ DynamoDB (Direct SDK) │ ◀── hono-api Lambda                                                                                 │
         │ • RateLimitEvents     │                                                                                                     │
         │ • RateLimitCounters   │                                                                                                     │
         └───────────────────────┘                                                                                                     │
                                                                                                                                       │
                                                                                                                                       ▼
                                                                                                                         ┌────────────────────────────────────────────────────┐
                                                                                                                         │ Step Functions: prover-dispatcher                 │
                                                                                                                         │ (`stark-ballot-simulator-prover-dispatcher-<env>`) │
                                                                                                                         └─────────────┬─────────────┘
                                                                                                                                       │
                                                                                                         ┌─────────────────────────────┴─────────────────────────────┐
                                                                                                         │                                                           │
                                                                                                         ▼                                                           ▼
                                                                                         ┌───────────────────────────────┐                           ┌───────────────────────────────┐
                                                                                         │ Lambda: check-image-signature │                           │ Lambda: finalize-callback-    │
                                                                                         │                               │                           │ runner                        │
                                                                                         └───────────────┬───────────────┘                           └───────────────┬───────────────┘
                                                                                                         │                                                           │
                                                                                                         ▼                                                           ▼
                                                                                         ┌───────────────────────────────┐                           ┌───────────────────────────────┐
                                                                                         │ ECS Fargate zkVM Prover       │                           │ AppSync GraphQL               │
                                                                                         │ (ARM64, 16 vCPU / 32 GB)      │                           │ finalizationState             │
                                                                                         └───────────────┬───────────────┘                           └───────────────────────────────┘
                                                                                                         │
                                                                                                         ▼
                                                                                         ┌───────────────────────────────┐
                                                                                         │ S3 Proof Bundles              │
                                                                                         └───────────────────────────────┘
```

## Notes

- **フロントアクセス**: 画面表示のアクセス先は **Amplify Hosting**。API Gateway は **API 呼び出し時のみ**（`NEXT_PUBLIC_API_BASE_URL` を設定している場合）にブラウザからアクセスされます。
- **アプリ層**: Amplify Hosting（Next.js）+ AppSync（Amplify Data）が中心。Hono API は API Gateway 経由で Lambda 実行。
- **証明生成パイプライン**: `/api/finalize` → SQS → Lambda Proxy → Step Functions → ECS Fargate → S3 → Finalize Callback。
- **署名・検証**: ECR 署名が存在することの検証は Step Functions の `check-image-signature` で実行。署名検証する機能は公式で配布されておらず、未実装。
- **データアクセス**: Session は AppSync GraphQL 経由、Rate Limit は直接 DynamoDB SDK (`@aws-sdk/client-dynamodb`)。
- **レート制限**: DynamoDB テーブル (RateLimitEvents/Counters) で per-IP + global 制限を永続化。Hono Lambda と同一スタックで自動作成。
- **監視**: Lambda / Step Functions / ECS は CloudWatch Logs に集約。
- **IaC**: Amplify はアプリ層、Terraform はインフラ層（VPC/ECS/SQS/Step Functions/ECR/S3）を管理。
