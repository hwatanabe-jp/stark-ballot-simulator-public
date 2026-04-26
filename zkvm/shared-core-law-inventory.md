# Shared-Core Law Inventory

`WS4` extracts the shared Rust owner for these laws into
`zkvm/contract-core/src/`.

## Shared-Core Target

### Input commitment encoding

Current owner:

- `zkvm/contract-core/src/encoding.rs`

Laws:

- canonical vote ordering makes `input_commitment` invariant under vote
  permutation
- duplicate indices are broken deterministically by commitment bytes and
  Merkle-path bytes
- exact byte encoding stays pinned by checked parity vectors

Evidence:

- exact vectors in `zkvm/methods/guest/src/compatibility_test.rs`
- generative laws in `zkvm/methods/guest/src/property_tests.rs`

### RFC 6962 inclusion-proof folding

Current owner:

- `zkvm/contract-core/src/inclusion_proof.rs`

Laws:

- a valid audit path round-trips to the reference root
- tampered leaf, path, or root material is rejected
- odd-width trees preserve RFC 6962 promotion semantics

Evidence:

- focused example tests in `zkvm/contract-core/src/inclusion_proof.rs`
- generative laws in `zkvm/methods/guest/src/property_tests.rs`

### Bitmap root helpers

Current owner:

- `zkvm/contract-core/src/bitmap.rs`

Laws:

- bitmap roots match the reference pack-plus-CT oracle
- flipping a bitmap bit changes the resulting root

Evidence:

- exact vectors in `zkvm/methods/guest/src/compatibility_test.rs`
- generative laws in `zkvm/methods/guest/src/property_tests.rs`

## Explicitly Out Of Shared Core

Host-only:

- JSON input parsing
- local artifact persistence
- bundle file layout and best-effort bitmap artifact output
- CLI wiring and async prover orchestration

Guest-only:

- zkVM entrypoint
- journal emission
- in-guest tally control flow

Verifier-service-only:

- bundle or receipt discovery
- verification report shaping
- `Receipt::verify(expected_image_id)` orchestration

Tooling-only:

- bridge payloads that pass raw artifacts across process boundaries
- compatibility helpers that are not part of the supported app selector
  contract

## WS4 Extraction Guardrail

`zkvm/contract-core/` should remain focused on the laws above and should
not pull in host-only, guest-only, verifier-service-only, or tooling-only
responsibilities alongside them.
