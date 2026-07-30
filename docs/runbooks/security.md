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
- **Target AWS/IAM monitoring**: Use `docs/runbooks/aws-runtime-operations.md`
  for triage. Detailed target queries and retained legacy monitoring guidance
  remain in private operator documentation.

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

## Target Container Image Security

Current target images are built and promoted only through the dedicated
toolchain and prover release lanes. Candidate evidence is digest-bound and must
include scan, signing, provenance, source, and (for the prover) ImageID/method
version checks. The app consumes the accepted record chain; mutable tags,
direct CodeBuild starts, local pushes, and operator-transcribed digests are not
deployment authority.

These image-release controls describe the repository-defined hard-cutover
target. Until the coordinated bootstrap, Foundation, image-promotion, and App
sequence succeeds, live AWS retains the old status-only runtime gate and old
operational contracts.

- The prover lane fails on HIGH or CRITICAL findings.
- The toolchain lane retains digest-bound findings as accepted and
  non-blocking under the repository PoC policy. If the lane requires a
  disposition ID, it cites that policy; no per-finding review or remediation
  is required before promotion.
- Digest-level ECR signing status is bounded readiness evidence only. Both
  image lanes cryptographically verify the exact digest, configured signing
  profile, certificate chain, trust policy, and revocation state for the
  candidate and again for promotion.
- After the hard cutover, Step Functions invokes the qualified runtime verifier
  alias to cryptographically verify the selected prover digest before launching
  ECS.

Use the [infrastructure guide](../infrastructure/README.md) and
[RISC Zero ARM64 toolchain guide](../infrastructure/risc0-base-image.md)
for the public-safe model. The account-specific operator flow and evidence
contract are retained only in the private source repository.

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
