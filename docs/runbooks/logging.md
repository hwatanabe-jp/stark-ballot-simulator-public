# Logging Runbook

> **Scope:** the deployed, operator-gated `stark-dev/develop` target runtime.
> There is no deployed or validated `stark-prod/main` logging surface. Keep
> target logs useful without exposing private artifacts, capability tokens,
> vote openings, raw identifiers, or storage locations.

## Deployed logging contract

The target has four structured-log producer shapes:

1. `public-api`, `proof-dispatcher`, `finalization-writer`,
   `verification-worker`, and `semaphore-janitor` use the shared diagnostics
   `logger`.
2. `image-signature-verifier` uses a dedicated logger that passes one
   closed-field, bounded object to the Lambda native JSON logger. This is the
   intentional exception to the shared-logger rule.
3. The ECS prover emits flat NDJSON `prover_summary` records.
4. The normalized operations ledger stores flat, allowlisted JSON records for
   deployment and runtime-change correlation.

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

The object-valued Lambda envelope, exact-field metric filters,
`finalization_admitted`, Q9–Q10 instrumentation, current normalized ledger
shape, and notification-only actionable path are deployed. Deployment does not
by itself prove runtime event matching or query calibration.

The exact post-rollout `verification_run_summary` envelope and metric-filter
match were not inspected during the retained acceptance journey, so that match
is not established. The ten-query live smoke and finalization-cohort
calibration likewise have no retained execution evidence. Confirm them from a
bounded, read-only window after a normal future journey; do not generate
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

The salt supports stable, domain-separated hashes for IP addresses, session
IDs, and storage-key prefixes. A salt rotation changes those hashes, so split
operational queries at the rotation boundary.

The Lambda bootstrap receives the already resolved immutable profile and
selects Lambda-native JSON output from `profile.target.kind === "aws"`; it does
not reread a target-name flag. Non-target local profiles may omit
`LOG_IP_HASH_SALT`; they then use the public non-secret default for local
diagnostics only. Do not describe that fallback as valid for the deployed
environment named `develop`.

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
success. Check the current inventory before claiming that the ten-query smoke,
cohort calibration, or exact `verification_run_summary` filter match has been
proven.

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
- Finalization cohort classifier:
  `scripts/aws/lib/finalization-sli.ts`
- Executable query pack and smoke:
  `scripts/aws/observability-query-pack.ts`,
  `scripts/aws/smoke-observability-queries.ts`
- Metric filters, saved queries, and actionable routing:
  `infra/terraform/app/observability_detection.tf`
- Normalized operations ledger:
  `infra/terraform/app/ops_ledger.tf`
