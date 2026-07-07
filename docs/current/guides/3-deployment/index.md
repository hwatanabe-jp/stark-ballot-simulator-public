# Deployment Guides

Authoritative references for rolling out the STARK Ballot Simulator across AWS infrastructure layers.  
Last reviewed: **2026-06-13** (target Vite/Hono/DynamoDB migration cleanup).

> **Status guardrail:** These guides describe the current target design and
> post-Plan-03 operational procedures. They are not Plan 02 release-candidate
> handoff evidence and do not authorize Plan 03. For current go/no-go authority,
> use
> [`post-merge/02`](../../aws-account-migration/post-merge/02-develop-app-prerequisite-definitions-plan.md)
> and
> [`post-merge/03`](../../aws-account-migration/post-merge/03-develop-app-execution-and-validation-plan.md).

---

## Guide Catalog

| Guide                                                                                                  | Scope                                                                                     | Status                  | When to Use                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 🧱 [RISC Zero Base Image](./risc0-base-image.md)                                                       | Build reusable ARM64 toolchain image                                                      | ⚠️ Technical background | Not Plan 02/03 release-candidate or handoff authority    |
| 🧭 [Terraform Guide](../7-terraform/README.md)                                                         | Legacy/root Terraform retention notes plus target Terraform handoff                       | ⚠️ Mixed legacy/target  | Classify retained legacy operations before use           |
| 🛠️ [AWS Hybrid Runbook](../../runbooks/aws-hybrid.md)                                                  | Operational flow for async finalize, S3 bundles, Step Functions, ECS, and troubleshooting | ✅ Current              | Operate or diagnose the deployed hybrid AWS path         |
| 🧪 [Phase 9.4 Manual Testing Log](../../../archive/guides/3-deployment/phase9.4-manual-testing-log.md) | Hands-on CLI/Fargate execution logs (dev/prod/64 votes, quota tests)                      | 🗄️ Archive (historical) | Replay historical test plans and inspect timing evidence |

Legacy Amplify deployment notes are retention-only and are no longer the current target deployment path.

Current focus:

- Keep async `/api/finalize`, callbacks, bundle storage, and Terraform-managed infra aligned with the current runbooks and roadmap.

---

## Target Architecture Model

```text
User / CLI
    ↓
CloudFront → S3 static frontend (Vite / React Router)
    ↓ API Gateway
Public API Lambda
    ↓
DynamoDB (session store)
    ↓ enqueue
Amazon SQS (`<project>-<account-alias>-<env>-prover-work`)
    ↓
AWS Lambda (target dispatch, Reserved Concurrency configurable)
    ↓
AWS Step Functions (proof-dispatcher)
    ↓
ECS Fargate (zkVM prover task, 16 vCPU / 32 GB ARM64)
    ↓
Amazon S3 (proof bundles)
    ↓                         ↓
Lambda (finalization writer)  Lambda / verifier-service (verification + bundle handoff)
    ↓ (finalizationState)
DynamoDB (status)
```

> Status: This is the target design and post-Plan-03 operational model. Target
> async `/api/finalize` is expected to run through Terraform-managed SQS, Step
> Functions, callback, private artifacts, and authenticated bundle/report
> delivery after the post-merge handoff and app execution gates are accepted.
> UI polls until `finalizationState` is succeeded/failed.

---

## Post-Plan-03 Deployment Workflow

1. **Frontend + Data Layer**
   - After the post-merge handoff and app execution gates are accepted, follow
     the public Terraform guide and AWS hybrid runbook for the deployable
     boundary.
   - Configure session TTLs (30 min voting, 24 h verification) and cleanup behavior through target runtime settings.
2. **zkVM Prover Build & Publish**
   - Use the accepted release-candidate image authority for ARM64 base/toolchain and prover images.
   - Publish only digest-pinned image references with retained scan, signing, and provenance evidence.
3. **Fargate Infrastructure**
   - Provision SQS → Step Functions → ECS resources through the accepted target Terraform path.
   - Register a task definition (16 vCPU / 32 GB) and validate with accepted target smoke evidence.
4. **Manual Verification**
   - Use current CLI and Terraform runbooks for fresh verification. Historical manual timing logs are retained in private source history.
   - Capture CloudWatch metrics (CPU, memory) and ensure S3 outputs match expectations.
5. **Operations Preparation**
   - Document NAT/private-subnet migration (if required).
   - Validate vCPU quota vs. desired concurrency (e.g., 16 vCPU/task).

---

### Historical Note: EventBridge Pipe Migration

以下は過去の移行メモです。現在の async finalize 経路は **EventBridge Pipe ではなく**、Terraform-managed target dispatch Lambda を使います。現行構成の運用や再構築では、Terraform target runtime guidance を優先してください。

1. `proof-dispatcher` Lambda をデプロイ（SQS イベントソースマッピングは無効）。
2. 既存 EventBridge Pipe を `STOPPED` 状態に変更し、`BatchSize=1` / `MaximumBatchingWindow=0` に調整。
3. Lambda の SQS トリガーを有効化（BatchSize=1）し、テストメッセージで疎通確認。
4. 24 時間の監視期間中に CloudWatch Logs / Metrics / DLQ をチェック。
5. 問題がなければ EventBridge Pipe を削除し、IaC から参照を除去。

---

## Key Considerations

- **Region**: Keep S3, API Gateway/Lambda, DynamoDB, Step Functions, and Fargate in a single region (e.g., `ap-northeast-1`).
- **Performance**: 16 vCPU / 32 GB is typically required for 64-vote proofs; measure in your environment and monitor CPU throttling.
- **Concurrency**: Lambda reserved concurrency is optional capacity control, not part of the current target Terraform baseline. Size Step Functions/ECS concurrency against vCPU quota. Step Functions `executionName` must satisfy 80-char/charset constraints; ULID-based names are safe.
- **Security**: The current target path uses CloudFront/operator admission, a CloudFront-injected origin verification header checked by the API Lambda, and session capability headers for session-scoped operations. Do not describe the current browser/CLI path as API Gateway SigV4/IAM auth unless an authorizer is added to Terraform.
- **Costs**: Track Fargate on-demand vCPU-hours, Lambda/API Gateway, DynamoDB, S3/CloudFront, and NAT when enabled.

---

## Prerequisites

- Development completed per [Development Guides](../2-development/).
- Local tests passing (Vitest/CLI/playwright).
- AWS CLI v2 configured for the intended target account with explicit profile,
  account, and region selection, for example
  `--profile stark-dev-admin --region ap-northeast-1` for `stark-dev/develop`
  inspection. Do not rely on implicit default AWS credentials for
  account-targeted work. Plan 02/03 go/no-go authority comes from the
  post-merge plans, not local CLI context.
- pnpm 11.x through Corepack, Node.js 24, Docker with buildx (ARM64 capable).
- Access to required AWS resources (S3, CloudFront, API Gateway/Lambda, DynamoDB, Step Functions, ECS, Service Quotas).

---

## Post-Deployment Checklist

- Validate Fargate task execution (dev + 64-vote prod) and collect metrics.
- Ensure target DynamoDB cleanup and status update paths run on schedule.
- Review S3 bundle integrity (output/receipt/journal) and signer URLs.
- Update runbooks with observed metrics, failures, and recovery steps.
- Complete security/quality hardening (Turnstile UI, CSP, rate limiting) before exposing to users.

---

## Related References

- System design: [Architecture Guides](../4-architecture/)
- Testing procedures: [CLI test docs](../../tests/cli.md)
