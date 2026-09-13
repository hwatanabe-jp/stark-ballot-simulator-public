# verifier-service

RISC Zero receipt verifier for STARK Ballot Simulator.

## Overview

`verifier-service` is a standalone Rust CLI that verifies zkVM receipts with
`Receipt::verify(expected_image_id)`.

For non-dev receipts, it also requires the receipt JSON to carry a matching
top-level `image_id` metadata field.

It supports manual receipt verification and the bundle-backed application flow
described below.

## Application Integration

The supported application contract is authenticated bundle-backed verification
selected by `(sessionId, finalizationId)`:

- In the target AWS runtime, the API validates the authoritative S3 bundle
  locator, resolves the expected ImageID, publishes an exact
  `verification-work` message, and returns a running status. SQS then invokes
  `verification-worker`, which downloads and validates the bundle, invokes
  `verifier-service`, uploads the resulting artifacts, and persists the terminal
  verification result.
- In local profiles, the API resolves a trusted bundle scoped to the selected
  session and finalization, then invokes `verifier-service` directly through
  `packages/node-adapters/src/verifier-service-client.ts`.

Neither application branch accepts raw zkVM input or receipt payloads as a
selector contract. Tooling that needs to verify a raw receipt should invoke the
CLI directly, or first materialize a trusted bundle.

Application code should use the existing adapter instead of spawning the process
manually:

```ts
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';

const result = await invokeVerifierService({
  bundlePath,
  expectedImageId,
  reportPath,
});

if (result.status === 'success') {
  // Receipt verification passed; the overall verdict requires the other checks.
}
```

The adapter reads the report from `reportPath`, with a 1 MiB limit, and admits
only the exit-code/report-status pairs `0/success`, `2/dev_mode`, and
`3/failed`. Missing or malformed reports, unsupported exits, and mismatched
pairs fail closed. Stdout is drained and is not a report source.

The shared wire parser validates the complete report before the adapter checks
that its expected ImageID and bundle basename match the invocation. The report
file retains the basename-only `bundle_path` and `receipt_path` fields;
`result.report` is the application projection with those fields removed.

For the target runtime, the app pipeline runs:

```bash
pnpm terraform:build-lambda:target-runtime
```

That command builds the production-feature verifier and packages it as
`/var/task/verifier-service` in the immutable `verification-worker` Lambda zip.
Terraform supplies that exact path through `VERIFIER_SERVICE_BIN` and consumes
the package coordinates and checksum through
`lambda_artifacts["verification_worker"]`.

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

The `decode-journal` command is the receipt-to-host-JSON audit boundary. It
loads the receipt once, verifies that exact receipt against the expected ImageID,
decodes its opaque RISC Zero journal with the current Rust contract, and only
then emits the camelCase host projection. It refuses development, failed,
missing-ImageID, and non-current-method receipts; it is not a generic byte-layout
parser.

## Quick Start

### Build

The repository-level package scripts distinguish production-feature and
dev-mode-capable builds. From the repository root:

```bash
# Production-feature build for real proofs and release artifacts
pnpm build:verifier-service

# Dev-mode-capable build for local development and fake-receipt diagnostics
pnpm build:verifier-service:dev-mode
```

The equivalent commands from `verifier-service/` are:

```bash
# Production-feature build
cargo build --release --features production

# Dev-mode-capable build
cargo build --release
```

The `production` feature enables `risc0-zkvm/disable-dev-mode`. Both builds
reject fake receipts as successful verification; the dev-mode-capable build can
report them with `status: "dev_mode"`. `make verify-fixture` uses the local
dev-mode-capable release build while regenerating and checking a real receipt,
so it is a smoke test rather than a production-feature build.

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

- `default` (default): resolves `variants.default`
- `x86_64`: resolves `variants.x86_64`

Only `state: "confirmed"` variants resolve. An unconfirmed variant fails
closed; it does not fall back to the other architecture. For methodVersion
`14`, the current guest source's `default` is confirmed by the accepted
managed ARM64 Prover release. `x86_64` is independently confirmed from a fresh
local production build and must be selected explicitly for its receipts.

```bash
# Current local x86_64 verification
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

Expected ImageIDs contain exactly 64 hexadecimal characters. The CLI parser
applies the same syntax to positional values, `--image-id`, and
`EXPECTED_IMAGE_ID`: each accepts the value with or without a lowercase `0x`
prefix and normalizes it to lowercase with the prefix.

```text
verifier-service verify [OPTIONS] <BUNDLE_PATH> [IMAGE_ID]
verifier-service decode-journal [OPTIONS] <BUNDLE_PATH> [IMAGE_ID]

ARGS:
    <BUNDLE_PATH>    Path to receipt bundle (file, directory, or zip archive)
    [IMAGE_ID]       Expected ImageID (64 hex characters, optional 0x prefix)

OPTIONS:
    -b, --bundle <PATH>      Path to receipt bundle (alternative to positional arg)
    -i, --image-id <ID>      Expected ImageID (alternative to positional arg)
    -o, --output <PATH>      Write the command's JSON result to file
    -q, --quiet              Suppress stdout output
    -h, --help               Print help message
```

To materialize the proof-bound journal for an independent comparison with a
bundle's `journal.json`:

```bash
./verifier-service/target/release/verifier-service decode-journal \
  --bundle /path/to/bundle.zip \
  --image-id "$EXPECTED_IMAGE_ID" \
  --output /tmp/receipt-journal.json \
  --quiet
```

The output is the current camelCase journal projection plus the verified receipt
metadata `imageId`. RISC Zero serde bytes and offsets remain opaque and are not
part of this JSON contract.

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
- Reports are emitted from a closed status algebra: `success` always has
  `dev_mode_receipt: false` and no `errors`; `dev_mode` always has
  `dev_mode_receipt: true`; and `failed` always has one or more nonempty
  `errors`.
- Rust owns the deterministic current report sentinels under
  `testdata/current-verifier-report-*.json`. Its unit test checks them against
  the serializer, and the TypeScript verification package admits every file
  from `unknown` through the exact wire parser and exit/status protocol.

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

## Development

### Project Structure

```text
verifier-service/
├── Cargo.toml
├── Makefile
├── README.md
├── rust-toolchain.toml
├── scripts/
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
