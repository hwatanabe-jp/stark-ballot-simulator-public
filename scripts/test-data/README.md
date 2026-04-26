# Test Data Scripts

Legacy test-data generator notes for zkVM proof generation.

The maintained checked-in zkVM fixtures live under `zkvm/test-data/`, but the
fixture generator itself now lives in `scripts/tests/`. The old fixed-depth
SHA-256 scenario generator in this directory is intentionally retired.

## Maintained Fixture Generator

### `scripts/tests/generate-zkvm-fixtures.ts`

Generates current zkVM host inputs with fully valid RFC 6962 inclusion proofs.
The checked-in fixtures are used by low-level host diagnostics such as
`scripts/tests/test-zkvm.sh`, `zkvm/Makefile`, and fixture alignment tests.

- Produces deterministic 8-vote dataset with correct Merkle paths
- Emits a tampered variant (first proof corrupted) for negative testing
- Output format matches `JsonInput` consumed by `zkvm/host/src/main.rs`

**Usage:**

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
```

**Output files** (in `zkvm/test-data/`):

- `test-fixture-valid.json` – Fully valid votes (`missingSlots = 0`, `rejectedRecords = 0`, `excludedSlots = 0`)
- `test-fixture-tampered.json` – Merkle proof tampered to trigger non-zero `rejectedRecords`

## Retired Scenario Generator

### `generate-sha256-data.ts`

This entrypoint is no longer supported. It now prints a retirement notice and
exits with a non-zero status because the legacy fixed-depth SHA-256
session-tree fixture path was removed.

Do not expect this command to generate `test-s0-notamper.json` or other
scenario fixture files:

```bash
npx tsx ./scripts/test-data/generate-sha256-data.ts
```

Use one of the maintained entrypoints instead:

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
./scripts/stark-proofs/test-single.sh
./scripts/stark-proofs/generate-all.sh
pnpm test:cli -- --user-choice A --real-zkvm --zkvm-mode prod --scenario S0
```

## Archived Scripts

The `archive/` directory contains older test data generators kept for reference:

### archive/generate-test-data.sh

- Python-based generator
- Uses older format without proper SHA-256 commitments
- **Status**: Deprecated

### archive/generate-valid-data.sh

- Node.js-based generator
- Uses Poseidon hash (old approach)
- **Status**: Deprecated

## Data Format

Current host input format (JSON):

```json
{
  "election_id": [85, 14, 132, 0, ...],
  "bulletin_root": [110, 241, 68, 166, ...],
  "tree_size": 8,
  "log_id": [123, 90, ...],
  "timestamp": 1725000000,
  "total_expected": 8,
  "election_config_hash": [217, 172, ...],
  "votes": [
    {
      "commitment": [26, 198, ...],
      "choice": 0,
      "random": [1, 1, ...],
      "index": 0,
      "merkle_path": [[134, 181, ...], ...]
    }
  ]
}
```

Retired legacy scenario format for reference:

```json
{
  "user_vote": { "choice": 0, "valid": true, "random": [...] },
  "user_commitment": { "commitment": [...], "leaf_index": 0 },
  "bot_votes": [...],
  "bot_commitments": [...],
  "expected_merkle_root": [...],
  "scenario": { /* tamper settings */ },
  "total_vote_count": 64
}
```
