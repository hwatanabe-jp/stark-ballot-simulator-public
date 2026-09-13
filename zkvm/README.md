# zkVM Prover Workspace

`zkvm/` contains the RISC Zero host CLI, guest method, and shared Rust contract
code used to generate tally proofs for STARK Ballot Simulator.

The same host binary supports two application paths:

- local or synchronous execution through
  `packages/node-adapters/src/zkvm/executor.ts`
- asynchronous execution in an ECS Fargate prover task through
  `infra/docker/entrypoint.sh`

Receipt verification is independent of proof generation and is owned by
`verifier-service/`.

## Architecture and Sources of Truth

The workspace separates contract-critical code from runtime-specific concerns:

- `contract-core/` owns shared Rust types, commitment and canonical
  input-commitment encoding, RFC 6962 inclusion-proof folding, bitmap roots,
  and guest work-budget validation.
- `methods/guest/` owns the zkVM entrypoint, tally flow, journal emission, and
  Rust-side compatibility/property tests.
- `host/` owns JSON parsing, proof execution, CLI behavior, local artifact
  persistence, and the checked public-audit projection/hash validator used by
  the async prover.
- `methods-minimal/` and `benchmarks/` provide supporting workspace targets.
- `verifier-service/` owns receipt discovery, report shaping, and
  `Receipt::verify(expected_image_id)`.
- `packages/verification/src/verification/public-bundle-manifest.json` owns
  public bundle membership and private-artifact exclusion policy.
- `infra/docker/entrypoint.sh` owns async process/filesystem/archive/S3
  orchestration, bundle-policy enforcement, and private artifact promotion.

See [`shared-core-law-inventory.md`](./shared-core-law-inventory.md) for the
shared-core laws and their Rust-side evidence.

Current contract authorities:

| Concern                                      | Authority                                                            |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Rust input/journal types and method version  | `contract-core/src/types.rs`                                         |
| Exact-current semantic contract and SHA-256  | `contract-core/src/current-zkvm-semantic-contract.json`              |
| TypeScript input/journal types               | `packages/zkvm-contract/src/zkvm/types.ts`                           |
| TypeScript-to-host JSON conversion           | `packages/zkvm-contract/src/zkvm/host-io.ts`                         |
| Guest tally behavior                         | `methods/guest/src/tally.rs`                                         |
| Host CLI and raw artifacts                   | `host/src/main.rs`                                                   |
| Public-audit projection and canonical hashes | `host/src/artifacts.rs`                                              |
| Expected ImageIDs and provenance             | `public/imageId-mapping.json`                                        |
| Async public bundle policy                   | `packages/verification/src/verification/public-bundle-manifest.json` |
| Async orchestration and enforcement          | `infra/docker/entrypoint.sh`                                         |

The checked-in semantic descriptor is built from Rust-owned constants and
field-order metadata. Its `semanticSha256` is the SHA-256 of the descriptor
body serialized as key-sorted, whitespace-free canonical JSON. Rust tests
verify freshness against the actual input and logical-journal serde order;
TypeScript runtime-admits the exact keys and fingerprint before exposing the
complete binding to server and tooling consumers. Browser-reachable contract
code consumes only the generated artifact-metadata-free method, input-format,
tally-width, domain-tag, and host-journal-key projection; the frontend import
boundary and static-artifact scan keep the complete descriptor and private
artifact filenames out of browser artifacts. The host-input contract includes the one optional canonical
`election_config` extension and its exact camelCase nested fields; the artifact
contract records the canonical public-input filename, schema, version, and
ordered fields. The prover image copies the same JSON file read-only.

Host tests RISC Zero-serde round-trip deterministic input and journal values
(the observed 896-byte journal is non-normative). The Rust serializer also
produces `contract-core/testdata/current-bitmap-artifacts-sentinel.json`, which
TypeScript exact-admits; opaque serde byte layout remains non-contractual.

This semantic hash runs alongside the existing source-file interface hash. It
does not replace `zkvmContractHash` in release or deployment authority. The
receipt payload remains opaque RISC Zero serde, and neither receipt byte
offsets nor the test-only synthetic packed-journal layout are part of the
descriptor.

Current cross-language and formal evidence includes:

- `contract-core/testdata/rfc6962-ts-golden-vectors.json`
- `contract-core/testdata/bitmap-ts-golden-vectors.json`
- `scripts/tests/bitmap-golden-vectors.test.ts`
- `scripts/tests/rfc6962-golden-vectors.test.ts`
- `docs/formal/generated-vectors/input-commitment-cases.json`
- `docs/formal/generated-vectors/bitmap-cases.json`
- `docs/formal/generated-vectors/guest-model-cases.json`

The six formal vector files use one unnumbered exact-current envelope generated
only by Lean. TypeScript admits the exact envelope, payload, modeled bounds, and
canonical fingerprint through
`@stark-ballot/zkvm-contract/zkvm/formal-vectors`; the Rust contract-core and
guest correspondence tests use an exact serde boundary and compare the same
metadata with their input-format, guest-work, method, and tally constants.
Neither consumer trusts an imported JSON type assertion, accepts extra fields,
or provides a fallback for an older envelope.

Regenerate the checked-in TypeScript-to-Rust fixtures from the repository
root:

```bash
pnpm tsx scripts/tests/generate-rfc6962-golden-vectors.ts
pnpm tsx scripts/tests/generate-bitmap-golden-vectors.ts
```

## Toolchain and Features

The current pins are:

- host Rust: **1.97.1**
- RISC Zero guest Rust toolchain: **`r0.1.97.0`**
- RISC Zero: **3.0.6**

The host Rust pin is declared in `rust-toolchain.toml` and
`zkvm/rust-toolchain.toml`. RISC Zero versions and crate features are declared
in the workspace Cargo manifests.

Guest crates use `no_std`, disable `risc0-zkvm` default features, and select
`heap-embedded-alloc`. Host-only crates select the `client` and `bonsai`
features. The host `production` feature enables
`risc0-zkvm/disable-dev-mode`, so a production-feature binary rejects
`RISC0_DEV_MODE=1`.

The implementation provides:

- STARK proof generation and fake-receipt development mode
- vote aggregation with commitment and inclusion-proof checks
- RFC 6962-style bulletin inclusion verification
- domain-separated SHA-256 commitments and canonical input binding
- exact counted/presented bitmap artifacts when their roots match the journal
- raw artifacts that the application or async prover can package for
  verification

For complete installation instructions, see
[`docs/guides/risc0-setup.md`](../docs/guides/risc0-setup.md).

## Build, Test, Prove, and Verify

Run commands from the repository root unless a command explicitly changes
directory.

### Build the host

Use the production-feature build for real proofs and release artifacts:

```bash
pnpm build:zkvm
```

Use the dev-mode-capable build for fake-receipt iteration:

```bash
pnpm build:zkvm:dev-mode
```

Both commands write `zkvm/target/release/host`.

### Run the checked-in fixtures

Fast development receipt:

```bash
RISC0_DEV_MODE=1 \
  ./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

Real STARK proof:

```bash
unset RISC0_DEV_MODE
./zkvm/target/release/host zkvm/test-data/test-fixture-valid.json
```

The real proof path is intentionally slow. `RISC0_DEV_MODE=1` produces a fake
receipt and is never evidence of production proof correctness.

The fixture smoke script runs both checked-in inputs in dev mode:

```bash
bash scripts/tests/test-zkvm.sh
```

Expected results:

- `test-fixture-valid.json` has `rejectedRecords = 0` and
  `excludedSlots = 0`.
- `test-fixture-tampered.json` has a non-zero `rejectedRecords` value.

### Run contract tests

These checks do not generate real proofs:

```bash
cd zkvm
RISC0_DEV_MODE=1 cargo test
cargo test -p contract-core
cargo test -p contract-core --test current_semantic_contract
cargo test -p guest property_
```

The Makefile also exposes `make help`, `make build-release`, `make test`, and
`make verify-fixture`. The repository-level package scripts are authoritative
when choosing between production and dev-mode-capable host builds.

### Verify a receipt

For a fake receipt, build the verifier without its production feature so it
can report `dev_mode`:

```bash
pnpm build:verifier-service:dev-mode
./verifier-service/target/release/verifier-service verify \
  --bundle zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id 0x<matching-image-id>
```

For a real receipt, use the production verifier:

```bash
pnpm build:verifier-service
./verifier-service/target/release/verifier-service verify \
  --bundle zkvm/test-data/test-fixture-valid-receipt.json \
  --image-id 0x<matching-image-id>
```

Verification outcomes are:

- `dev_mode` for a fake receipt
- `success` for a valid real proof with the matching ImageID
- `failed` for an invalid proof or wrong ImageID

Point `--bundle` at the specific receipt file, a single-receipt directory, or
a bundle archive. Avoid a directory containing multiple `*-receipt.json`
files because directory discovery selects the first sorted matching entry.

## Host CLI

```text
host <INPUT_JSON_PATH>
host --print-image-id [--json]
```

`<INPUT_JSON_PATH>` proves the supplied input and writes raw artifacts beside
it.

Options:

- `--print-image-id` prints the compiled guest ImageID and exits without
  proving or writing artifacts.
- `--json`, used with `--print-image-id`, emits
  `{"imageId":"0x...","methodVersion":14}`.

`RISC0_DEV_MODE=1` selects fake receipts only when the host was built without
the `production` feature.

`EXPECTED_IMAGE_ID` and `EXPECTED_IMAGE_ID_VARIANT` are not host CLI inputs.
They belong to downstream verification and deployment configuration.

## Input Contract

The host reads the JSON shape produced by `serializeZkvmAggregatorInput()` in
`packages/zkvm-contract/src/zkvm/host-io.ts`:

```json
{
  "election_id": [/* 16 bytes */],
  "bulletin_root": [/* 32 bytes */],
  "tree_size": 8,
  "log_id": [/* 32 bytes */],
  "timestamp": 1725000000000,
  "total_expected": 8,
  "election_config_hash": [/* 32 bytes */],
  "votes": [
    {
      "commitment": [/* 32 bytes */],
      "choice": 0,
      "random": [/* 32 bytes */],
      "index": 0,
      "merkle_path": [[/* 32 bytes */], [/* 32 bytes */]]
    }
  ],
  "election_config": {
    "totalExpected": 8,
    "choices": ["A", "B", "C", "D", "E"],
    "version": "v1.0",
    "botCount": 0,
    "merkleTreeDepth": 3
  }
}
```

`timestamp` is a Unix timestamp in milliseconds encoded as a Rust `u64`.
TypeScript callers require a positive JavaScript safe integer before
serialization. `election_config` is the sole optional host-only extension; its
name is snake_case while the exact nested configuration keys are camelCase.
Unknown top-level, vote, and configuration keys are rejected.

The current guest work budget fails closed when any of these bounds are
exceeded:

- `tree_size` is outside `1..=1,000,000`
- `total_expected` exceeds `1,000,000`
- more than `1,000,000` vote records are presented
- one record has more than `65,535` Merkle path nodes
- aggregate Merkle path nodes exceed `1,000,000`
- serialized or estimated structural input exceeds 64 MiB

The host enforces the same contract before constructing the RISC Zero executor
environment. The guest validates it before emitting journal fields.

Checked-in inputs and snapshots:

- `test-data/test-fixture-valid.json`
- `test-data/test-fixture-tampered.json`
- `test-data/test-fixture-valid-bitmap.json`
- `test-data/test-fixture-valid-seen-bitmap.json`

Regenerate the fixture inputs with:

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
```

Other `*-output.json`, `*-receipt.json`, `*-bitmap.json`, and
`*-seen-bitmap.json` files are local runtime outputs and should be regenerated
with the same host build whose artifacts you intend to inspect.

## Raw Host Artifacts

In proof mode, the host writes `*-output.json` and `*-receipt.json` beside the
input. It also writes exact private bitmap artifacts when it can reconstruct
bitmaps whose roots match the journal.

ImageID-only mode reads no input and writes no artifacts.

### `*-output.json`

The output is the host-decoded method-version 14 journal plus host-provided
ImageID metadata, serialized as camelCase JSON:

```json
{
  "electionId": [/* 16 bytes */],
  "electionConfigHash": [/* 32 bytes */],
  "bulletinRoot": [/* 32 bytes */],
  "treeSize": 64,
  "totalExpected": 64,
  "sthDigest": [/* 32 bytes */],
  "verifiedTally": [16, 16, 16, 16, 0],
  "totalVotes": 64,
  "validVotes": 64,
  "invalidVotes": 0,
  "seenIndicesCount": 64,
  "missingSlots": 0,
  "invalidPresentedSlots": 0,
  "rejectedRecords": 0,
  "seenBitmapRoot": [/* 32 bytes */],
  "includedBitmapRoot": [/* 32 bytes */],
  "excludedSlots": 0,
  "inputCommitment": [/* 32 bytes */],
  "methodVersion": 14,
  "imageId": "0x..."
}
```

Application code validates the method version and converts byte arrays to UUID
or hex-string representations.

### `*-receipt.json`

The host wraps the raw RISC Zero receipt with its compiled ImageID:

```json
{
  "receipt": {
    "inner": {
      "Composite": {
        "segments": [
          {
            "seal": [/* proof data */]
          }
        ]
      }
    }
  },
  "image_id": "0x..."
}
```

A dev-mode wrapper has the same top-level shape but contains a `Fake` receipt.
The receipt implementation may use another valid RISC Zero inner receipt
variant; consumers must parse the wrapper rather than assume `Composite`.

### `*-bitmap.json`

When the exact counted bitmap matches `includedBitmapRoot`, the host writes:

```json
{
  "schema": "stark-ballot.included_bitmap",
  "version": "1.0",
  "treeSize": 64,
  "includedBitmapRoot": "0x...",
  "includedBitmap": [true, false, true]
}
```

### `*-seen-bitmap.json`

When the exact presented-index bitmap matches `seenBitmapRoot`, the host
writes:

```json
{
  "schema": "stark-ballot.seen_bitmap",
  "version": "1.0",
  "treeSize": 64,
  "seenBitmapRoot": "0x...",
  "seenBitmap": [true, true, false]
}
```

The two bitmap files support server-side
`/api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`
queries and session restoration. They are private artifacts and must not enter
the public verification bundle.

## Async Bundle Boundary

`packages/verification/src/verification/public-bundle-manifest.json` is the
authority for public bundle membership and private-artifact exclusions. The
ECS entrypoint enforces that policy while constructing the async bundle,
promoting private supporting artifacts, and uploading results. Its checked
`prover-artifacts` Rust binary exactly admits the private host input and raw
host output. This async projection requires `election_config` in the input;
the host proof CLI itself permits that extension to be omitted. The Rust tool
rejects duplicate vote indices, computes the canonical config/input/STH hashes,
projects application-level artifacts, and re-admits the serialized
cross-artifact set before publication. The shell retains process, filesystem,
archive, and S3 orchestration:

- the shell copies `*-receipt.json` to `receipt.json`.
- the Rust tool projects the private input and `*-output.json` into
  `journal.json`, `public-input.json`, `election-manifest.json`, and
  `close-statement.json`. The journal projection converts byte arrays to UUID
  and hex-string representations.
- `*-bitmap.json` and `*-seen-bitmap.json` are promoted to private
  `included-bitmap.json` and `seen-bitmap.json` when present.

The current async public `bundle.zip` contains exactly:

```text
public-input.json
election-manifest.json
close-statement.json
receipt.json
journal.json
```

`input.json`, `verification.json`, `included-bitmap.json`, and
`seen-bitmap.json` are private and must remain outside the public archive.

`host/src/artifacts.rs` validates async host output against the current method
version and derives the public-input schema/version from `contract-core`; the
entrypoint does not maintain separate method-version or public-input literals.
Keep the Rust tool and semantic descriptor in lockstep with
`contract-core/src/types.rs` when the journal contract changes.

## ImageID Trust and Rotation

The host embeds the guest ImageID compiled into that binary. During proof
generation it prints:

```text
Guest Program ImageID: 0x...
```

For a proof-free query:

```bash
./zkvm/target/release/host --print-image-id
./zkvm/target/release/host --print-image-id --json
```

The expected-ID source of truth is `public/imageId-mapping.json`. The current
mapping is keyed by method version 14 and has two explicit variants:

- `default` is confirmed by the accepted managed ARM64 Prover release
  for the current guest source.
- `x86_64` is independently confirmed from a fresh local production build.

Each variant is discriminated:

- `state: "confirmed"` carries an `imageId` and provenance.
- `state: "unconfirmed"` carries only
  `requiredEvidence: "accepted-prover-release"`.

Runtime selection never falls back between variants. An unset variant means
`default`; local x86_64 receipts require an explicit `x86_64` selection.
Unknown method versions, missing mappings, unavailable variants, and
unconfirmed variants fail closed. Normal App deployment requires the confirmed
`default` to match its selected managed ARM64 Prover release.

There is no resolver fallback or compatibility ImageID constant.
`resolveExpectedImageId()` requires either an explicit `EXPECTED_IMAGE_ID`
supplied by an authorized runtime boundary or a valid mapping loader. Target
runtime configuration must still bind any explicit override to the deployed
guest and active method version. The retired `EXPECTED_IMAGEID_POC` selector is
rejected by runtime-profile admission.

When guest source, features, or dependencies change:

1. Build ImageID evidence with a fresh `CARGO_TARGET_DIR`; a cached embedded
   guest artifact is not sufficient evidence.
2. Query that build with `--print-image-id --json` without generating a proof.
3. Update `public/imageId-mapping.json` with the appropriate confirmed or
   unconfirmed authority and provenance.
4. Update authorized `EXPECTED_IMAGE_ID` or `EXPECTED_IMAGE_ID_VARIANT`
   deployment inputs in lockstep.
5. Regenerate local receipts and output artifacts before using them for
   verification.

Do not introduce a fallback constant as part of release rotation. Do not mix a
new mapping with artifacts produced by an older guest build.

The managed ARM64 evidence and release model is documented in
[`docs/infrastructure/risc0-base-image.md`](../docs/infrastructure/risc0-base-image.md).

## Integration

### Synchronous/local

`packages/node-adapters/src/zkvm/executor.ts`:

- serializes the canonical TypeScript input
- runs `zkvm/target/release/host`
- validates and reads `*-output.json` and `*-receipt.json`
- restores exact included/seen bitmaps when their artifacts are present
- normalizes byte arrays for application consumers
- attempts to delete its temporary input and four output files in `finally`,
  on both success and failure; missing files are harmless, and other deletion
  failures produce a safe warning while preserving the original result

The local adapter launches the host directly in its own POSIX process group
(Linux, WSL, or macOS). The proof deadline stays at 600 seconds. Deadline and
host-exit cleanup signals the owned group, allows five seconds for termination,
then uses SIGKILL with a final one-second wait. Unconfirmed process-group
termination cannot produce a successful result. This manages children that
remain in the owned group; it is not a containment mechanism for a process
that deliberately creates another session.

The local static server also stops admission and waits for owned hosts on
SIGTERM or SIGINT, then closes remaining HTTP connections and lets artifact
cleanup finish. A SIGKILL of the server cannot execute this shutdown handler.

Logs distinguish spawn errors, nonzero exits, external signals, server shutdown, and the
adapter's own deadline. They include the configured deadline, elapsed time,
exit code, signal, and the admitted `starting`, `proving`, or `output_decoded`
stage. Arbitrary host stdout/stderr is drained without retaining its contents.
These progress stages are diagnostic and never establish receipt validity.

Real-mode CLI HTTP waits have a 636-second minimum: the host deadline plus
bounded shutdown and 30 seconds to return the result. The CLI reports a shorter
requested wait and the effective wait separately; it does not extend the
host's proof deadline.

### Asynchronous

Terraform dispatches an ECS Fargate task. `infra/docker/entrypoint.sh` runs the
host, creates the public bundle and private supporting artifacts, then uploads
the results to S3.

### Verification

`verifier-service/` verifies the receipt against the expected ImageID. The
application consumes its structured report; stdout from the prover host is not
a verification result.

## Troubleshooting

### Host binary is missing

Build the mode you need with `pnpm build:zkvm` or
`pnpm build:zkvm:dev-mode`, then confirm that
`zkvm/target/release/host` exists and is executable.

### Dev-mode receipt is rejected

This is expected in production verification. A dev-mode-capable verifier
reports `status: "dev_mode"` and exits non-zero; it does not promote a fake
receipt to success.

### ImageID mismatch

Check:

1. the receipt-producing architecture (`default` ARM64 or local `x86_64`)
2. the receipt wrapper's `image_id`
3. `public/imageId-mapping.json`
4. the selected `EXPECTED_IMAGE_ID_VARIANT`
5. any authorized explicit `EXPECTED_IMAGE_ID`
6. whether the host and receipt came from the same fresh guest build

## Related Documentation

- [`docs/zkvm/final-design.md`](../docs/zkvm/final-design.md)
- [`docs/guides/risc0-setup.md`](../docs/guides/risc0-setup.md)
- [`docs/guides/cli.md`](../docs/guides/cli.md)
- [`docs/verification/README.md`](../docs/verification/README.md)
- [`verifier-service/README.md`](../verifier-service/README.md)
- [RISC Zero documentation](https://dev.risczero.com/)

## License

Apache-2.0
