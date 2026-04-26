# Mock zkVM

## Overview

The Mock zkVM (`mock-executor.ts`) provides a JavaScript-based implementation of the zkVM execution logic for development and testing purposes. It mimics the behavior of the real RISC Zero zkVM without generating actual STARK proofs.

## Operating Modes

### 1. Normal Mode (Default)

**When**: Development and manual testing

**Behavior**: Dynamically verifies votes and generates tally based on actual input

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
- Results vary based on random bot vote generation
- `pnpm start` runs in production mode; `ALLOW_INSECURE_ZKVM=true` is required for CI/test-only mock runs

### 2. E2E Testing Approach

Mock zkVM generates **random bot votes** (production-like behavior). E2E tests validate total vote count (sum = 64) instead of exact distribution:

```typescript
// E2E validation in tests/e2e/helpers/test-helpers.ts
const totalVotes = result.verifiedTally.reduce((sum, count) => sum + count, 0);
if (totalVotes !== 64) {
  errors.push(`Expected total votes: 64, got: ${totalVotes}`);
}
```

**Why this approach?**

- ✅ Ensures Playwright tests run deterministically in CI
- ✅ Maintains production-like random vote distribution
- ✅ Focuses on workflow integrity vs implementation details

## Environment Variables

| Variable        | Values           | Purpose                  |
| --------------- | ---------------- | ------------------------ |
| `USE_MOCK_ZKVM` | `true` / `false` | Enable/disable Mock zkVM |

## Implementation Details

### Console Output

```text
[zkvm] Using Mock zkVM executor (JavaScript implementation)
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
- [Verify Page](<../../../../src/app/(routes)/verify/page.tsx>) - useRef pattern explanation
