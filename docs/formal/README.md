# Formal Model

This directory contains the stable outputs from the Lean 4 formalization
workspace under `formal/`. Lean is installed through `elan`; `lake` is provided
by the selected Lean toolchain rather than by a separate system package. The
workspace pins `leanprover/lean4:v4.33.1` in `formal/lean-toolchain` for
reproducible builds.

## Scope and Claim Boundaries

The formal layer covers a small fail-closed model for verification summaries, a
mathematical `Nat` model for zkVM journal count fields,
implementation-correspondence models for canonical input commitment preimage
encoding and LSB-first bitmap packing, and an abstract guest state machine over
presented vote records.

The count model makes the slot partition explicit:

```text
validVotes <= seenIndicesCount <= treeSize
missingSlots = treeSize - seenIndicesCount
invalidPresentedSlots = seenIndicesCount - validVotes
excludedSlots = missingSlots + invalidPresentedSlots
```

The abstract guest fold preserves duplicate-free seen indices, keeps every seen
index in range, and maintains `validVotes <= seenIndices.length`. Those
invariants imply that the seen-index count cannot exceed `treeSize`; with the
count definitions above, `excludedSlots = 0` over `processVotes` forces all seen
slots to be counted and the seen slot count to match `treeSize`.

The bounded-counter theorem takes two explicit input premises:
`treeSize <= 1,000,000` and presented vote count `<= 1,000,000`. From those
premises it proves that the modeled seen, valid, rejected, and per-candidate
tally counts remain in the Rust `u32` domain. In particular, each candidate
tally bucket being `<= 1,000,000` is a proved consequence of the tree-size
bound, not a third input precondition. The Rust checked validation-and-tally
path independently validates the input ceilings, uses checked counter
increments, and rejects a candidate bucket above the same ceiling.

| Category      | Current claim                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proved        | Fail-closed summary invariants, journal count partition facts, canonical input-order facts, LSB-first bitmap facts, abstract guest tally/order invariants, and guest count plus tally-bucket bounds under explicit input limits. |
| Vector-tested | TypeScript summary/display behavior, TypeScript and Rust input commitment encoding, TypeScript and Rust bitmap packing/Merkle behavior, TypeScript check-definition metadata, and Rust guest-model correspondence cases.         |
| Assumed       | SHA-256 collision resistance, RISC Zero receipt soundness, compiler/runtime correctness, and correctness of implementation surfaces outside the vector-tested contracts.                                                         |
| Not claimed   | Full formal verification of the voting system, full Rust zkVM guest correctness, serialization boundaries, AWS runtime verification, React rendering correctness as a whole, or production election security.                    |

## Models and Vector Consumers

Generated vectors in `generated-vectors/` connect the formal models to targeted
TypeScript and Rust coverage:

- The verification summary and display vectors exercise fail-closed summary and
  shared presentation-policy behavior. The Lean summary model is scoped to
  known check inputs; the TypeScript summary boundary returns `null` for empty
  and all-unknown check sets, and the shared
  `verification-presentation-policy.ts` does not make those cases eligible for
  or render them as `verified`.
- The check-definition vector is emitted by Lean from the summary-model metadata
  and compared with `VERIFICATION_CHECK_DEFINITIONS` in TypeScript. For the
  modeled fields, the Lean artifact guards the ID, category, role, default
  criticality, and `recorded_sth_third_party` promotion rule.
- The input commitment vectors include canonical vote order and the exact
  pre-hash byte sequence. The model is a byte-layout model, not a SHA-256
  security proof. Its well-formedness assumptions encode vote count, vote
  index, `treeSize`, and `totalExpected` as `u32`, and each Merkle path length as
  `u16`. Its permutation-invariance theorem covers the hashed vote encoding
  fields; generated vector `id` labels are not part of the modeled pre-hash
  bytes.
- The bitmap vectors cover 0, 1, 7, 8, 9, 31, 32, 33, 255, 256, 257, 511, 512,
  513, and 1025 bit boundaries and define bit `i` as byte `i / 8`, bit position
  `i % 8`.
- The guest model captures duplicate-index rejection, invalid presented slots,
  candidate-indexed tally increments, commitment reservation before
  inclusion-proof rejection, and retained rejection classifications. Its
  vectors are consumed through the Rust guest's checked inspection surface,
  which shares the validation and fold logic used by `guest_main`.

`formal/Scripts/EmitTestVectors.lean` is the sole producer of all six vectors'
contents. `pnpm formal:vectors` applies Oxfmt to the emitted JSON before it
becomes committed evidence. `scripts/formal/check-formal-vectors.ts` invokes
the Lean emitter with a temporary output directory, formats its JSON through
the shared `scripts/formatting/format-source.ts` helper, and compares those
bytes with the committed files. Each file is an unnumbered exact-current envelope with the
exact keys `envelopeType`, `kind`, `modeledBounds`, `payload`, and
`canonicalSha256`. `envelopeType` is the current-contract discriminator, while
`kind` binds the file path to its one admitted payload shape. The fingerprint is
SHA-256 over the recursively key-sorted, whitespace-free JSON body after
removing `canonicalSha256`. Unknown, missing, generation-number, wrong-kind,
and fingerprint-drifted envelopes fail closed; there is no compatibility
reader for a retired vector shape.

Every envelope repeats the modeled integer and work bounds so a vector cannot
silently outlive the runtime contract it exercises. The current metadata binds
input commitment format `10`, `u16` maximum `65,535`, `u32` maximum
`4,294,967,295`, guest method `14`, tree/expected/vote and total-path ceilings
of `1,000,000`, per-record path ceiling `65,535`, serialized-input ceiling
`67,108,864` bytes, tally width `5`, and tally-bucket ceiling `1,000,000`.
`@stark-ballot/zkvm-contract/zkvm/formal-vectors` admits imported JSON from
`unknown` and asserts those values against the TypeScript contract constants.
The Rust correspondence tests use the exact serde envelope admission in
`zkvm/contract-core/src/formal_vector_test_support.rs` and assert the same
metadata against the Rust constants before consuming a payload.

Lean remains an independent model and deterministic evidence producer. The
emitter does not generate TypeScript or Rust runtime implementations; each
runtime retains its own constants and behavior, and the correspondence tests
compare them through the admitted envelopes.

## Stable Artifacts and Audit

The stable public outputs are `formal-report.json`, `formal-audit.json`, and the
summary, display, input commitment, bitmap, check-definition, and guest-model
files under `generated-vectors/`.

`formal-report.json` omits volatile fields such as `generatedAt` and
`repoCommit`, lists theorem claims and assumptions, records the current envelope
discriminator, and owns the exhaustive generated-vector path-to-kind registry.
It is checked by a targeted Vitest schema test. `formal-audit.json` records
theorem statement hashes, byte-for-byte generated-vector hashes, checked
`#print axioms` dependency summaries, the proof-hygiene scan summary, and the
native-decision allowlist.

The theorem dependencies are checked under Lean `v4.33.1`. The allowlisted Lean
core axioms are `propext`, `Quot.sound`, and `Classical.choice`. The
`pack_bits_get_bit` theorem also depends on generated `native_decide` axioms from
the exhaustive byte-bit case split in `byteValueAt_get_bit`;
`formal-audit.json` permits `native_decide` only in
`formal/StarkBallotFormal/Bitmap.lean`. There are no `sorry` terms or
hand-written project-specific axioms in the formal sources.

Generated artifacts must not contain private proof inputs or runtime witness
artifacts such as `input.json`, `verification.json`, `included-bitmap.json`, or
`seen-bitmap.json`.

## Commands and CI

The formal workspace marks its library, vector emitter, and report emitter as
Lake default targets. `cd formal && lake check-build` should pass, and
`pnpm formal:build` should build non-empty targets rather than reporting
`0 jobs`.

- `pnpm formal:report` regenerates `formal-report.json`.
- `pnpm formal:audit` regenerates `formal-audit.json`.
- `pnpm formal:vectors` regenerates the correspondence vectors.
- `pnpm formal:verify` checks the Lean build, report freshness, vector
  freshness, audit freshness, explicit TypeScript consumers, and formatting of
  the stable outputs.

Dedicated formal CI runs `pnpm formal:verify` when the Lean workspace, stable
formal artifacts, or implementation files guarded by formal vectors change.
The generated public repository snapshot has the same path-filtered formal
gate, and the public snapshot release path builds Lean and runs
`pnpm formal:verify` before export. Vector-consuming TypeScript tests also run
in the core test gate; the Rust input-commitment, bitmap, and guest-model vector
consumers run in the zkVM Rust test gate.
