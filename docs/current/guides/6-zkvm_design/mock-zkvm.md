# Mock zkVM

## Overview

The Mock zkVM (`packages/node-adapters/src/zkvm/mock-executor.ts`) is a JavaScript implementation of the tally-side zkVM execution logic for development and testing. It verifies and tallies the supplied zkVM input, but it does not generate an actual STARK proof.

## Operating Modes

### 1. Normal Mode (Default)

**When**: Development and manual testing

**Behavior**: Verifies the supplied vote records and generates a tally based on that input

```bash
# Development server
USE_MOCK_ZKVM=true pnpm dev

# Manual testing
USE_MOCK_ZKVM=true ALLOW_INSECURE_ZKVM=true pnpm start
```

**Characteristics**:

- Votes are verified according to actual commitment and basic vote-shape rules
- Commitment checks and included/seen bitmap roots use the same canonical helpers as the production contract
- Merkle inclusion proof verification is intentionally omitted in mock mode; use real zkVM dev/prod mode for proof-equivalent inclusion checks
- Tally reflects the actual vote distribution
- Bot votes are generated before finalization by the bot-voting service; the mock zkVM only verifies and tallies the input it receives
- `pnpm start` does not set production mode by itself; mock E2E uses `scripts/start-test-server.sh`, which sets `NODE_ENV=production` and `ALLOW_INSECURE_ZKVM=true` for the test-only local server

### 2. E2E Testing Approach

Bot votes use a random production-like distribution, so E2E tests avoid fixed per-choice expectations. The result page checks UI tally consistency:

```typescript
const tallySum = tallyCounts.reduce((sum, count) => sum + count, 0);
expect(tallySum).toBe(totalVotes);
```

Verification E2E checks then assert scenario-specific summary, check, and step statuses from the verify page.

## Environment Variables

| Variable                                          | Values                      | Purpose                                                                                                  |
| ------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `USE_MOCK_ZKVM`                                   | `true` / `false`            | Select mock or real zkVM executor                                                                        |
| `NODE_ENV`                                        | `test`                      | Also selects the mock executor for Vitest and test-only paths                                            |
| `RISC0_DEV_MODE`                                  | `1`                         | RISC Zero/host dev-mode flag; real-host dev receipts are fake, insecure, non-production evidence         |
| `FORCE_DEV_MODE`                                  | `true`                      | App/CLI/test classification and target-runtime guard signal; not passed to the zkVM host by the executor |
| `ALLOW_INSECURE_ZKVM`                             | `true`                      | Permit mock/dev zkVM when `NODE_ENV=production` for CI or local testing                                  |
| `EXPECTED_IMAGE_ID` / `EXPECTED_IMAGE_ID_VARIANT` | explicit ImageID / `x86_64` | Resolve the mock receipt ImageID used by verification flows                                              |

## Implementation Details

### Console Output

```text
[zkVM] Using mock executor for fast testing
```

## Usage Examples

### Development

```bash
# Start dev server with Mock zkVM
USE_MOCK_ZKVM=true pnpm dev
```

### Unit Testing

```bash
# Vitest tests
pnpm test
```

## Comparison with Real zkVM

| Feature                    | Mock zkVM                                | Real zkVM             |
| -------------------------- | ---------------------------------------- | --------------------- |
| Execution Time             | ~100ms                                   | ~6 minutes (64 votes) |
| STARK Proofs               | No                                       | Yes                   |
| Commitment Checks          | Same                                     | Same                  |
| Included/Seen Bitmap Roots | Same canonical TypeScript implementation | Rust contract-core    |
| Merkle Inclusion Proofs    | Omitted                                  | Verified              |
| Receipt Format             | JavaScript object                        | RISC Zero Receipt     |
| Use Case                   | Development/Testing                      | Production/Audit      |

## Related Documentation

- [E2E Testing Guide](../../../../tests/e2e/README.md) - data-testid best practices
- [Test Scenarios](../../../../tests/e2e/helpers/test-helpers.ts) - Expected values for each scenario
- [Verify Page](../../../../apps/web/src/routes/verify/page.tsx) - verification flow and UI sequencing
