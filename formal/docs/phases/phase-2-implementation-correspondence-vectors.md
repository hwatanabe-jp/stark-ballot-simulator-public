# Phase 2: Implementation Correspondence Vectors

> Status: completed in commit `c36b092a`. The Lean input-commitment and
> bitmap models, the six required theorems, the generated
> `input-commitment-cases.json` and `bitmap-cases.json` vectors, and the
> TypeScript + Rust tests that consume them are all in place. Rust now exposes
> a shared `encode_input_commitment_preimage` helper and the verify page
> hard-failure override is aligned with the new display vector. Treat this
> document as historical context for Phase 3 onwards.

## Purpose

Formalize the P1 implementation-correspondence surfaces and connect them to
existing TypeScript and Rust tests with generated vectors.

This phase covers canonical input commitment encoding and LSB-first bitmap
packing together because both are deterministic byte-level contracts that Lean
can model without claiming cryptographic hash security.

## Implementation Sources

- `zkvm/contract-core/src/encoding.rs`
- `zkvm/contract-core/src/bitmap.rs`
- `src/lib/zkvm/types.ts`
- `src/lib/zkvm/bitmap.ts`
- `src/lib/merkle/bitmap-merkle-tree.ts`
- `src/server/api/handlers/bitmapProof.ts`
- `src/lib/zkvm/__tests__/ts-rust-compatibility.test.ts`
- `src/lib/zkvm/__tests__/final-design-test-vectors.test.ts`
- `docs/current/verification/README.md`

## Deliverables

- `formal/StarkBallotFormal/InputCommitment.lean`
- `formal/StarkBallotFormal/Bitmap.lean`
- extended `formal/Scripts/EmitTestVectors.lean`
- theorem: `canonical_vote_order_total`
- theorem: `canonical_encoding_permutation_invariant`
- theorem: `canonical_encoding_duplicate_indices_deterministic`
- theorem: `pack_bits_length`
- theorem: `pack_bits_get_bit`
- theorem: `distinct_indices_distinct_packed_addresses`
- generated `docs/current/formal/generated-vectors/input-commitment-cases.json`
- generated `docs/current/formal/generated-vectors/bitmap-cases.json`
- extended `formal:vectors` script coverage
- TypeScript tests consuming the generated vectors
- Rust tests consuming the generated vectors, or an explicit follow-up if Rust
  wiring is too large for the first pass

## Input Commitment Model

The key property:

```text
If two vote lists are permutations of each other, then canonical sorting by
index, commitment, and Merkle path yields the same encoded byte sequence.
```

The generated vectors should include unsorted vote lists, the expected canonical
order, and the expected pre-hash encoded byte sequence as hex. Implementation
tests should assert the existing code computes the same canonical order, the
same encoded bytes, and then the same input commitment for each case.

The modeled pre-hash byte sequence must include every field currently hashed by
the TypeScript and Rust implementations, in order:

```text
INPUT_DOMAIN_TAG = "stark-ballot:input|v1.0"
input commitment format version = 10u32 little-endian
electionId = 16 bytes
bulletinRoot = 32 bytes
treeSize = u32 little-endian
totalExpected = u32 little-endian
voteCount = u32 little-endian
for each canonically sorted vote:
  index = u32 little-endian
  commitmentLen = 32u16 little-endian
  commitment = 32 bytes
  merklePathLen = u16 little-endian
  merklePath nodes = 32 bytes each
```

If the current implementation does not expose the pre-hash encoder, add a
narrowly scoped test helper rather than weakening the correspondence check to a
hash equality only.

Lean should model the deterministic byte sequence sent to the hash function. It
should not try to prove SHA-256 collision resistance.

The model must also make the implementation's bounded encodings explicit:

- vote count is encoded as `u32`
- vote index is encoded as `u32`
- `treeSize` and `totalExpected` are encoded as `u32`
- each Merkle path length is encoded as `u16`

Generated vectors should stay within those bounds unless they are deliberately
testing boundary behavior. Do not let a theorem over unbounded `Nat` values imply
that the implementation accepts or preserves values outside those encoded
widths.

## Bitmap Model

The Lean model should prove:

```text
bit i maps to byte i / 8 and bit position i % 8
packBits(bits).length = ceil(bits.length / 8)
different in-range indices map to different global packed-bit addresses,
equivalently different (byteIndex, bitIndex) pairs
```

The distinctness theorem should be phrased over packed addresses or
`(byteIndex, bitIndex)` pairs, not over `i % 8` alone.

Boundary cases should cover:

```text
0, 1, 7, 8, 9, 31, 32, 33, 257 bits
```

## Test Connection

Reuse or extend the existing TypeScript/Rust compatibility tests for input
commitments.

Add or extend bitmap tests for:

- `src/lib/zkvm/bitmap.ts`
- `src/lib/merkle/bitmap-merkle-tree.ts`
- `zkvm/contract-core/src/bitmap.rs`

## Acceptance

Acceptance criteria:

- `lake build` succeeds.
- `formal:vectors` regenerates stable fixtures.
- Input commitment vectors include `expectedCanonicalOrder` and
  `expectedEncodedBytesHex`.
- Input commitment vectors cover the domain tag, format version, fixed
  commitment length field, vote count, and Merkle path length fields in the
  expected encoded bytes.
- The Lean model documents the `u32` / `u16` encoding bounds above, and the
  implementation tests either stay inside those bounds or assert the intended
  fail-closed behavior at the boundary.
- TypeScript implementation tests consume the generated fixtures.
- Rust implementation tests consume the generated fixtures, or Rust wiring is
  documented as a follow-up with a narrow owner and path.
- LSB-first behavior is documented and checked on both TypeScript and Rust sides
  before claiming this phase complete.
