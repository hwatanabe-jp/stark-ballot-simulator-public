# Security Runbook

> **Scope:** the deployed development and production target runtimes. Develop
> uses the operator gate; main uses authenticated Cloudflare ingress and
> server-verified Turnstile. Dated observations remain evidence for their stated
> runs only. The legacy Cloudflare Challenge Page procedure in the appendix is
> not target AWS authority.

This runbook supports evidence-first diagnosis. It does not authorize an AWS
configuration change, a rate-limit override, a Turnstile bypass, a recovery
transition, or a deployment. Use
[`aws-runtime-operations.md`](./aws-runtime-operations.md) for target triage and
the private deployment guide to select an authorized change lane.

## Current Target Edge Posture

The targets intentionally do not deploy AWS WAF. Admission differs by target:

| Boundary             | Develop                                                                         | Main                                                                                           |
| -------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Browser entrance     | CloudFront hostname protected by signed operator cookies                        | Public hostname through authenticated Cloudflare-to-CloudFront forwarding                      |
| Public API client IP | API Gateway source IP (`TRUSTED_PROXY=api-gateway`)                             | Valid authenticated `CF-Connecting-IP` (`TRUSTED_PROXY=cloudflare`), with no proxy-IP fallback |
| Turnstile            | Disabled only behind the verified origin path and operator gate                 | Required for session creation, voting, and finalization                                        |
| Recovery containment | Explicit `target-aws-async-quiesced` profile for separately authorized recovery | No quiesced runtime profile                                                                    |

Both targets use private S3 delivery through CloudFront OAC, CloudFront
forwarding for `/api` and `/api/*`, and a separate CloudFront-injected origin
secret required by the application on every target API route. DynamoDB-backed
application limits, API Gateway stage throttling (burst 50, rate 25),
privacy-bounded logs, and passive/actionable/invariant monitoring provide
additional controls. Pipeline smoke and the state-creating target flow are
distinct evidence; a successful deployment does not prove every security check.

The repository does not define CloudFront standard or real-time access-log
resources. Do not describe CloudFront request logs as available target evidence
or substitute them for API Gateway access logs. The current structured-event
and query contracts also do not define a dedicated source-IP-trust-failure
event or metric filter. A missing usable client IP fails the rate-limited
request closed; investigate it through the bounded request summary and
response evidence without claiming a dedicated detector.

## CloudFront and API Gateway Admission

### Ordered ingress checks

On main, requests pass through Cloudflare, CloudFront, and API Gateway before
reaching Hono. Every CloudFront viewer-request behavior requires the independent
Cloudflare request-header token, the configured public hostname, and a
single client-IP header. Only the token's SHA-256 verifier is retained in
source/state. CloudFront removes the admitted token before forwarding the
request; the token is neither a browser credential nor an API-origin secret.
Missing, duplicated, or malformed admission headers fail with an edge `403`.
Direct distribution access remains rejected even when a caller forges a
Cloudflare client-IP header. Cloudflare bypasses caching for the production
hostname so CloudFront remains the static-cache owner.

The main public API accepts only a valid IPv4 or IPv6 `CF-Connecting-IP` from
this authenticated path. Missing or malformed values do not fall back to
`X-Forwarded-For`, `X-Real-IP`, or an API Gateway/shared proxy address. Terraform
orders application Lambda changes after distribution deployment so the API
cannot trust this header before all viewer behaviors enforce the token.
Develop instead uses its signed-cookie gate and API Gateway source-IP selection.

The API Gateway execute endpoint remains enabled as the CloudFront origin.
CloudFront injects a separate private origin-verification header, and target
Hono rejects a request without the expected value with
`403 SAME_ORIGIN_REQUIRED` before loading the session store or running a handler.
Keep the Cloudflare ingress token and CloudFront-to-API origin secret distinct.
Never retrieve, expose, copy, or add either secret to a direct client to make a
negative probe pass.

### Admission evidence

Use the configured same-origin target hostname for positive browser/CLI evidence:
signed operator access on develop, authenticated Cloudflare ingress and Turnstile
on main. Direct-origin smoke is negative evidence: call the execute endpoint
without the private origin header and require `SAME_ORIGIN_REQUIRED`.
Successful direct-origin application access is a security incident.

Distinguish where a rejection occurred:

| Observation                                       | Boundary to inspect                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cloudflare challenge/error page                   | Cloudflare rules or service state; it is separate from application Turnstile |
| Plain CloudFront edge `403` before API forwarding | Develop cookie gate, or main hostname/token/header admission                 |
| API `SAME_ORIGIN_REQUIRED`                        | CloudFront-to-API origin verification                                        |
| API `CAPTCHA_FAILED`                              | Server-side Turnstile token/action/hostname validation                       |
| Rate-limit rejection or unavailable client IP     | Target-specific IP trust, quota, and DynamoDB dependency evidence            |

Correlate response shape and request IDs with API Gateway access logs and bounded
application summaries. An edge-rejected request may never reach API Gateway;
missing API logs are not proof of successful edge admission. Do not claim a
CloudFront request-log stream or dedicated IP-trust detector that the repository
does not configure.

## Turnstile Operations

### Runtime modes

- Runtime choices come from the immutable server `RUNTIME_PROFILE` and browser
  `VITE_RUNTIME_PROFILE`; there are no independent browser/server bypass or
  session-create selectors.
- `local-demo`, `static-mock-e2e`, `local-proof-development`, and
  `local-proof-production` are the only bypass-eligible profiles. They are
  local/test profiles, not deployable target configurations.
- `target-aws-async` uses the target-specific admission in the comparison above.
  Develop's operator-gated path is not public Turnstile validation evidence.
  Main requires server-side tokens for session creation, voting, and finalization;
  missing/invalid tokens, mismatched actions, and unreviewed hostnames fail closed.
- `target-aws-async-quiesced` is develop-only recovery containment. It retains
  the target storage/proof contract while rejecting new public sessions, and
  requires the separately authorized recovery transition.

### Provisioning and failure behavior

- Use the reviewed widget/sitekey and allowed public hostname. Widget display
  mode is configured in Cloudflare; it does not change server-side admission.
- Publish the site key through the target browser configuration reference for
  `VITE_TURNSTILE_SITE_KEY`.
- Store the secret in the target runtime secret source referenced by
  `TURNSTILE_SECRET_KEY_REF`; never place raw secret material in Terraform
  variables, command lines, logs, or documentation.
- Server validation checks the token, expected action, and allowed hostname.
- A validation failure returns `CAPTCHA_FAILED`. The frontend surfaces
  `errors.captchaFailed`, clears the failed token, and allows the widget to
  issue a fresh token.

### Invisible display and privacy disclosure

A widget configured as **Invisible** may perform verification in the background
without displaying a checkbox. A hidden widget must still issue the token that
the server validates; absence of a visible challenge is not a bypass or proof
that validation succeeded. The application widget does not hard-code the
Cloudflare dashboard mode, and this runbook does not claim a fresh observation
of that setting.

The current [privacy page](../../apps/web/src/routes/privacy/page.tsx) discloses
background Turnstile verification and possible transmission of tokens and request
information, including IP addresses, to Cloudflare. It includes the Turnstile
Privacy Addendum link. Preserve that disclosure when changing display behavior.
Full-page Managed Challenges are separate Cloudflare rules, not the Invisible
widget or evidence of application token validation.

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

Terraform fixes each target's public API proxy mode as described under
[ingress checks](#ordered-ingress-checks). Do not edit a Lambda environment
variable or use the AWS console to change a limit during an incident. A target rate-limit, API throttle, or trusted-proxy change is a
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
correlated with API errors, DynamoDB evidence, and the selected App acceptance.
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

The retained August 11 manual S0 observation supplies browser-observation and
verification-run metric evidence for that run. The September 7 browserless
gated S0/S1/S2 acceptance did not submit browser-observation telemetry or repeat
the CloudWatch metric, alarm, or monitoring-window readback. Consult the current
inventory for the date and scope of any metric-filter matching claim.
Notification delivery remains separately unproven; a test requires its own
authorization. Do not generate traffic, a false verification contradiction, or
an SNS notification solely to obtain additional evidence.

## Incident Response

### Admission or bot pressure

1. Verify the AWS identity, region, incident window, selected App acceptance, and
   whether the request used the configured target hostname, a direct CloudFront
   distribution address, or the API origin.
2. Classify the response using [admission evidence](#admission-evidence), then
   inspect API Gateway count/4xx/5xx and access logs, Q6, application summaries,
   DynamoDB rate-limit health, and the configured stage throttle. Account for
   requests rejected before the API.
3. Separate expected gate/origin/capability rejection, one demo client burst,
   and sparse/no-data behavior from sustained abuse or platform failure. On main,
   diagnose authenticated Cloudflare client-IP delivery without substituting
   proxy addresses.
4. Preserve request IDs and privacy-bounded evidence. Do not copy raw IPs,
   capabilities, cookies, either ingress/origin secret, or private request bodies.
5. If a code/configuration change is justified, use the full App saved-plan
   lane. Do not lower or raise a target limit with an ad hoc environment or
   console edit.

### Turnstile outage

- Do not reintroduce bypass flags or mutate the selected profile in a warm
  process. Local-only work may select one of the declared local profiles.
- The current operator-gated develop path retains the outer gate and
  origin-header boundary; its success does not establish main Turnstile health
  or authorize public fail-open behavior.
- If the separately authorized recovery procedure requires containment,
  `target-aws-async-quiesced` rejects new public sessions while preserving the
  target storage/proof contract. An incident alone does not authorize that
  transition.
- The production public path must remain Turnstile-enforced or closed. Any exception requires a named authorization with owner, scope,
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
admits every asset. Validate deployed headers only through an authorized
smoke using the target's configured admission path, and record the result without gate cookies,
secret headers, or account-specific identifiers.

## Target Container Image Security

Current target images are built or selected and promoted only through the
dedicated Toolchain and Prover release lanes. Their immutable candidate/release
records retain digest-bound source, provenance, and scan evidence. The App
consumes the accepted record chain; mutable tags, direct CodeBuild starts, local
pushes, and operator-transcribed digests are not deployment authority.

- Toolchain images are unsigned and are not cryptographically verified.
  Their HIGH/CRITICAL findings are accepted and non-blocking under the PoC
  policy. Retain `scanStatus` and `criticalHighCount`; no disposition-ID or
  waiver input, per-finding review, or remediation is required.
- Prover release admission fails on HIGH/CRITICAL findings and requires managed
  signing readiness plus ImageID/method and build evidence. Digest-level ECR
  signing status is readiness evidence, not cryptographic verification.
- Neither image lane cryptographically verifies candidates or promotions.
  App preflight verifies the exact selected Prover digest and configured signing
  authority through the packaged verifier, including its trust and revocation
  checks.
- Step Functions invokes the qualified runtime verifier alias to cryptographically
  verify the selected Prover digest before launching ECS. Failure remains closed.
- The accepted App authority, current inventory, runtime profile, verifier alias,
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
  apps/api/src/server/api/security/turnstile.test.ts \
  apps/web/src/components/security/TurnstileWidget.test.tsx \
  infra/terraform/app/frontend-viewer-request.test.ts \
  scripts/tests/develop-gated-smoke.test.ts \
  scripts/aws/observability-query-pack.test.ts \
  infra/terraform/bootstrap/bootstrap-terraform-policy.app-runtime.test.ts
pnpm public-safety:scan
pnpm docs:links:check -- --root .
```

`pnpm ci:verify` remains the complete local TypeScript/UI gate, and CI runs the
public-safety scan separately. Mock and repository tests do not replace an
authorized target smoke using its configured admission path or production-proof
evidence.

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
