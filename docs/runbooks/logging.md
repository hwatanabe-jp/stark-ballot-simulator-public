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
object. The ECS prover and operations ledger remain flat. Logs Insights Q1–Q7
normalize `message.*` before their flat ECS fallback, while Q8 reads the flat
ledger. Lambda metric filters therefore use `$.message.*`; a flat ECS selector
is not interchangeable with a Lambda selector.

The corrected object-valued Lambda envelope and exact-field metric filters are
deployed. Live matching is not yet proven, however: the latest reconciliation
found no post-rollout `verification_run_summary` event. Confirm the envelope
and filter match during a normal future verification journey; do not generate
traffic or a verdict contradiction solely to close that evidence gap.

## Runtime configuration

For `TARGET_AWS_RUNTIME=1`, logging configuration is mandatory and fail-closed:

- `LOG_FORMAT` must be `json`.
- `LOG_IP_HASH_SALT_REF` must identify the target secret reference.
- `LOG_IP_HASH_SALT` must be resolved from that reference and must not use the
  public local-development default.

The salt supports stable, domain-separated hashes for IP addresses, session
IDs, and storage-key prefixes. A salt rotation changes those hashes, so split
operational queries at the rotation boundary.

Non-target local runtimes may omit `LOG_IP_HASH_SALT`; they then use the public
non-secret default for local diagnostics only. Do not describe that fallback as
valid for the deployed environment named `develop`.

## Privacy and non-regression boundaries

- Use the shared `logger` in application runtime paths except for the audited
  `image-signature-verifier` logger described above.
- Never log capability tokens, secret values, raw cookies, vote openings,
  private zkVM inputs, private artifact contents, presigned URLs, raw IP
  addresses, raw session IDs, full S3 keys or URIs, or local bundle paths.
- Production call sites must hash storage keys and paths before logging them.
  Prefer bounded execution IDs and the domain-separated `ip_*`, `sid_*`, and
  `key_*` hashes for correlation.
- Keep debug-level records narrow, bounded, and temporary. Logging failure must
  not change application, verification, or cryptographic decisions.

The capability-protected browser observation request contains only the current
verification execution ID and four closed cast-check statuses. It must not
accept choice, random, commitment, receipt, capability token, Cookie, scenario,
or summary data from the browser. After validating and recording that bounded
input, the server reconstructs authority and may emit
`verification_run_summary` with server-derived `outcome`, `failure_category`,
`scenario_id`, `failed_required_count`, and `dev_mode_receipt`, plus safe
correlation fields.

Request-scoped debug activation is retired. The shared Hono path must not
restore `/api/debug/enable`, `X-Debug-Log`, debug query parameters or cookies,
or the retired `DEBUG_LOG_*` environment controls without a separate security
review and authorization record.

## Troubleshooting

1. In the private source repository, check the current AWS inventory for
   deployed state, evidence lifetime, and known acceptance gaps.
2. Identify the producer and its exact envelope in the private monitoring log
   schema.
3. Use the private CloudWatch Logs Insights query pack and its safe-result
   boundary; do not maintain an ad hoc copy of its queries.

If expected Lambda records are missing, confirm that the query addresses
`message.*`, then confirm the logger bootstrap and target runtime references.
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
