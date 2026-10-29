# Logging Runbook

> **Scope:** the deployed `stark-dev/develop` and `stark-prod/main` target runtimes.
> Develop remains operator-gated. Consult the private current AWS inventory for
> dated deployment and monitoring evidence for each target.
> Keep target logs useful without exposing private artifacts, capability tokens,
> vote openings, raw identifiers, or storage locations.

## Deployed logging contract

Each target has five structured-log producer shapes:

1. `public-api`, `proof-dispatcher`, `finalization-writer`,
   `verification-worker`, and `semaphore-janitor` use the shared diagnostics
   `logger`.
2. `image-signature-verifier` uses a dedicated logger that passes one
   closed-field, bounded object to the Lambda native JSON logger. This is the
   intentional exception to the shared-logger rule.
3. The ECS prover emits flat NDJSON `prover_summary` records.
4. The normalized operations ledger stores flat, allowlisted JSON records for
   deployment and runtime-change correlation.
5. REST API Gateway emits flat JSON access logs with bounded request metadata.

All six Lambda log groups use the Node.js JSON envelope. `timestamp`, `level`,
and `requestId` are outer fields; the application record is the `message`
object. The ECS prover and operations ledger remain flat. The ten-query
repository pack's Q1–Q7 and Q9–Q10 normalize `message.*` before their flat ECS
fallback, while Q8 reads the flat ledger. Lambda metric filters therefore use
`$.message.*`; a flat ECS selector is not interchangeable with a Lambda
selector.

`finalization_admitted` is the canonical start of the measurement-only
finalization cohort. The shared persistence observer attempts to emit it only
after an authoritative first `none` to `pending` write, with the exact event
projection `{ event: "finalization_admitted", finalization_id }`. It does not
include a session hash, transition fields, request data, vote data, or error
data. An idempotent retry does not emit another `finalization_admitted` event,
but log delivery may still be duplicated, so consumers deduplicate by the
bounded `finalization_id`.

Q9 measures completion against a 75-minute deadline from that admission and
waits a separate five-minute delayed-event grace before classifying the cohort.
The grace accommodates log delivery and does not extend the completion
deadline. A cohort that has not passed deadline plus grace is `inside_window`;
after that point, an eligible cohort is classified as good, bad, or stalled.
`eligible = 0` is `insufficient_evidence`, never 100% success and never a
breach. Q10 keeps closed expected-domain terminal reasons separate from
platform failures. Neither query gates deployment, changes application state,
or alters a verification verdict.

## Deployed instrumentation and open evidence

The retained develop rollout recorded the object-valued Lambda envelope, exact-field metric filters,
`finalization_admitted`, Q9–Q10 instrumentation, current normalized ledger
shape, and notification-only actionable path as deployed. Consult the private
current AWS inventory for each target's dated evidence. Deployment does not by
itself prove runtime event matching or query calibration.

The retained develop monitoring window at source `3c2f0353…` recorded completion
of all ten queries, plus readback and execution of the corrected saved
completion-cohort and terminal-reasons definitions. The window contained three
admissions and three terminal outcomes. This is bounded query evidence; it does
not establish long-term calibration, validate later source changes, or transfer
develop observations to production.

The exact post-rollout `verification_run_summary` envelope and metric-filter
match were not inspected during that retained develop acceptance journey and
remain unproven. Confirm remaining evidence gaps from a bounded, read-only window
after a normal future journey; do not generate
traffic, a verdict contradiction, or a notification solely to close these
evidence gaps. An empty result is insufficient evidence, not proof that an
event never occurred or that the runtime is healthy.

## Runtime configuration

For both `target-aws-async` and `target-aws-async-quiesced`, the target
observability configuration is mandatory and fail-closed:

- `LOG_FORMAT` must be `json`.
- `LOG_IP_HASH_SALT_REF` must identify the target secret reference.
- `LOG_IP_HASH_SALT` must be resolved from that reference and must not use the
  public local-development default.
- `DEPLOYMENT_ID` must be an opaque `dep_` plus 32 lowercase hexadecimal
  characters.
- `APP_SOURCE_SHA` must be the full selected 40- or 64-character lowercase
  hexadecimal source SHA.
- `DEPLOY_MODE` must be `normal` or `rollback`.

These are admitted logging values, not operational deployment selectors or
authorization for rollback. Current deployment procedures remain in the private
deployment-operation guides.

The salt supports stable, domain-separated hashes for IP addresses, session
IDs, and storage-key prefixes. A salt rotation changes those hashes, so split
operational queries at the rotation boundary.

The Lambda bootstrap receives the already resolved immutable profile and
selects Lambda-native JSON output from `profile.target.kind === "aws"`; it does
not reread a target-name flag. Non-target local profiles may omit
`LOG_IP_HASH_SALT`; they then use the public non-secret default for local
diagnostics only. That fallback is invalid for either deployed target.

## Privacy and non-regression boundaries

- Use the shared `logger` in application runtime paths except for the audited
  `image-signature-verifier` logger described above.
- Never log capability tokens, secret values, raw cookies, vote openings,
  private zkVM inputs, private artifact contents, presigned URLs, raw IP
  addresses, raw session IDs, full S3 keys or URIs, or local bundle paths.
- Production call sites must hash storage keys and paths before logging them.
  Use bounded `finalization_id` values for runtime lifecycle correlation and
  the allowlisted bounded `pipeline_execution_id` only in normalized ledger
  records. Keep both out of metric dimensions. Prefer the domain-separated
  `ip_*`, `sid_*`, and `key_*` hashes wherever raw identifiers or storage
  locations would otherwise be exposed.
- Keep debug-level records narrow, bounded, and temporary. Logging failure must
  not change application, verification, or cryptographic decisions.

The capability-protected browser observation request contains only four closed
cast-check statuses; session and finalization identity come from its canonical
path. It must not accept choice, random, commitment, receipt, capability token,
Cookie, scenario, or summary data from the browser. After validating and
recording that bounded input, the server reconstructs authority and may emit
`verification_run_summary` with server-derived `outcome`, `failure_category`,
`scenario_id`, `failed_required_count`, and `dev_mode_receipt`, plus safe
correlation fields.

The public Hono path has no request-scoped debug activation. Adding any debug
route, request header, query parameter, cookie, or environment control requires
a separate security review and authorization record.

## Troubleshooting

1. In the private source repository, check the current AWS inventory for
   deployed state, evidence lifetime, and known acceptance gaps.
2. Identify the producer and its exact envelope in the private monitoring log
   schema.
3. Use the private CloudWatch Logs Insights query pack and its safe-result
   boundary; do not maintain an ad hoc copy of its queries.

If expected Lambda records are missing, confirm that the query addresses
`message.*`, then confirm the logger bootstrap and target runtime references.
For Q9, confirm that the durable first `none` to `pending` write occurred and
that the query deduplicates the matching bounded `finalization_id`. Do not call
an `inside_window` cohort stalled before the 75-minute deadline and five-minute
delivery grace have elapsed, and do not interpret zero eligible rows as
success. Check the current inventory for the source and window covered by query
evidence, and keep long-term calibration and the exact
`verification_run_summary` filter match distinct from successful query execution.

For stuck finalizations, inspect the writer's scheduled reconciliation records.
The `finalization-sweep` rule invokes it every minute independently of API reads.
Candidate, SDK, or persistence failures fail the invocation and feed the writer
Errors alarm; the rule's passive `FailedInvocations` alarm covers exhausted
delivery retries. Candidate failure records retain only hashed session identity,
admitted finalization identity, and an allowlisted error name. The completion
summary counts visited index rows and failures, not completed transitions.

For request correlation, the REST gateway's `requestContext.extendedRequestId`
is the trusted application `request_id` and access-log `requestId`. Client
request IDs are untrusted and must not replace it. Missing trusted identity
fails invocation admission without logging the raw request. REST execution
logging and data tracing are disabled; use the bounded access logs and
application records for diagnosis.

For unstable IP or session correlation, verify that the query window does not
cross a salt rotation. If browser-origin requests fail before handlers run,
inspect the Hono CORS and same-origin policy tests rather than adding request
debug headers.

## Implementation references

- Shared logger: `packages/diagnostics/src/logger.ts`
- Hashing helpers: `packages/diagnostics/src/logging.ts`
- Request context: `packages/diagnostics/src/requestLogContext.ts`
- Lambda logger bootstrap: `infra/lambdas/runtimeBootstrap.ts`
- Target observability validation:
  `packages/runtime-config/src/env/observability.ts`
- Request metadata and IP hashing:
  `apps/api/src/server/http/requestLogging.ts`
- REST invocation admission and access logs:
  `infra/lambdas/public-api/handler.ts`, `infra/terraform/app/api_gateway.tf`
- Hono route binding and CORS headers:
  `apps/api/src/server/api/routes/hono.ts`
- Verification observation:
  `apps/api/src/server/api/handlers/verificationObservation.ts`
- Canonical verification event:
  `apps/api/src/server/api/handlers/verificationObservability.ts`
- Canonical lifecycle event registry:
  `packages/diagnostics/src/canonicalEvents.ts`
- Post-persistence finalization observer:
  `packages/aws-adapters/src/finalize/finalizationTransitionObservability.ts`
- Scheduled reconciliation and delivery alarm:
  `packages/aws-adapters/src/finalize/reconcileFinalizations.ts`,
  `infra/terraform/app/finalization_sweep.tf`
- Finalization cohort classifier:
  `scripts/aws/lib/finalization-sli.ts`
- Executable query pack and smoke:
  `scripts/aws/observability-query-pack.ts`,
  `scripts/aws/smoke-observability-queries.ts`
- Metric filters, saved queries, and actionable routing:
  `infra/terraform/app/observability_detection.tf`
- Normalized operations ledger:
  `infra/terraform/app/ops_ledger.tf`
