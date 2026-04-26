# Deployment Guides

Authoritative references for rolling out the STARK Ballot Simulator across AWS infrastructure layers.  
Last reviewed: **2026-01-21** (async finalize + callbacks in place; security/quality hardening ongoing).

---

## Guide Catalog

| Guide                                                                                                  | Scope                                                                                     | Status                  | When to Use                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 🧱 [RISC Zero Base Image](./risc0-base-image.md)                                                       | Build reusable ARM64 toolchain image                                                      | ✅ Baseline             | One-time toolchain build and digest pinning              |
| 🧭 [Terraform Guide](../7-terraform/README.md)                                                         | Terraform-managed async prover infrastructure and Amplify handoff                         | ✅ Current              | Rebuild or review the public infrastructure contract     |
| 🛠️ [AWS Hybrid Runbook](../../runbooks/aws-hybrid.md)                                                  | Operational flow for async finalize, S3 bundles, Step Functions, ECS, and troubleshooting | ✅ Current              | Operate or diagnose the deployed hybrid AWS path         |
| 🧪 [Phase 9.4 Manual Testing Log](../../../archive/guides/3-deployment/phase9.4-manual-testing-log.md) | Hands-on CLI/Fargate execution logs (dev/prod/64 votes, quota tests)                      | 🗄️ Archive (historical) | Replay historical test plans and inspect timing evidence |

Internal deployment notes for Amplify Data, CodeBuild/ECR, Fargate, and SQS/Step Functions are
intentionally omitted from this public index.

Current focus:

- Keep async `/api/finalize`, callbacks, bundle storage, and Terraform-managed infra aligned with the current runbooks and roadmap.

---

## Current Architecture Snapshot

```text
User / CLI
    ↓
CloudFront → Amplify (Next.js)
    ↓ API Routes (SigV4)
Amplify Data (session store)
    ↓ enqueue
Amazon SQS (`stark-ballot-simulator-prover-work-<env>`)
    ↓
AWS Lambda (prover-dispatch-proxy, Reserved Concurrency configurable)
    ↓
AWS Step Functions (prover-dispatcher)
    ↓
ECS Fargate (zkVM prover task, 16 vCPU / 32 GB ARM64)
    ↓
Amazon S3 (proof bundles)
    ↓                         ↓
Lambda (finalize-callback-runner)  Lambda B / verifier-service (verification + bundle handoff)
    ↓ (finalizationState)
Amplify Data (status)
```

> Status: Async `/api/finalize` runs via SQS → Step Functions → finalize-callback-runner. UI polls until `finalizationState` is succeeded/failed.

---

## Deployment Workflow

1. **Frontend + Data Layer**
   - Follow the public Terraform guide and AWS hybrid runbook for the deployable boundary.
   - Configure session TTLs (30 min voting, 24 h verification) and cleanup Lambda.
2. **zkVM Prover Build & Publish**
   - Build ARM64 base/toolchain image (CodeBuild toolchain builder project).
   - Build application image (`zkvm-prover-{environment}:<tag>`) and push to ECR.
3. **Fargate Infrastructure**
   - Provision SQS → Step Functions → ECS resources (security group, log groups, IAM roles).
   - Register a task definition (16 vCPU / 32 GB) and validate with dev/prod test payloads.
4. **Manual Verification**
   - Use the archived [manual testing log](../../../archive/guides/3-deployment/phase9.4-manual-testing-log.md) steps to run dev mode (~20 s) and 64-vote prod (~4.5 min) tasks.
   - Capture CloudWatch metrics (CPU, memory) and ensure S3 outputs match expectations.
5. **Operations Preparation**
   - Document NAT/private-subnet migration (if required).
   - Validate vCPU quota vs. desired concurrency (e.g., 16 vCPU/task).

---

### Historical Note: EventBridge Pipe Migration

以下は過去の移行メモです。現在の async finalize 経路は **EventBridge Pipe ではなく**、SQS event source mapping 付きの `prover-dispatch-proxy` Lambda を使います。現行構成の運用や再構築では、Terraform / Amplify の最新ガイドを優先してください。

1. `prover-dispatch-proxy` Lambda をデプロイ（SQS イベントソースマッピングは無効）。
2. 既存 EventBridge Pipe を `STOPPED` 状態に変更し、`BatchSize=1` / `MaximumBatchingWindow=0` に調整。
3. Lambda の SQS トリガーを有効化（BatchSize=1）し、テストメッセージで疎通確認。
4. 24 時間の監視期間中に CloudWatch Logs / Metrics / DLQ をチェック。
5. 問題がなければ EventBridge Pipe を削除し、IaC から参照を除去。

---

## Key Considerations

- **Region**: Keep Amplify, S3, Step Functions, and Fargate in a single region (e.g., `ap-northeast-1`).
- **Performance**: 16 vCPU / 32 GB is typically required for 64-vote proofs; measure in your environment and monitor CPU throttling.
- **Concurrency**: Set Lambda Proxy reserved concurrency to match vCPU quota. Step Functions `executionName` must satisfy 80-char/charset constraints; ULID-based names are safe.
- **Security**: Use SigV4/IAM auth from CLI/UI; avoid API keys for production.
- **Costs**: Track Fargate on-demand vCPU-hours, NAT (~$32/mo when enabled), Amplify base charges.

---

## Prerequisites

- Development completed per [Development Guides](../2-development/).
- Local tests passing (Vitest/CLI/playwright).
- AWS CLI v2 configured (SSO or access keys; e.g., `aws sso login`).
- pnpm 10+, Node.js 20+, Docker with buildx (ARM64 capable).
- Access to required AWS resources (Amplify, S3, Step Functions, ECS, Service Quotas).

---

## Post-Deployment Checklist

- Validate Fargate task execution (dev + 64-vote prod) and collect metrics.
- Ensure Amplify Data cleanup and heartbeat functions run on schedule.
- Review S3 bundle integrity (output/receipt/journal) and signer URLs.
- Update runbooks with observed metrics, failures, and recovery steps.
- Complete security/quality hardening (Turnstile UI, CSP, rate limiting) before exposing to users.

---

## Related References

- System design: [Architecture Guides](../4-architecture/)
- Testing procedures: [CLI test docs](../../tests/cli.md)
