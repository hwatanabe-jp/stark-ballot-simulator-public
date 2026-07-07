# Security Runbook

## Turnstile Operations

1. **Widget provisioning**
   - Cloudflare Dashboard → Turnstile → _Create_
   - Type: Managed, Domain: `stark-ballot.example.com`
   - Copy Site key → `VITE_TURNSTILE_SITE_KEY`
   - Copy Secret key → `TURNSTILE_SECRET_KEY` in the target runtime secret source
2. **Environments**
   - Local/mock UI only: set `VITE_TURNSTILE_BYPASS=1` and
     `TURNSTILE_BYPASS=1` with an explicit non-production runtime marker.
   - Reusable/deployable `pnpm build:ci` artifacts: leave browser bypass flags
     unset or `0`; the generated artifact scan rejects bypass-enabled builds.
   - Production demo: set all bypass flags to `0` and verify widget renders
   - Current session-create hardening is environment-dependent: set
     `SESSION_CREATE_TURNSTILE_REQUIRED=1` and expose UI gating through the
     target `VITE_*` browser-public config when that path is enabled.
   - Operator-gated develop only: `TARGET_PUBLIC_SESSION_CREATE_ENABLED=true`,
     `SESSION_CREATE_TURNSTILE_REQUIRED=false`, and
     `VITE_SESSION_CREATE_TURNSTILE_REQUIRED=false` are acceptable when an outer
     operator/tester gate protects the static app and `/api/*`. This is not
     valid for ungated public production.
   - Target protected production under the no-WAF AWS migration posture: public `POST /api/session` must require server-side Turnstile unless a named exception records owner, scope, rationale, compensating controls, review/deletion gate, and validation evidence.
3. **Failure response**
   - API returns `CAPTCHA_FAILED`
   - Frontend surfaces `errors.captchaFailed` and re-renders widget

## Target AWS Migration Edge Posture

The target AWS account migration posture does not adopt AWS WAF because the
cost is too high for this personal portfolio/demo project. No-WAF is the
selected target posture, not an omitted control.

Target cutover evidence must instead prove these compensating controls:

- application-level rate limits for session creation, vote, finalize, and
  verifier execution paths;
- API Gateway stage throttles, or an accepted exception with deployed
  configuration and monitoring evidence;
- server-side Turnstile validation, including public `POST /api/session`
  when public session admission is enabled;
- trusted source-IP handling through the accepted CloudFront/API Gateway path;
- CloudFront/API Gateway access logs;
- application logs that record abuse-control outcomes without secrets,
  capability tokens, vote openings, private proof inputs, or private artifact
  bodies;
- monitoring for Turnstile failures, rate-limit rejections, throttle events,
  and source-IP trust failures;
- deployed smoke evidence for legitimate session/vote/finalize/verify,
  authenticated bundle/report access, missing/wrong capability rejection,
  retired private/debug branch rejection, and safe rate-limit or throttle
  rejection evidence.

## Challenge Page (Cloudflare Legacy/Live)

> **Status (2026-01-04)**: **有効化済み**。`<PUBLIC_APP_DOMAIN>` の _Proxied_ 配信で `/vote`・`/aggregate`・`/verify` に **Managed Challenge** を適用。Challenge Page は **プロキシ有効時のみ**適用されるため、DNS Only に戻すと無効になる。
>
> This is legacy/current-live Cloudflare Challenge guidance for the existing
> deployment. It is not the target AWS migration compensating-control model.
> For the target model, use the no-AWS-WAF posture above with application rate
> limits, API Gateway throttles, server-side Turnstile, source-IP trust,
> access logs, application logs, monitoring, and deployed smoke evidence.

1. **DNS**: ensure domain uses Cloudflare NS, set application records to _Proxied_
2. **Activation**: Security → WAF → Custom Rules → Managed Challenge
3. **Managed Challenge rule (current)**:
   - Rule: Managed Challenge
   - Conditions:
     - URI Path equals `/vote`
     - URI Path equals `/aggregate`
     - URI Path equals `/verify`
   - Turnstile pre-clearance: **Managed**
4. **Bypass (optional)**:
   - CI は本番環境にアクセスしないため、通常はバイパス設定不要。
   - 手動検証や外部自動化で必要になった場合のみ、Security Rules で特定パスを “Essentially Off” に設定する。
   - Optional: Workers token for future automation

## API Gateway / CloudFront Access Path

Target AWS currently routes browser traffic through CloudFront, with `/api` and
`/api/*` forwarding to the HTTP API Gateway execution endpoint as the origin.
Do not claim target `execute-api` direct hits are blocked by default:
pre-authority direct API Gateway smoke is allowed, and current no-WAF evidence
comes from application rate limits, API Gateway stage throttles, server-side
Turnstile where enabled, trusted source-IP handling, logs, monitoring, and
deployed smoke evidence.

After CloudFront authority exists, use the CloudFront same-origin `/api/*` path
for browser and CLI evidence. For operator-gated develop, direct `execute-api`
calls remain explicit operator smoke/debug evidence only and must not become the
normal path or a bypass around the outer gate.

## Rate Limiting

- `/api/session`: dedicated per-IP limiter (`SESSION_CREATE_RATE_LIMIT` / `SESSION_CREATE_RATE_LIMIT_WINDOW_MS` / `SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS`)
- `/api/vote`: DynamoDB-backed sliding window (10 requests/min per IP). Adjust via `VOTE_RATE_LIMIT` and `VOTE_RATE_LIMIT_WINDOW_MS`
- `/api/finalize` / `/api/verification/run`: DynamoDB-backed per-IP (24h/50) + global quotas (hourly 100, daily 1000)
- Store selection: `RATE_LIMIT_STORE=memory|dynamo` (default: memory for tests/CI)
- Invalid-request attempts are capped at 2× the success limit (per-IP); global quotas still apply only to successful zkVM executions
- API Gateway (HTTP API) throttling is Terraform-owned in `infra/terraform/app/locals.tf` (`local.api_throttle_burst_limit` / `local.api_throttle_rate_limit`) and applied to the default stage
- `MAX_SESSIONS` is enforced at runtime for `/api/session`; creates are rejected with `SESSION_LIMIT_EXCEEDED` when cap is reached
- Set `TRUSTED_PROXY` explicitly in production (`api-gateway` or `both`) so IP-based controls rely on trusted headers only
- Monitor `GLOBAL_LIMIT_EXCEEDED` responses in logs

## Monitoring & Alerts

- **CloudWatch Logs Insights**: create saved queries for `CAPTCHA_FAILED`, `GLOBAL_LIMIT_EXCEEDED`, and rate-limit responses (503 for GLOBAL_LIMIT_EXCEEDED, 429 for ZKVM_RATE_LIMIT_EXCEEDED)
- **Metrics**: publish counts of 403 (CAPTCHA) / 503 (GLOBAL_LIMIT_EXCEEDED) / 429 (ZKVM_RATE_LIMIT_EXCEEDED) to CloudWatch; alert if >100 events/hour or sustained growth >3× baseline
- **Challenge Page (legacy/live only)**: watch Cloudflare Security Analytics for spikes; adjust Security Level or enable JS challenges when anomalies occur. This is not target AWS migration no-WAF evidence.
- **Target AWS/IAM 監視**: use `docs/current/runbooks/aws-hybrid.md` for triage. Current target log queries and retained legacy monitoring guidance are managed in private operations notes.

## Testing Checklist

- [ ] `pnpm ci:verify` passes locally (`format:check` / lint / type-check / unit / axe E2E / mock E2E)
- [ ] `pnpm public-safety:scan` passes before public snapshot or publishable-boundary changes
- [ ] Manual E2E smoke with `TURNSTILE_BYPASS=0` (widget enabled; Challenge Page evidence applies only to the legacy/live Cloudflare path)
- [ ] CI は mock E2E のみで、本番ドメインにアクセスしないことを確認
- [ ] Security headers validated via securityheaders.com / Mozilla Observatory

## CSP & Security Headers

- Target static frontend CSP is owned by the CloudFront response headers policy in `infra/terraform/app/frontend_static.tf`.
- Other target security headers are owned by the static/API serving layer and CloudFront/API Gateway configuration.
- The local static Hono server intentionally sets only the minimal local response headers needed by its test-server role; it does not own the target CSP contract.
- Use `pnpm lint` + `pnpm test:e2e:mock` to confirm no blocked assets

## CI Workflow

- `pnpm ci:verify` (`format:check` → lint → type-check → unit → `test:e2e:axe` → `test:e2e:mock`)
- `pnpm public-safety:scan` runs separately in the public-safety workflow and public snapshot release flow
- Run locally before PRs; CI should execute on push

## Legacy Container Image Security References (Not Plan 03 Evidence)

> **Plan 02/03 guardrail:** The signing, scanning, and update commands below
> are legacy or diagnostic references and are not the current target-develop
> release-candidate authority. Do not cite direct CodeBuild starts, ECR
> describes, local digest updates, local tfvars regeneration, or
> operator-authored manifest text as Plan 02 release-candidate authority or
> Plan 03 acceptance evidence. For post-merge `stark-dev/develop`, use
> [`develop-target-image-authority.md`](../internal/guides/3-deployment/develop-target-image-authority.md),
> record the result in the
> [`develop-plan-02-foundation-handoff-template.md`](../internal/guides/3-deployment/develop-plan-02-foundation-handoff-template.md),
> and follow the current
> [`02`](../aws-account-migration/post-merge/02-develop-app-prerequisite-definitions-plan.md)
> /
> [`03`](../aws-account-migration/post-merge/03-develop-app-execution-and-validation-plan.md)
> post-merge gate. Accepted Plan 03 evidence requires successful separate
> target-account toolchain/prover candidate and promotion execution IDs,
> retained pipeline outputs for image build, scan/signing, provenance, accepted
> channel pointer versions, a selected prover release/app deployment record,
> any generated release-manifest bridge, and independent revalidation.

### Legacy/Shared ECR Managed Signing Reference

AWS Signer を使用したコンテナイメージ署名:

- **署名プロファイル**: `stark_ballot_simulator_ecr_signing`
- **legacy/shared 対象リポジトリ**:
  - `stark-ballot-simulator/zkvm-prover-develop` (develop環境アプリイメージ)
  - `stark-ballot-simulator/zkvm-prover-main` (main環境アプリイメージ)
  - `stark-ballot-simulator/risc0-toolchain` (共有ベースイメージ)
- **digest固定が必須**: 署名ステータスは image digest 単位で評価されるため、ECS/ Terraform の `ecs_image_uri` は必ず `...@sha256:...` を使う。`latest`、semver、commit SHA などの tag 指定は不可
- **ランタイム検証**: Step Functions `VerifyImageSignature` 状態で署名検証

署名確認例:

```bash
TRUSTED_SIGNING_PROFILE_VERSION_ARN="arn:aws:signer:ap-northeast-1:<AWS_ACCOUNT_ID>:/signing-profiles/<SIGNING_PROFILE_NAME>/<PROFILE_VERSION>"

aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageDigest=sha256:<64-hex> \
  --query "length(signingStatuses[?signingProfileVersionArn=='${TRUSTED_SIGNING_PROFILE_VERSION_ARN}' && status=='COMPLETE'])" \
  --output text
```

The command must return `1`. A tag lookup, a different signing profile, or a
first-array-element status check is not acceptance evidence.

### Legacy/Shared Vulnerability Scanning Reference

ECR Basic Scanning (`scanOnPush=true`) による脆弱性スキャン:

```bash
# スキャン結果確認 (legacy/root 環境別リポジトリ; evidence must be digest-bound)
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageDigest=sha256:<64-hex> \
  --query 'imageScanFindings.findingSeverityCounts'

# legacy/root main環境の場合
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/zkvm-prover-main \
  --image-id imageDigest=sha256:<64-hex> \
  --query 'imageScanFindings.findingSeverityCounts'

# HIGH/CRITICAL の詳細 (legacy/shared ベースイメージ)
aws ecr describe-image-scan-findings \
  --repository-name stark-ballot-simulator/risc0-toolchain \
  --image-id imageDigest=sha256:<64-hex> \
  --query 'imageScanFindings.findings[?severity==`HIGH` || severity==`CRITICAL`]'
```

### Legacy/Shared Known Vulnerabilities (2026-03-21)

**risc0-toolchain ベースイメージ** (`sha256:0e7bf6820f0b570aa4d72036ca81b2e2ebd29245456e08e8a36c014cc1b56379`):

> Build #2 (2026-03-21, RISC Zero v3.0.5). 脆弱性評価は `aws ecr describe-image-scan-findings` で確認。
> ビルド時依存のみ使用、ランタイムイメージには含まれない。

**zkvm-prover アプリイメージ**:

- develop: `sha256:78834ad854083564db3caf95b46da0fcd85ab722e2edbe8de3d743a8b0fb1849` (署名済み ✅)
- main: `sha256:1c2f8f91aa70c6f7eaf74e4d91e4266300e73d20b171a1cf0cd665432dd6dbbc` (署名済み ✅)

### Legacy/Shared Update Procedures

For post-merge `stark-dev/develop`, do not use direct CodeBuild starts, local
digest extraction, local build-arg generation, `.env.local` digest promotion, or
removed `pnpm terraform:tfvars:*` scripts as current update guidance. Base image
and prover image updates must flow through separate target-account
toolchain/prover release artifact pipelines, promotion/channel records, and
retained outputs.

**脆弱性対応優先度 / ゲート**:

- zkVM prover アプリイメージ: HIGH/CRITICAL は `buildspec.yml` のビルド失敗ゲート
- risc0-toolchain ベースイメージ: HIGH/CRITICAL はビルドを失敗させず、利用前レビューとこの runbook の Known Vulnerabilities で追跡
- risc0-toolchain build output の `/tmp/image-info.json` は
  `scanStatus=PASS|FINDINGS_PRESENT` と `criticalHighCount` を記録する。
  toolchain artifact input ではその JSON を `build.imageInfo` に保持する。
  artifact record generator は `PASS`/`criticalHighCount=0` を機械証跡として受け
  入れ、finding がある場合は operator transcription ではなく `scanWaiverId`
  を要求する。
- CRITICAL: 即時対応
- HIGH: 1週間以内に評価、パッチ適用検討
- MEDIUM/LOW: 定期メンテナンス時に対応

## Incident Playbook

1. **High bot traffic**
   - Legacy/live Cloudflare path: increase Challenge Page sensitivity (Security Level: High)
   - Target AWS migration path: inspect no-WAF compensating-control evidence,
     then tune application rate limits, API Gateway throttles, Turnstile
     enforcement, source-IP trust handling, monitoring, or smoke exceptions as
     appropriate
   - Reduce `VOTE_RATE_LIMIT`
2. **False positives**
   - Temporarily raise limits via env overrides
   - 自動化が必要になった場合は一時的な Security Rule 例外を作成して記録
3. **Turnstile outage**
   - Non-production or legacy/live emergency paths may set bypass flags to `1`
     (`VITE_TURNSTILE_BYPASS`, `TURNSTILE_BYPASS`) and, if
     `/api/session` is gated, temporarily set
     `SESSION_CREATE_TURNSTILE_REQUIRED=0`.
   - Operator-gated develop may disable session-create Turnstile without
     enabling `VITE_TURNSTILE_BYPASS` or `TURNSTILE_BYPASS`; the outer gate is
     the compensating abuse-control boundary.
   - Target protected production public session creation must remain
     Turnstile-enforced, be temporarily frozen/fail-closed, or operate under a
     named exception with owner, scope, rationale, compensating controls,
     review/deletion gate, and validation evidence.
   - Document downtime, affected path, selected posture, exception evidence if
     any, and revert once service recovered.
