# Logging Runbook

> Purpose: keep production and target-runtime logs useful without exposing
> private artifacts, capability tokens, vote openings, or raw identifiers.

## Current Controls

- Application code should log through `logger`; avoid `console.log` in runtime
  paths.
- `packages/diagnostics/src/logger.ts` supports configurable levels and JSON
  output through `configureLogger()`, but current target entrypoints do not wire
  `LOG_LEVEL` or `LOG_FORMAT` as runtime controls.
- Set `LOG_IP_HASH_SALT` to a secret, environment-specific value when stable
  hashed IP correlation is required. If it is unset, logs still hash IPs with
  a non-secret default salt suitable only for local/development diagnostics.

## Retired Request Activation

Request-scoped debug activation has been removed from the target runtime. The
shared Hono request path no longer accepts:

- `GET /api/debug/enable`
- `X-Debug-Log`
- `stark_ballot_debug` or `debug` query activation
- debug cookies
- `DEBUG_LOG_SECRET`, `DEBUG_LOG_MAX_TTL_SECONDS`, or
  `DEBUG_LOG_COOKIE_SECURE`

Do not reintroduce those controls as compatibility paths. Any future
operator-only diagnostic mechanism needs a separate security review,
authorization record, and documentation before implementation.

## Sensitive Data Rules

- Never log capability tokens, secret values, raw cookies, vote openings,
  private zkVM inputs, private artifact contents, or presigned URLs.
- Prefer stable hashes or short opaque identifiers for correlation. Current
  worker and local-debug paths may include bundle keys or local bundle paths in
  failure/debug logs; do not include private artifact contents in those logs.
- Keep debug-level logs narrow and temporary. Promote only information that is
  safe and useful during normal operations.

## Troubleshooting

- If expected logs are missing, confirm the logger configuration path and
  runtime environment variables in the deployment configuration.
- If source IP correlation is unstable across deploys, confirm
  `LOG_IP_HASH_SALT` is consistently configured for that environment.
- If browser-origin API calls fail before application handlers run, check the
  Hono CORS and same-origin policy tests rather than adding request debug
  headers.

## Implementation References

- Logger: `packages/diagnostics/src/logger.ts`
- Request context: `packages/diagnostics/src/requestLogContext.ts`
- Request metadata and IP hashing: `apps/api/src/server/http/requestLogging.ts`
- Hono route binding and CORS headers: `apps/api/src/server/api/routes/hono.ts`
