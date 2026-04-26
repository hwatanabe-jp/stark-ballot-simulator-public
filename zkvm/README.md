# zkvm

RISC Zero zkVM prover workspace for STARK Ballot Simulator.

## Overview

`zkvm/` contains the Rust host CLI, guest method, and supporting workspace crates used to generate tally proofs for the simulator.

The workspace is used in two execution paths:

- Local and synchronous proof generation from the application process (`src/lib/zkvm/executor.ts`)
- Async prover execution in the cloud (Step Functions -> ECS Fargate -> `docker/entrypoint.sh`)

Earlier design docs referred to this component as "Lambda A". The current async prover path is ECS Fargate based, not a standalone Lambda runtime.

## Shared-Core Boundary

`WS4` extracts one shared Rust contract core into `zkvm/contract-core/`.
That crate is intentionally smaller than the whole prover stack and now owns
the contract-critical Rust logic shared by host and guest.

Shared-core owner:

- commitment computation and canonical input-commitment encoding
- RFC 6962 / CT inclusion-proof folding and related contract-critical helpers
- bitmap root helpers that must stay in lockstep with TypeScript proof helpers
- contract-critical types shared by host and guest

Host-only responsibilities:

- JSON input parsing, local artifact persistence, bundle-friendly file layout
- CLI wiring and exact bitmap artifact best-effort output

Guest-only responsibilities:

- zkVM execution entrypoint, journal emission, and in-guest tally flow control

Verifier-service-only responsibilities:

- receipt or bundle discovery, report shaping, and `Receipt::verify(expected_image_id)` orchestration

Tooling-only responsibilities:

- bridge payloads that hand raw artifacts across process boundaries without being part of the supported app selector contract

Container/orchestration responsibilities:

- Step Functions and ECS task dispatch
- Docker entrypoint packaging, private artifact promotion, and S3 upload flow

Shared-core law inventory:

- `zkvm/shared-core-law-inventory.md`

Rust-side property-test track around the shared crate:

- canonical input-commitment permutation invariance and duplicate-index tie-break laws
- RFC 6962 proof round-trip and tamper-failure laws
- bitmap root oracle and tamper-failure laws

Current generative harness:

- `zkvm/methods/guest/src/property_tests.rs`

Cross-language golden-vector evidence:

- `zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json`
- `scripts/tests/rfc6962-golden-vectors.ts`
- `scripts/tests/generate-rfc6962-golden-vectors.ts`
- `scripts/tests/__tests__/rfc6962-golden-vectors.test.ts`

Regenerate the checked-in TS-to-Rust RFC6962 fixture from the repository root:

```bash
pnpm tsx scripts/tests/generate-rfc6962-golden-vectors.ts
```

## Features

- STARK proof generation with RISC Zero 3.0.5
- Vote aggregation with commitment and inclusion-proof checks
- RFC 6962 style bulletin inclusion verification
- Domain-separated SHA-256 commitments and input commitment binding
- Dev mode support with fake receipts (`RISC0_DEV_MODE=1`)
- Output artifacts that can be repackaged into verification bundles

## Quick Start

### Build

```bash
# From zkvm/
cargo build --release

# From repo root
pnpm run build:zkvm
```

### Run the host CLI

```bash
cd zkvm

# Dev mode: fake receipt, fast
RISC0_DEV_MODE=1 ./target/release/host test-data/test-fixture-valid.json

# Production mode: real STARK proof, slow
./target/release/host test-data/test-fixture-valid.json
```

Notes:

- `RISC0_DEV_MODE=1` does not generate a real STARK proof.
- Local release builds on x86_64 can take around 6 minutes for 64 votes.
- Async ARM64 Fargate runs are documented separately and can be faster than local x86_64 runs.

### Run tests

```bash
cd zkvm

# Recommended default for local test runs
RISC0_DEV_MODE=1 cargo test

# Property-based laws on the current canonical Rust owner
cargo test -p guest property_

# With output
cargo test -- --nocapture

# Example targeted test
cargo test test_json_to_aggregator_input -- --nocapture
```

### Makefile helpers

```bash
cd zkvm
make help
make build-release
make test
make verify-fixture
```

### Smoke-test the checked-in fixtures

```bash
# From repo root
bash scripts/tests/test-zkvm.sh
```

This script is the fastest end-to-end sanity check for the checked-in fixture pair:

- `test-fixture-valid.json` should pass with `rejectedRecords = 0` and `excludedSlots = 0`
- `test-fixture-tampered.json` should fail with non-zero `rejectedRecords`

## CLI Usage

```text
host <INPUT_JSON_PATH>
```

Arguments:

- `<INPUT_JSON_PATH>`: path to the zkVM input JSON file

Environment:

- `RISC0_DEV_MODE=1`: generate fake receipts instead of real proofs

Note: `EXPECTED_IMAGE_ID` is not consumed by the host CLI itself. It is used downstream by verification flows such as `verifier-service`.

## Input Format

The host reads JSON in the format produced by `serializeZkvmAggregatorInput()` in `src/lib/zkvm/executor.ts`.

Example structure:

```json
{
  "election_id": [
    /* 16 bytes */
  ],
  "bulletin_root": [
    /* 32 bytes */
  ],
  "tree_size": 8,
  "log_id": [
    /* 32 bytes */
  ],
  "timestamp": 1725000000,
  "total_expected": 8,
  "election_config_hash": [
    /* 32 bytes */
  ],
  "votes": [
    {
      "commitment": [
        /* 32 bytes */
      ],
      "choice": 0,
      "random": [
        /* 32 bytes */
      ],
      "index": 0,
      "merkle_path": [
        [
          /* 32 bytes */
        ],
        [
          /* 32 bytes */
        ]
      ]
    }
  ]
}
```

Checked-in fixture inputs live under `zkvm/test-data/`.

To regenerate them:

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
```

The generator reuses the repository's current CT Merkle implementation so the fixture root and audit paths stay aligned with the code used by the application.

That script rewrites:

- `zkvm/test-data/test-fixture-valid.json`
- `zkvm/test-data/test-fixture-tampered.json`

Those two JSON files are the canonical checked-in input fixtures.
The repository also tracks the current valid-fixture bitmap snapshots:

- `zkvm/test-data/test-fixture-valid-bitmap.json`
- `zkvm/test-data/test-fixture-valid-seen-bitmap.json`

Aside from those checked-in snapshots, generated `*-output.json`, `*-receipt.json`,
`*-bitmap.json`, and `*-seen-bitmap.json` artifacts are local runtime outputs and
should be regenerated from the same build you plan to verify.

## Output Artifacts

The host always writes `*-output.json` and `*-receipt.json` next to the input file, prints the guest ImageID to stdout, and may also write private bitmap artifacts when it can reconstruct exact bitmaps whose roots match the journal.

### 1. `*-output.json`

This is the host-decoded journal summary in camelCase JSON.

Example structure:

```json
{
  "electionId": [
    /* 16 bytes */
  ],
  "electionConfigHash": [
    /* 32 bytes */
  ],
  "bulletinRoot": [
    /* 32 bytes */
  ],
  "treeSize": 64,
  "totalExpected": 64,
  "sthDigest": [
    /* 32 bytes */
  ],
  "verifiedTally": [16, 16, 16, 16, 0],
  "totalVotes": 64,
  "validVotes": 64,
  "invalidVotes": 0,
  "seenIndicesCount": 64,
  "missingSlots": 0,
  "invalidPresentedSlots": 0,
  "rejectedRecords": 0,
  "seenBitmapRoot": [
    /* 32 bytes */
  ],
  "includedBitmapRoot": [
    /* 32 bytes */
  ],
  "excludedSlots": 0,
  "inputCommitment": [
    /* 32 bytes */
  ],
  "methodVersion": 12,
  "imageId": "0x..."
}
```

Application code converts these arrays into UUID and hex string forms after reading the file.

### 2. `*-receipt.json`

The host writes a wrapper object with the raw RISC Zero receipt plus top-level image metadata.

Example structure:

```json
{
  "receipt": {
    "inner": {
      "Composite": {
        "segments": [
          {
            "seal": [
              /* proof data */
            ]
          }
        ]
      }
    }
  },
  "image_id": "0x..."
}
```

In dev mode, the receipt payload contains a `Fake` receipt instead of a production `Composite` receipt, but the top-level wrapper remains the same.

### 3. `*-bitmap.json`

The host also writes a private exact counted bitmap artifact next to the input when it can
reconstruct a bitmap whose root matches `includedBitmapRoot`.

Example structure:

```json
{
  "schema": "stark-ballot.included_bitmap",
  "version": "1.0",
  "treeSize": 64,
  "includedBitmapRoot": "0x...",
  "includedBitmap": [true, false, true]
}
```

This file is for server-side `/api/bitmap-proof` support and S3/session restoration. It is not
part of the public verification bundle.

### 4. `*-seen-bitmap.json`

The host also writes a private exact presented bitmap artifact when it can reconstruct a bitmap
whose root matches `seenBitmapRoot`.

Example structure:

```json
{
  "schema": "stark-ballot.seen_bitmap",
  "version": "1.0",
  "treeSize": 64,
  "seenBitmapRoot": "0x...",
  "seenBitmap": [true, true, false]
}
```

This file lets `/api/bitmap-proof?kind=seen` distinguish:

- indices that were never presented to the prover
- indices that were presented but later excluded from the counted bitmap

Like `*-bitmap.json`, this is private server-side state and is not part of the public verification
bundle.

### 5. Public bundle conversion

The async ECS prover path does additional packaging:

- `docker/entrypoint.sh` copies `*-receipt.json` to `receipt.json`
- `docker/entrypoint.sh` converts `*-output.json` to `journal.json`
- `docker/entrypoint.sh` builds `election-manifest.json`
- `docker/entrypoint.sh` builds `close-statement.json`
- `docker/entrypoint.sh` promotes `*-bitmap.json` to private `included-bitmap.json`
- `docker/entrypoint.sh` promotes `*-seen-bitmap.json` to private `seen-bitmap.json`
- `docker/entrypoint.sh` adds `public-input.json`
- only the public files are zipped into `bundle.zip`

For the current async public bundle contract, `bundle.zip` contains:

```text
public-input.json, election-manifest.json, close-statement.json, receipt.json, journal.json
```

Private artifacts such as `included-bitmap.json`, `seen-bitmap.json`, `input.json`, and `verification.json` must stay out of the public archive.

That means app-level verification bundles use `receipt.json` and `journal.json`, while the raw host output on disk is still `*-receipt.json`, `*-output.json`, `*-bitmap.json`, and `*-seen-bitmap.json`.

## ImageID Notes

The host prints and embeds the guest ImageID that was compiled into the local binary:

```text
Guest Program ImageID: 0x...
```

The repository source of truth for expected IDs is:

- `public/imageId-mapping.json`

Important details:

- The mapping is keyed by `methodVersion`.
- The mapping can contain platform-specific IDs, for example an ARM64 AWS build and a local x86_64 build.
- Do not assume a locally built x86_64 ImageID matches the AWS Fargate ARM64 ImageID.
- The operational procedure for confirming the deployed ARM64 ImageID is documented in `docs/current/guides/7-terraform/README.md`.
- Do not mix a newly updated mapping with an older locally generated `*-receipt.json` or `*-output.json`; `verifier-service` checks the receipt metadata `image_id` and will reject mismatches.

When the guest image changes, update the mapping and any remaining hard-coded
fallback constants or environment overrides:

- `public/imageId-mapping.json`
- `src/lib/verification/expected-image-id.ts`, if its fallback constant still applies
- any explicit `EXPECTED_IMAGE_ID` override in shell, `.env.local`, CI, or Amplify SSR env

`vitest.setup.ts` currently derives its default ImageID from
`public/imageId-mapping.json`, so it normally only needs review if test
bootstrapping changes.

Then regenerate any local zkVM artifacts you still use for debugging or verification, for example:

```bash
cd zkvm
unset RISC0_DEV_MODE
./target/release/host test-data/test-fixture-valid.json
```

## Integration with STARK Ballot Simulator

### Sync and local execution

- `src/lib/zkvm/executor.ts` shells out to `zkvm/target/release/host`
- it reads `*-output.json` and `*-receipt.json`
- it also reads `*-bitmap.json` and `*-seen-bitmap.json` when present
- it normalizes byte-array fields into application-level UUID and hex strings
- it restores exact included/seen bitmaps for server-side `/api/bitmap-proof` support

### Async cloud execution

- `docker/entrypoint.sh` runs the host inside the prover container
- Terraform provisions the async prover path with Step Functions and ECS Fargate
- the prover task uploads `bundle.zip` and related artifacts to S3

### Receipt verification

- `verifier-service/` performs independent receipt verification
- the app consumes the host output through verification bundles, not by parsing stdout

## Development

### Project Structure

```text
zkvm/
├── Cargo.toml
├── rust-toolchain.toml
├── Makefile
├── README.md
├── contract-core/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── bitmap.rs
│   │   ├── encoding.rs
│   │   ├── inclusion_proof.rs
│   │   ├── lib.rs
│   │   ├── sha256.rs
│   │   └── types.rs
│   └── testdata/
│       └── rfc6962-ts-golden-vectors.json
├── host/
│   ├── Cargo.toml
│   └── src/main.rs
├── methods/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/lib.rs
│   └── guest/
│       ├── Cargo.toml
│       └── src/
│           ├── compatibility_test.rs
│           ├── lib.rs
│           ├── main.rs
│           ├── profiling.rs
│           ├── property_tests.rs
│           ├── sth.rs
│           └── test_vectors.rs
├── methods-minimal/
│   └── ...
├── benchmarks/
│   └── ...
├── test-data/
│   ├── test-fixture-valid.json
│   ├── test-fixture-valid-bitmap.json
│   ├── test-fixture-valid-seen-bitmap.json
│   ├── test-fixture-tampered.json
│   └── generated *-output.json / *-receipt.json / tampered artifacts
└── target/
```

Notes:

- `methods-minimal/` and `benchmarks/` are part of the Cargo workspace.
- Command-line receipt verification is owned by `verifier-service`; use `verifier-service verify` for `Receipt::verify(expected_image_id)`.

## Troubleshooting

### "No such file or directory: host"

Build the release binary first:

```bash
cd zkvm
cargo build --release --bin host
ls -la target/release/host
```

### Proof generation is too slow

Use dev mode while iterating:

```bash
cd zkvm
RISC0_DEV_MODE=1 ./target/release/host test-data/test-fixture-valid.json
```

Remember that dev mode receipts are fake and are not valid production proofs.

### `verifier-service` reports `dev_mode`

That is expected if the receipt was generated with `RISC0_DEV_MODE=1`.

To produce a real proof:

```bash
cd zkvm
unset RISC0_DEV_MODE
./target/release/host test-data/test-fixture-valid.json
```

### ImageID mismatch

Check all of the following before assuming the proof is bad:

1. whether the receipt was produced on local x86_64 or AWS ARM64
2. `public/imageId-mapping.json`
3. `src/lib/verification/expected-image-id.ts`
4. `vitest.setup.ts`
5. any explicit `EXPECTED_IMAGE_ID` environment override

## STARK Proof Verification

After generating artifacts, verify them with `verifier-service`:

```bash
# Build the verifier
cd verifier-service
cargo build --release

# Verify a specific receipt file
./target/release/verifier-service verify \
  --bundle ../zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id 0x<expected-image-id>
```

Avoid pointing the verifier at `../zkvm/test-data/` directly when that directory contains multiple receipt files, because it will load the first matching `*-receipt.json` entry it finds.

Important:

- If `test-fixture-valid-receipt.json` was generated with `RISC0_DEV_MODE=1`, this command should return `status: "dev_mode"`, not `status: "success"`.
- To exercise a real success path, rerun `host` without `RISC0_DEV_MODE` and verify the freshly generated `*-receipt.json`.
- Use the expected ImageID from that same build or from the matching entry in `public/imageId-mapping.json`.

Verification outcomes:

- dev-mode receipts return `status: "dev_mode"`
- real proofs return `status: "success"`
- invalid proofs or wrong ImageIDs return `status: "failed"`

Use the expected ImageID that matches the build you are verifying.

## Related Documentation

- `docs/current/guides/6-zkvm_design/final_design.md`
- `docs/current/runbooks/aws-hybrid.md`
- `docs/current/tests/cli.md`
- `verifier-service/README.md`
- <https://dev.risczero.com>

## License

Apache-2.0
