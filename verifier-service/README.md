# verifier-service

RISC Zero receipt verifier for STARK Ballot Simulator.

## Overview

`verifier-service` is a standalone Rust CLI that verifies zkVM receipts with
`Receipt::verify(expected_image_id)`.

For non-dev receipts, it also requires the receipt JSON to carry a matching
top-level `image_id` metadata field.

It is used in three places:

- local/manual bundle verification
- app-side server verification via `src/lib/verification/verifier-service-client.ts`
- Amplify `verifier-service-runner` Lambda via a Lambda layer

## Supported App Path vs Bridge-Only Surfaces

The supported application contract is authenticated bundle-backed verification.
That means the app chooses verification by `(sessionId, verificationExecutionId)`
and then either:

- invokes `verifier-service-runner` with an authoritative S3 bundle reference, or
- verifies a trusted local bundle in-process through `verifier-service-client`

Bridge-only runner payloads that pass raw zkVM inputs or receipts directly are
not part of the supported app selector contract and are no longer part of the
maintained runner payload surface. Tooling that needs raw artifact verification
should invoke `verifier-service` directly or materialize a trusted bundle first,
rather than treating the runner as a second production selector path.

## What It Accepts

The `verify` command accepts any of these:

- a single receipt JSON file
- a directory containing `receipt.json` or `*-receipt.json`
- a zip archive containing an entry whose name ends with `receipt.json`

Accepted JSON shapes:

- a raw `Receipt` JSON payload
- an envelope object with a top-level `receipt` field

For non-dev receipts, the JSON is also expected to include a top-level
`image_id` field that matches the expected ImageID. `receipt.imageId` alone is
not sufficient.

The verifier emits a JSON report for completed verification attempts unless stdout is
suppressed with `--quiet` and no `--output` path is provided. Exit codes still matter:

- `0`: verification succeeded
- `2`: dev/fake receipt detected and rejected
- `3`: verification failed

For exit codes `2` and `3`, callers should still read the JSON report written to stdout or `--output`.
Use `--output` whenever invoking with `--quiet`.
General errors such as invalid arguments or missing bundle paths exit with code `1` and do not emit a JSON report.

## Quick Start

### Build

```bash
# From repo root
pnpm build:verifier-service

# Or from verifier-service/
cargo build --release
```

### Verify a Fresh Local Fixture

`make verify-fixture` is the recommended smoke test. It regenerates a real receipt from
`zkvm/test-data/test-fixture-valid.json`, extracts the generated ImageID, and verifies that receipt.

```bash
# Prerequisite: build the zkVM host once
pnpm build:zkvm

# Run the verifier smoke test
cd verifier-service
make verify-fixture
```

If you want to run the steps manually from the repository root:

```bash
# 1. Regenerate a real receipt from the checked-in input fixture
env -u RISC0_DEV_MODE ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json

# 2. Read the ImageID from the generated output/receipt artifacts
FIXTURE_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs zkvm/test-data/test-fixture-valid-output.json)"

# 3. Verify the regenerated receipt
./verifier-service/target/release/verifier-service verify \
  zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id "$FIXTURE_IMAGE_ID"
```

### Verify Using `EXPECTED_IMAGE_ID`

For deployed or bundle-based flows, you can resolve the mapped ImageID from
`public/imageId-mapping.json`.

`read-image-id.mjs` supports `--variant default|x86_64`:

- `default` (default): always uses `expectedImageID`
- `x86_64`: requires `expectedImageID_x86_64`

```bash
# Deployed / AWS-native verification
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant default)"

# Local x86_64 verification
export EXPECTED_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json --variant x86_64)"

# Or let read-image-id.mjs consume the shared variant env first
export EXPECTED_IMAGE_ID="$(
  EXPECTED_IMAGE_ID_VARIANT=x86_64 \
  node verifier-service/scripts/read-image-id.mjs public/imageId-mapping.json
)"

./verifier-service/target/release/verifier-service verify /path/to/bundle-or-receipt
```

`verifier-service` itself reads `EXPECTED_IMAGE_ID`; `EXPECTED_IMAGE_ID_VARIANT`
is only consumed when deriving that value through `read-image-id.mjs`.

## CLI Usage

```text
verifier-service verify [OPTIONS] <BUNDLE_PATH> [IMAGE_ID]

ARGS:
    <BUNDLE_PATH>    Path to receipt bundle (file, directory, or zip archive)
    [IMAGE_ID]       Expected ImageID (hex string with 0x prefix)

OPTIONS:
    -b, --bundle <PATH>      Path to receipt bundle (alternative to positional arg)
    -i, --image-id <ID>      Expected ImageID (alternative to positional arg)
    -o, --output <PATH>      Write verification report to file
    -q, --quiet              Suppress stdout output
    -h, --help               Print help message
```

## Environment Variables

| Variable            | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `EXPECTED_IMAGE_ID` | Default ImageID when `[IMAGE_ID]` / `--image-id` is omitted |

## Output Format

Reports are JSON:

```json
{
  "status": "success",
  "verifier_version": "0.1.0",
  "verified_at": "2026-03-24T02:54:20.628441088Z",
  "duration_ms": 21,
  "expected_image_id": "0x<expected-image-id>",
  "receipt_image_id": "0x<receipt-image-id>",
  "bundle_path": "test-fixture-valid-receipt.json",
  "receipt_path": "test-fixture-valid-receipt.json",
  "dev_mode_receipt": false
}
```

Notes:

- `bundle_path` and `receipt_path` are basename-only by design.
- `errors` is omitted when empty.

### Status Values

- `success`: verification passed
- `dev_mode`: a fake/dev-mode receipt was detected and rejected
- `failed`: proof verification or ImageID validation failed

## Examples

### Success

```bash
FIXTURE_IMAGE_ID="$(node verifier-service/scripts/read-image-id.mjs zkvm/test-data/test-fixture-valid-output.json)"

./verifier-service/target/release/verifier-service verify \
  zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id "$FIXTURE_IMAGE_ID"
```

Expected exit code: `0`

### Failure: ImageID Mismatch

```bash
./verifier-service/target/release/verifier-service verify \
  zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id 0x0000000000000000000000000000000000000000000000000000000000000000
```

Expected exit code: `3`

### Failure: Tampered STARK Proof

```bash
pnpm test:stark-tamper
```

This workflow:

1. regenerates a fresh real receipt from the checked-in zkVM input
2. flips bits in the STARK seal
3. confirms that `verifier-service verify` exits with `3`

## AWS Lambda Layer Packaging

The Amplify `verifier-service-runner` Lambda expects the Rust binary to be provided via a Lambda layer.

```bash
cd verifier-service
./scripts/build-lambda-layer.sh
zip -r verifier-layer.zip lambda-layer
```

This stages `lambda-layer/bin/verifier-service` for `x86_64-unknown-linux-gnu`.
`lambda-layer/` is a generated build artifact and should not be committed.
Amplify mounts the layer so the binary is available at `/opt/bin/verifier-service`.

## Integration with the App

The app already wraps the CLI in `src/lib/verification/verifier-service-client.ts`.
Prefer that helper over spawning the process manually:

```ts
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';

const result = await invokeVerifierService({
  bundlePath,
  expectedImageId,
  reportPath,
});

if (result.status === 'success') {
  // verified
}
```

That helper preserves the JSON report for exit codes `2` and `3`, which is important for `dev_mode` and failure handling.

## Development

### Project Structure

```text
verifier-service/
├── Cargo.toml
├── Makefile
├── README.md
├── rust-toolchain.toml
├── scripts/
│   ├── build-lambda-layer.sh
│   └── read-image-id.mjs
├── tests/
│   └── cli_verify.rs
└── src/
    ├── lib.rs
    └── main.rs
```

### Common Commands

```bash
cd verifier-service

# Tests
cargo test

# Fresh real-fixture verification
make verify-fixture

# Real proof tamper check
make test-tamper

# Formatting / lint / type-check
cargo fmt
cargo clippy -- -D warnings
cargo check
```

## Troubleshooting

### `missing expected image ID`

Pass `--image-id`, provide `[IMAGE_ID]`, or export `EXPECTED_IMAGE_ID`.

### `bundle not found`

Check that the file or directory exists and that you are passing the intended path type.

### `receipt file not found in bundle`

For directory inputs, the verifier looks for:

- `receipt.json`
- `*-receipt.json`

For zip inputs, it looks for an entry whose name ends with `receipt.json`.

### `receipt metadata missing image_id field`

For non-dev receipts, `verifier-service` expects a top-level `image_id` field in
`receipt.json` and rejects the receipt if it is missing. If you are building a
bundle manually, include that top-level field; nested `receipt.imageId` alone is
not enough.

### `dev_mode_receipt: true`

The receipt was generated in fake/dev mode and was rejected. For a real local smoke test, regenerate with:

```bash
env -u RISC0_DEV_MODE ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

### `tamper-stark-proof.ts` says the receipt format is invalid

That script only works on real `Composite` receipts. `make test-tamper` regenerates a compatible real receipt automatically before tampering.

## License

Apache-2.0
