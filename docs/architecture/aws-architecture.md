# AWS Architecture (Current Target)

本ドキュメントは、STARK Ballot Simulator の target AWS 構成を俯瞰するための概要です。
上の図は実行時の一般的な構成だけを示し、下の図は同じ実行時構成に GitHub OIDC、AWS-native deployment pipeline、Terraform state 分離を足したものです。
上の図は下の図の runtime 部分集合です。

最終確認: 2026-07-11

This page records the repository-defined architecture. Dated account-specific
resource status and drift are recorded separately in the private current-AWS
inventory.

## Runtime Architecture

デプロイフローを除いた、ユーザー操作とアプリ実行時の構成です。

```text
┌──────────────────────────────────────────────┐
│ Users / Browsers                             │
└───────────────────────┬──────────────────────┘
                        │ HTTPS
                        ▼
┌──────────────────────────────────────────────┐
│ CloudFront                                   │
│ - static frontend origin                     │
│ - /api and /api/* origin                     │
└──────────────┬───────────────────┬───────────┘
               │ static assets     │ /api and /api/*
               ▼                   ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ S3 private static frontend   │   │ API Gateway HTTP API         │
│ Vite + React Router bundle   │   │ ANY /api, ANY /api/{proxy+}  │
└──────────────────────────────┘   └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                      ┌──────────────────────────────┐
                                      │ Lambda: Hono API             │
                                      │ session-scoped API authority │
                                      └──────────────┬───────────────┘
                                                     │
            ┌────────────────────────────────────────┼────────────────────────────────────────┐
            │                                        │                                        │
            ▼                                        ▼                                        ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐        ┌──────────────────────────────┐
│ DynamoDB                     │        │ Lambda: verification-worker      │        │ SQS prover-work queue        │
│ sessions                     │        │ verification run / reports   │        │ async finalization work      │
│ votes                        │        └──────────────┬───────────────┘        └──────────────┬───────────────┘
│ rate-limit-events            │                       │                                       │
│ rate-limit-counters          │                       ▼                                       ▼
└──────────────────────────────┘        ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                        │ S3 private proof/report      │        │ Lambda: proof-dispatcher      │
                                        │ artifacts                    │        │ starts Step Functions        │
                                        │ - public bundle allowlist    │        └──────────────┬───────────────┘
                                        │ - owner-scoped report        │                       │
                                        └──────────────────────────────┘                       ▼
                                                                               ┌──────────────────────────────┐
                                                                               │ Step Functions finalization  │
                                                                               │ async prover orchestration   │
                                                                               └──────────────┬───────────────┘
                                                                                              │
                                                    ┌─────────────────────────────────────────┼─────────────────────────────────────────┐
                                                    │                                         │                                         │
                                                    ▼                                         ▼                                         ▼
                                      ┌──────────────────────────────┐        ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                      │ Lambda: image-signature-gate│        │ ECS Fargate zkVM prover      │        │ Lambda: finalization-writer    │
                                      │ digest-pinned image trust    │        │ proof generation task        │        │ completion state update      │
                                      └──────────────────────────────┘        └──────────────┬───────────────┘        └──────────────┬───────────────┘
                                                                                              │                                       │
                                                                                              ▼                                       ▼
                                                                               ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                                                               │ S3 private proof artifacts   │        │ DynamoDB session/finalization│
                                                                               │ prover input/output objects  │        │ update                       │
                                                                               └──────────────────────────────┘        └──────────────────────────────┘
```

## Runtime + Deployment Architecture

同じ runtime 構成に、GitHub から AWS への deployment control plane と Terraform state 分離を足した構成です。

```text
┌──────────────────────────────────────────────┐
│ AWS Organizations                            │
└───────────────────────┬──────────────────────┘
                        │
      ┌─────────────────┼─────────────────┐
      │                 │                 │
      ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ management   │  │ stark-dev    │  │ stark-prod   │
│ account      │  │ account      │  │ account      │
├──────────────┤  ├──────────────┤  ├──────────────┤
│ Organizations│  │ develop env  │  │ main env     │
│ Billing      │  │ branch:      │  │ branch:      │
│ IAM Identity │  │ develop      │  │ main         │
│ Center       │  │              │  │ protected    │
│ Guardrails   │  │ bootstrap    │  │ production   │
│ No workloads │  │ foundation   │  │ path         │
│              │  │ app state    │  │              │
└──────────────┘  └──────┬───────┘  └──────┬───────┘
                         │                 │
                         └────────┬────────┘
                                  │ selected member account
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Target AWS member account                                             │
│ state identity: <account-alias>/<environment>/<state-scope>           │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   │
┌──────────────────────────────────▼───────────────────────────────────┐
│ GitHub repository                                                     │
├──────────────────────────────────────────────────────────────────────┤
│ CI evidence                                                           │
│ lint / type-check / tests / e2e / Rust / formal / public safety       │
├──────────────────────────────────────────────────────────────────────┤
│ GitHub Actions deploy trigger                                         │
│ OIDC: token.actions.githubusercontent.com                             │
│ aud: sts.amazonaws.com                                                │
│ sub: repo:<owner>/<repo>:ref:refs/heads/<branch>                      │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ AssumeRoleWithWebIdentity
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AWS IAM role: GitHub trigger                                          │
│ allowed only to start and observe selected CodePipeline execution     │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AWS CodePipeline                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ 1. Source                                                             │
│    CodeConnections GitHub source                                      │
│    exact branch / source SHA evidence                                 │
│                                                                      │
│ 2. Validate                                                           │
│    CodeBuild validate role                                            │
│    source preflight / CI evidence / config checks                     │
│                                                                      │
│ 3. Terraform Plan                                                     │
│    CodeBuild plan role                                                │
│    saved tfplan / human summary / checksum                            │
│                                                                      │
│ 4. Manual Approval                                                    │
│    AWS-native approval record                                         │
│    required for protected production path                             │
│                                                                      │
│ 5. Terraform Apply                                                    │
│    CodeBuild apply role                                               │
│    applies reviewed saved plan only                                   │
│                                                                      │
│ 6. Static Frontend Deploy                                             │
│    CodeBuild static deploy role                                       │
│    pnpm build:ci / dist scan / S3 sync / CloudFront invalidation      │
│                                                                      │
│ 7. Post-Deploy Smoke                                                  │
│    CodeBuild smoke role                                               │
│    CloudFront/API/security/boundary/data-plane evidence               │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Terraform state and deployment ownership                              │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
             ▼                     ▼                     ▼
┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ bootstrap state          │ │ foundation state         │ │ app state                │
├──────────────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
│ key:                     │ │ key:                     │ │ key:                     │
│ stark-ballot-simulator/  │ │ stark-ballot-simulator/  │ │ stark-ballot-simulator/  │
│ <account>/<env>/         │ │ <account>/<env>/         │ │ <account>/<env>/         │
│ bootstrap/               │ │ foundation/              │ │ app/                     │
│ terraform.tfstate        │ │ terraform.tfstate        │ │ terraform.tfstate        │
│                          │ │                          │ │                          │
│ lock:                    │ │ lock:                    │ │ lock:                    │
│ terraform.tfstate.tflock │ │ terraform.tfstate.tflock │ │ terraform.tfstate.tflock │
├──────────────────────────┤ ├──────────────────────────┤ ├──────────────────────────┤
│ owns deployment control  │ │ owns Plan 02             │ │ owns runtime resources   │
│ plane and backend grants │ │ prerequisites only:      │ │ below and consumes       │
│ - remote-state bucket    │ │ - ECR repositories       │ │ foundation handoff       │
│ - state KMS/policies     │ │ - signing/provenance     │ │                          │
│ - CodeConnections/OIDC   │ │   policy                 │ │                          │
│ - CodePipeline/Build     │ │ - release-manifest store │ │                          │
│ - deploy roles           │ │ - prover networking      │ │                          │
│ - artifact buckets       │ │ - secret containers      │ │                          │
│ - backend grants         │ │ - non-secret config      │ │                          │
│                          │ │ - DNS/ACM prerequisites  │ │                          │
└──────────────────────────┘ └──────────────────────────┘ └────────────┬─────────────┘
                                                                        │
                                                                        │ owns / deploys
                                                                        ▼
┌──────────────────────────────────────────────┐
│ Users / Browsers                             │
└───────────────────────┬──────────────────────┘
                        │ HTTPS
                        ▼
┌──────────────────────────────────────────────┐
│ CloudFront                                   │
│ - static frontend origin                     │
│ - /api and /api/* origin                     │
└──────────────┬───────────────────┬───────────┘
               │ static assets     │ /api and /api/*
               ▼                   ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ S3 private static frontend   │   │ API Gateway HTTP API         │
│ Vite + React Router bundle   │   │ ANY /api, ANY /api/{proxy+}  │
└──────────────────────────────┘   └──────────────┬───────────────┘
                                                   │
                                                   ▼
                                      ┌──────────────────────────────┐
                                      │ Lambda: Hono API             │
                                      │ session-scoped API authority │
                                      └──────────────┬───────────────┘
                                                     │
            ┌────────────────────────────────────────┼────────────────────────────────────────┐
            │                                        │                                        │
            ▼                                        ▼                                        ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐        ┌──────────────────────────────┐
│ DynamoDB                     │        │ Lambda: verification-worker      │        │ SQS prover-work queue        │
│ sessions                     │        │ verification run / reports   │        │ async finalization work      │
│ votes                        │        └──────────────┬───────────────┘        └──────────────┬───────────────┘
│ rate-limit-events            │                       │                                       │
│ rate-limit-counters          │                       ▼                                       ▼
└──────────────────────────────┘        ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                        │ S3 private proof/report      │        │ Lambda: proof-dispatcher      │
                                        │ artifacts                    │        │ starts Step Functions        │
                                        │ - public bundle allowlist    │        └──────────────┬───────────────┘
                                        │ - owner-scoped report        │                       │
                                        └──────────────────────────────┘                       ▼
                                                                               ┌──────────────────────────────┐
                                                                               │ Step Functions finalization  │
                                                                               │ async prover orchestration   │
                                                                               └──────────────┬───────────────┘
                                                                                              │
                                                    ┌─────────────────────────────────────────┼─────────────────────────────────────────┐
                                                    │                                         │                                         │
                                                    ▼                                         ▼                                         ▼
                                      ┌──────────────────────────────┐        ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                      │ Lambda: image-signature-gate│        │ ECS Fargate zkVM prover      │        │ Lambda: finalization-writer    │
                                      │ digest-pinned image trust    │        │ proof generation task        │        │ completion state update      │
                                      └──────────────────────────────┘        └──────────────┬───────────────┘        └──────────────┬───────────────┘
                                                                                              │                                       │
                                                                                              ▼                                       ▼
                                                                               ┌──────────────────────────────┐        ┌──────────────────────────────┐
                                                                               │ S3 private proof artifacts   │        │ DynamoDB session/finalization│
                                                                               │ prover input/output objects  │        │ update                       │
                                                                               └──────────────────────────────┘        └──────────────────────────────┘
```

## Notes

- **Current target status**: `infra/terraform/app` defines the target runtime,
  and the managed develop app lane has completed apply, static deployment, and
  post-apply smoke. Production bootstrap, DNS cutover, normal public admission,
  and legacy AWS retirement remain separately authorized follow-up work.
- **Account boundary**: `management` is only for AWS Organizations, IAM Identity Center, billing, and guardrails. Application workloads, Terraform backends, pipeline artifacts, and runtime resources live in member accounts.
- **Branch mapping**: `develop` maps to `stark-dev/develop`; `main` maps to `stark-prod/main`.
- **State separation**: `bootstrap` owns deployment infrastructure and backend grants. `foundation` owns only Plan 02 prerequisites consumed by the app lane: ECR repositories plus signing/provenance policy, release-manifest storage, prover networking, secret containers and non-secret config records, and DNS/ACM prerequisites. `app` owns CloudFront/S3, API Gateway/Hono Lambda, DynamoDB, private proof artifacts, SQS, Step Functions, ECS/Fargate, callback, verifier, and observability resources. It consumes the immutable foundation handoff and must not repair missing foundation authority during Plan 03.
- **GitHub boundary**: GitHub Actions may trigger or observe CodePipeline through the narrow OIDC trigger role. It must not run Terraform apply, read Terraform state, mutate application resources directly, or read production secrets.
- **Frontend boundary**: CloudFront serves Vite / React Router static assets from a private S3 bucket through OAC and routes `/api/*` to API Gateway. Browser-public `VITE_*` configuration must remain safe for public download.
- **API boundary**: Hono API runs behind API Gateway and remains the only browser/CLI authority for session-scoped state, bundle downloads, reports, verification runs, and mutations.
- **Data boundary**: session, vote, finalization, and rate-limit state use target DynamoDB tables. Non-mock target runtime does not depend on Amplify Data/AppSync.
- **Artifact boundary**: the proof/report S3 bucket is private. Public bundles are allowlisted evidence only; `input.json`, `verification.json`, `included-bitmap.json`, `seen-bitmap.json`, raw bitmap sidecars, vote openings, and private locators must not be public bundle members or static frontend artifacts.
- **Proof pipeline**: `/api/finalize` dispatches async work through SQS, `proof-dispatcher`, Step Functions, image-signature checking, ECS Fargate zkVM proving, private S3 artifacts, and `finalization-writer`.
- **Retired surfaces**: Amplify Hosting, Amplify Data/AppSync, and Next.js route wrappers are historical surfaces, not current target runtime or deployment authority.

## Related Source-of-Truth Documents

- [Infrastructure documentation](../infrastructure/README.md)
- [Verification pipeline](../verification/README.md)
- Per-root Terraform operator `README.md` files (`infra/terraform/bootstrap/`, `infra/terraform/foundation/`, `infra/terraform/app/`; private operator documentation)

Account-specific migration sequencing, approval records, and live handoff
evidence remain in private operator documentation.
