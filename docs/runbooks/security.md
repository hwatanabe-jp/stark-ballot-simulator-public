# Security Runbook

> **Scope:** the deployed, operator-gated `stark-dev/develop` target runtime.
> `stark-prod/main` has not been deployed, validated, or approved. The legacy
> Cloudflare Challenge Page procedure is retained in the appendix and is not
> target AWS authority.

This runbook supports evidence-first diagnosis. It does not authorize an AWS
configuration change, a rate-limit override, a Turnstile bypass, a recovery
transition, or a deployment. Use
[`aws-runtime-operations.md`](./aws-runtime-operations.md) for target triage and
the private deployment guide to select an authorized change lane.

## Current Target Edge Posture

The target intentionally does not deploy AWS WAF. For the current
operator-gated develop runtime, the compensating controls are:

- the CloudFront signed-cookie operator gate on the develop hostname;
- private S3 delivery through CloudFront OAC;
- `/api` and `/api/*` forwarding from CloudFront to the HTTP API Gateway
  origin;
- a CloudFront-injected origin-verification header that the application
  requires on every target API route;
- application rate limits backed by the target DynamoDB tables;
- API Gateway `$default` stage throttling at burst 50 and rate 25;
- trusted API Gateway source-IP extraction;
- API Gateway access logs and privacy-bounded application logs;
- passive, actionable, and invariant monitoring described below; and
- gated smoke evidence for the current session, vote, finalization,
  verification, capability, artifact, and direct-origin rejection paths.

The repository does not define CloudFront standard or real-time access-log
resources. Do not describe CloudFront request logs as available target evidence
or substitute them for API Gateway access logs. The current structured-event
and query contracts also do not define a dedicated source-IP-trust-failure
event or metric filter. A missing usable client IP fails the rate-limited
request closed; investigate it through the bounded request summary and
response evidence without claiming a dedicated detector.

## Turnstile Operations

### Runtime modes

- Runtime choices come from the immutable server `RUNTIME_PROFILE` and browser
  `VITE_RUNTIME_PROFILE`; there are no independent browser/server bypass or
  session-create selectors.
- `local-demo`, `static-mock-e2e`, `local-proof-development`, and
  `local-proof-production` are the only bypass-eligible profiles. They are
  local/test profiles, not deployable target configurations.
- `target-aws-async` on `develop` is operator-gated. Session creation, vote,
  and finalization are admitted only through the outer gate and the verified
  CloudFront origin path; this is not public Turnstile evidence.
- `target-aws-async-quiesced` is develop-only recovery containment. It keeps
  the target storage/proof contract while rejecting public session creation.
  Selecting it requires the separately authorized recovery transition.
- The repository-only `target-aws-async` projection for `main` requires
  Turnstile and keeps public session creation closed. Enabling a future public
  path requires an explicit semantic-profile/code change and production
  authorization, not an environment override.

### Provisioning and failure behavior

- Provision the Managed widget for the reviewed target public hostname.
- Publish the site key through the target browser configuration reference for
  `VITE_TURNSTILE_SITE_KEY`.
- Store the secret in the target runtime secret source referenced by
  `TURNSTILE_SECRET_KEY_REF`; never place raw secret material in Terraform
  variables, command lines, logs, or documentation.
- Server validation checks the token, expected action, and allowed hostname.
- A validation failure returns `CAPTCHA_FAILED`. The frontend surfaces
  `errors.captchaFailed`, clears the failed token, and allows the widget to
  issue a fresh token.

## CloudFront and API Gateway Admission

The API Gateway execute endpoint remains enabled because it is the CloudFront
origin. Enabled does not mean directly usable. CloudFront injects the private
origin-verification header, and the target Hono application rejects a request
without the expected value with `403 SAME_ORIGIN_REQUIRED` before loading the
session store or running a route handler.

Use the signed, same-origin CloudFront `/api/*` path for browser, CLI, and
positive gated-smoke evidence. The direct-origin smoke is negative evidence: it
must call the execute endpoint without the private origin header and prove the
exact `SAME_ORIGIN_REQUIRED` rejection. Never retrieve, expose, copy, or add the
origin-header value to a direct client to make that probe pass. Successful
direct-origin application access is a security incident.

## Rate Limiting

The current application limits are:

- `POST /api/sessions`: dedicated per-IP limiter, default 30 requests/minute
  (`SESSION_CREATE_RATE_LIMIT`, `SESSION_CREATE_RATE_LIMIT_WINDOW_MS`, and
  `SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS`);
- `POST /api/sessions/:sessionId/votes`: per-IP limiter, default 10
  requests/minute (`VOTE_RATE_LIMIT`, `VOTE_RATE_LIMIT_WINDOW_MS`, and
  `VOTE_RATE_LIMIT_MAX_BUCKETS`);
- `POST /api/sessions/:sessionId/finalizations` and
  `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`:
  per-IP zkVM limit, default 50 successful executions/24 hours, plus global
  defaults of 100/hour and 1,000/day;
- `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel`:
  dedicated per-IP limiter, default 5 requests/minute
  (`FINALIZE_CANCEL_RATE_LIMIT`, `FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS`, and
  `FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS`); and
- API Gateway `$default` stage throttling, owned by
  `local.api_throttle_burst_limit` and `local.api_throttle_rate_limit` in
  `infra/terraform/app/locals.tf`.

Local profiles use in-memory rate-limit storage. Target AWS profiles use the
two DynamoDB rate-limit tables and fail closed on storage errors. Invalid vote
or zkVM attempts use the bounded attempt limit; global zkVM quotas are recorded
only after successful execution. `MAX_SESSIONS` separately rejects session
creation with `SESSION_LIMIT_EXCEEDED` when the active-session cap is reached.

The target fixes `TRUSTED_PROXY=api-gateway` through Terraform. Do not edit a
Lambda environment variable or use the AWS console to change a limit during an
incident. A target rate-limit, API throttle, or trusted-proxy change is a
reviewed application/configuration change through the full App saved-plan lane.

## Finalization and Verification Admission

- `POST /api/sessions/:sessionId/finalizations`,
  `GET /api/sessions/:sessionId/finalizations/current`, and
  `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel` derive
  session identity from the path and require `X-Session-Capability`.
- Create/current/cancel use one `finalizationId` and the same strict
  `FinalizationResource`; there is no body/header identity fallback.
- Verification read/run/observation use that same identity at
  `/api/sessions/:sessionId/finalizations/:finalizationId/verification`, with
  `/observations` for telemetry. They require the matching capability and
  reject path/finalization mismatch. Run accepts a strict empty body;
  observation accepts only `{ castChecks: ... }`.
- The local/full-mode callback is
  `POST /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback`.
  It is registered before CORS only in the full Hono runtime and is absent from
  the public route inventory and API Gateway Lambda mode.
- Callback admission verifies the HMAC over the bounded raw body, then requires
  the path `sessionId` and `finalizationId` to equal the parsed payload
  identity. It is not a browser, CLI, or target AWS contract.

## Monitoring and Alerts

Use the repository-owned query pack rather than maintaining ad hoc copies of
status-code queries. Q6, **Admission and abuse pressure**, reads the public API
log and counts the structured `rate_limit_hit` and `turnstile_failed` events by
hour. `rate_limit_error` remains a storage/dependency failure and should be
correlated with API errors, DynamoDB evidence, and the accepted deployment.
Expected 4xx admission, auth, origin, capability, rate-limit, and input
rejections are excluded from the API 5xx failure numerator.

The deployed target monitoring boundary is:

- one-period passive detectors for named Lambda errors/throttles, API Gateway
  5xx, DynamoDB throttles, Step Functions failures/timeouts, DLQ depth, and work
  queue age;
- damped actionable alarms for sustained DLQ depth, sustained queue age, and
  API 5xx only when each of three five-minute periods has at least 20 requests,
  at least five 5xx responses, and a greater-than-five-percent 5xx rate; and
- the isolated verification-invariant contradiction alarm, which is the only
  direct security notification route and never changes a verification verdict.

There is no deployed status-code metric family or alarm with the retired
`>100 events/hour` or `>3x baseline` policy. There is also no dedicated
Turnstile/rate-limit actionable alarm: Q6 is diagnostic evidence, and an
operations notification never authorizes remediation.

The retained inventory currently marks exact post-rollout verification metric
filter matching and separately authorized notification-delivery testing as
distinct open evidence. Do not generate traffic, a false verification
contradiction, or an SNS notification solely to close those gaps. Consult the
current inventory before claiming that a filter matched a live event or that a
notification was delivered.

## Incident Response

### Admission or bot pressure

1. Verify the AWS identity, region, incident window, accepted deployment, and
   whether the request used the gated hostname or direct origin.
2. Inspect API Gateway count/4xx/5xx and access logs, Q6, application request
   summaries, DynamoDB rate-limit health, and the configured stage throttle.
3. Separate expected gate/origin/capability rejection, one demo client burst,
   and sparse/no-data behavior from sustained abuse or platform failure.
4. Preserve request IDs and privacy-bounded evidence. Do not copy raw IPs,
   capabilities, cookies, origin-header values, or private request bodies.
5. If a code/configuration change is justified, use the full App saved-plan
   lane. Do not lower or raise a target limit with an ad hoc environment or
   console edit.

### Turnstile outage

- Do not reintroduce bypass flags or mutate the selected profile in a warm
  process. Local-only work may select one of the declared local profiles.
- The current operator-gated develop path retains the outer gate and
  origin-header boundary; it is not evidence that a future public Turnstile
  path may fail open.
- If the separately authorized recovery procedure requires containment,
  `target-aws-async-quiesced` rejects new public sessions while preserving the
  target storage/proof contract. An incident alone does not authorize that
  transition.
- A future protected production public path must remain Turnstile-enforced or
  closed. Any exception requires a named authorization with owner, scope,
  rationale, compensating controls, review/deletion gate, and validation
  evidence.
- Record the affected path and interval, selected posture, evidence, and
  authorized recovery or roll-forward.

### Security escalation

Escalate and preserve evidence for successful direct-origin application access,
capability or private-artifact exposure, unexpected origin-gate bypass,
unbounded/raw sensitive logging, image-signature-verifier bypass, or a
verification-invariant contradiction. Telemetry may initiate diagnosis only;
it must not approve a plan, alter AWS/application state, retry a cryptographic
red result, or change a verification verdict.

## CSP and Security Headers

The CloudFront response-headers policy in
`infra/terraform/app/frontend_static.tf` owns the target CSP, HSTS,
frame-options, content-type-options, referrer policy, XSS protection, and
Permissions Policy. The distribution applies that policy to both static and
API cache behaviors. The local static Hono server intentionally sets only the
minimal headers required by its test-server role and does not implement the
target CloudFront policy.

Use the Terraform contract tests to prove the repository configuration. Mock
Playwright proves application behavior behind the local static server; it does
not prove that deployed CloudFront headers are present or that the deployed CSP
admits every asset. Validate deployed headers only through an authorized gated
smoke against the target hostname, and record the result without gate cookies,
secret headers, or account-specific identifiers.

## Target Container Image Security

Current target images are built and promoted only through the dedicated
Toolchain and Prover release lanes. Candidate evidence is digest-bound and
includes scan, signing, provenance, source, and, for the Prover, ImageID/method
version checks. The App consumes the accepted record chain; mutable tags,
direct CodeBuild starts, local pushes, and operator-transcribed digests are not
deployment authority.

- The Prover lane fails on HIGH or CRITICAL findings.
- The Toolchain lane retains digest-bound findings as accepted and non-blocking
  under the repository PoC policy. When a disposition ID is required, it cites
  that policy; promotion does not imply per-finding remediation.
- Both image lanes cryptographically verify the exact digest, signing profile,
  certificate chain, trust policy, and revocation state for the candidate and
  again for promotion. Digest-level ECR signing status alone is bounded
  readiness evidence.
- Step Functions invokes the qualified runtime verifier alias to verify the
  selected Prover digest cryptographically before launching ECS.
- The accepted App record, current inventory, runtime profile, verifier alias,
  and selected image authority must agree. A retired flag, status-only gate,
  tag, or live resource observation alone is not authority.

Use the [infrastructure guide](../infrastructure/README.md) and
[RISC Zero ARM64 toolchain guide](../infrastructure/risc0-base-image.md) for the
public-safe model. Account-specific release and acceptance procedures remain in
the private deployment documentation.

## Focused Validation

For repository changes affecting these boundaries, run the narrowest relevant
tests first:

```bash
pnpm exec vitest run \
  apps/api/src/server/api/routes/hono.test.ts \
  apps/api/src/server/api/middleware/rateLimit.test.ts \
  scripts/__tests__/develop-gated-smoke.test.ts \
  scripts/__tests__/observability-query-pack.test.ts \
  scripts/__tests__/bootstrap-terraform-policy.app-runtime.test.ts
pnpm public-safety:scan
pnpm docs:links:check -- --root .
```

`pnpm ci:verify` remains the complete local TypeScript/UI gate, and CI runs the
public-safety scan separately. Mock and repository tests do not replace an
authorized gated target smoke or production-proof evidence.

## Appendix: Legacy Cloudflare Challenge Page

> **Legacy status recorded 2026-01-04:** the externally hosted legacy/live
> path used Cloudflare-proxied DNS and a Managed Challenge on `/vote`,
> `/aggregate`, and `/verify`. This dated record is not evidence about the
> current target AWS deployment, its operator gate, or its no-WAF controls.

The retained legacy procedure was:

1. Keep the legacy application DNS record **Proxied**; DNS Only disables the
   Challenge Page.
2. In Cloudflare Security → WAF → Custom Rules, apply **Managed Challenge** to
   `/vote`, `/aggregate`, and `/verify`.
3. Use Managed Turnstile pre-clearance.
4. Treat any temporary legacy Security Rule exception as a separately recorded
   legacy operation with a removal gate.

Do not apply this appendix to the target develop hostname, use a Cloudflare rule
as target AWS evidence, or infer that a legacy exception authorizes any target
API, Turnstile, rate-limit, origin, or deployment change.
