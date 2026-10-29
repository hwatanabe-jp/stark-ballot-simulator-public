# Mock zkVM

## Overview

The mock zkVM (`packages/node-adapters/src/zkvm/mock-executor.ts`) is a
JavaScript implementation of commitment checks, basic vote-shape checks, and
aggregation for fast development and testing. It computes the tally and bitmap
roots from the supplied input. Guest execution, Merkle inclusion-proof checks,
and STARK proof generation are outside this mock path.

## Runtime Profiles

`packages/runtime-config/src/env/runtimeProfile.ts` resolves one immutable
server profile before adapter construction.
`packages/node-adapters/src/zkvm/executor-factory.ts` receives that profile's
`proof` choice; independent environment flags do not select the executor.

Two profiles select the mock executor:

| Profile           | Session store | Browser API | Intended path                    |
| ----------------- | ------------- | ----------- | -------------------------------- |
| `local-demo`      | memory        | mock        | `pnpm dev`                       |
| `static-mock-e2e` | file          | same-origin | CLI and Playwright mock evidence |

```bash
# Browser-only development flow
pnpm dev

# Browserless session-to-verification smoke
pnpm test:cli:mock

# Production-built static frontend plus local Hono mock server
pnpm test:e2e:mock --grep @smoke --reporter=list
```

`scripts/start-test-server.sh` explicitly selects `static-mock-e2e` for its
owned local server. A manual `pnpm start` instead reads `RUNTIME_PROFILE` from
`.env.local`; the checked-in template selects `local-demo`.

The adjacent real-host profiles are deliberately distinct:

| Profile                   | Executor         | Evidence meaning                                 |
| ------------------------- | ---------------- | ------------------------------------------------ |
| `local-proof-development` | RISC Zero host   | fake development receipt; not a production proof |
| `local-proof-production`  | RISC Zero host   | genuine production STARK receipt                 |
| `target-aws-async`        | RISC Zero on ECS | production STARK evidence                        |

The develop-only `target-aws-async-quiesced` server profile has the same
production proof path as `target-aws-async`, but rejects new public sessions.
It is an operational admission posture, not another proof mode.

## Mock Behavior

The mock executor:

- Votes are verified according to actual commitment and basic vote-shape rules
- Commitment checks and included/seen bitmap roots use the same canonical helpers as the production contract
- Merkle inclusion proof verification is intentionally omitted in mock mode; use a real-host profile for proof-equivalent inclusion checks
- Tally reflects the actual vote distribution
- Bot votes are generated before finalization by the bot-voting service; the mock zkVM only verifies and tallies the input it receives
- The returned JavaScript receipt is an API-shaped test object, not
  cryptographic proof evidence

Mock execution therefore proves application flow and current TypeScript
behavior only. It does not prove guest execution, receipt soundness, ImageID
correctness for a built guest, or production verifier acceptance.

## E2E Testing Approach

Bot votes use a random production-like distribution, so E2E tests avoid fixed per-choice expectations. The result page checks UI tally consistency:

```typescript
const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);
expect(tallySum).toBe(totalVotes);
```

Verification E2E checks then assert scenario-specific summary, check, and step statuses from the verify page.

## Configuration

| Input                                             | Purpose                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `RUNTIME_PROFILE`                                 | Required server-side semantic profile selector                        |
| `VITE_RUNTIME_PROFILE`                            | Matching browser projection selected at build/dev startup             |
| `EXPECTED_IMAGE_ID` / `EXPECTED_IMAGE_ID_VARIANT` | Explicit ImageID or mapping variant used for mock receipt comparisons |

Unknown profiles and replaced selector flags fail closed during runtime-profile
resolution. The selected profile owns storage, proof evidence, finalization,
artifacts, rate limiting, runtime adapters, and Turnstile posture together.
`NODE_ENV` is not an executor selector.

For real local runs, build the binaries that match the intended evidence:

```bash
# Fake development receipt
pnpm build:zkvm:dev-mode
pnpm build:verifier-service:dev-mode
pnpm test:cli:real-dev

# Production STARK receipt
pnpm build:zkvm
pnpm build:verifier-service
pnpm test:cli:real-prod:s0
```

The node adapter derives the external RISC Zero host invocation environment
from the resolved proof profile immediately before spawning the child process.
That adapter-private translation is not an application runtime selector.

## Implementation Details

The executor factory logs the selected mock implementation:

```text
[zkVM] Using mock executor for fast testing
```

Unit tests use the normal repository command:

```bash
pnpm test:run
```

## Comparison with Real zkVM

| Feature                    | Mock profiles                       | Real development profile | Real production profiles  |
| -------------------------- | ----------------------------------- | ------------------------ | ------------------------- |
| Executor                   | JavaScript                          | RISC Zero host           | RISC Zero host            |
| Receipt evidence           | Mock object; no proof               | Fake development receipt | Production STARK receipt  |
| Commitment checks          | Canonical TypeScript implementation | Rust contract-core       | Rust contract-core        |
| Included/seen bitmap roots | Canonical TypeScript implementation | Rust contract-core       | Rust contract-core        |
| Merkle inclusion proofs    | Omitted                             | Verified in the guest    | Verified in the guest     |
| Intended claim             | Application-flow behavior           | Cross-implementation run | Production-proof evidence |

## Related Documentation

- [E2E Testing Guide](../../tests/e2e/README.md) - data-testid best practices
- [Test Scenarios](../../tests/e2e/helpers/test-helpers.ts) - Expected values for each scenario
- [Verify Page](../../apps/web/src/routes/verify/page.tsx) - verification flow and UI sequencing
