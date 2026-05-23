# Formal Model

This directory contains stable outputs from the Lean 4 formalization workspace
under `formal/`.

Lean is installed through `elan`; `lake` is provided by the selected Lean
toolchain rather than by a separate system package. The workspace pins the
toolchain in `formal/lean-toolchain` for reproducible builds. The current pin is
`leanprover/lean4:v4.29.1`.

Phase 1 proves a small fail-closed model for verification summaries and a
mathematical `Nat` model for zkVM journal count fields. Phase 2 adds
implementation-correspondence models for canonical input commitment preimage
encoding and LSB-first bitmap packing. Phase 3 adds an abstract guest state
machine over presented vote records and a stable generated report at
`formal-report.json`. Phase 4 adds generated guest-model and check-definition
vectors plus `formal-audit.json`, which records proof-hygiene checks, theorem
statement hashes, and generated-vector hashes.

The count model makes the slot partition explicit:

```text
validVotes <= seenIndicesCount <= treeSize
missingSlots = treeSize - seenIndicesCount
invalidPresentedSlots = seenIndicesCount - validVotes
excludedSlots = missingSlots + invalidPresentedSlots
```

The current proof shows that the abstract guest fold preserves duplicate-free
seen indices, keeps every seen index in range, and maintains
`validVotes <= seenIndices.length`. Those fold-derived invariants imply the
seen-index count cannot exceed `treeSize`; with the count definitions above,
`excludedSlots = 0` over `processVotes` forces all seen slots to be counted and
the seen slot count to match `treeSize`. The guest model explicitly models
duplicate-index rejection, invalid presented slots, candidate-indexed tally
increments, commitment reservation before inclusion-proof rejection, and
retained rejection classifications.

This is a mathematical `Nat` model and an abstract state machine. The Phase 4
guest bound theorem connects the modeled seen, valid, rejected, and per-candidate
tally bucket counts to the Rust `u32` domain only for accepted inputs satisfying
the explicit Phase 4 guest bounds enforced by the guest's checked
validation-and-tally entry point: `treeSize <= 1,000,000`, presented vote count
`<= 1,000,000`, and each candidate tally bucket `<= 1,000,000`. It does not
prove serialization boundaries, SHA-256 collision resistance, RISC Zero receipt
soundness, AWS runtime behavior, React rendering behavior, or
production-election security.

Generated vectors in `generated-vectors/` connect the formal summary/display,
input commitment, bitmap, check-definition, and guest models to targeted
TypeScript and Rust coverage. The input commitment vectors include canonical
vote order and the exact pre-hash byte sequence. The bitmap vectors cover 0, 1,
7, 8, 9, 31, 32, 33, and 257 bit boundaries and document bit `i` as byte
`i / 8`, bit position `i % 8`. The guest-model vectors are consumed through the
Rust guest's checked inspection surface, which shares the same validation and
fold logic used by `guest_main`.

The check-definition vector is emitted by Lean from the summary-model metadata
and compared with `VERIFICATION_CHECK_DEFINITIONS` in TypeScript. For the fields
currently modeled in Lean, the Lean artifact is the drift-guard source for ID,
category, role, default criticality, and the `recorded_sth_third_party`
promotion rule.

The Lean summary model is scoped to known check inputs. The TypeScript API
boundary intentionally returns `null` for empty and all-unknown check sets; those
cases are covered by TypeScript tests, and the verify page overall-status helper
must not render them as `verified`.

`formal-report.json` is intentionally stable: it omits volatile fields such as
`generatedAt` and `repoCommit`, lists theorem claims and assumptions, and is
checked by a targeted Vitest schema test. `formal-audit.json` records theorem
statement hashes, generated vector hashes, checked `#print axioms` dependency
summaries, the proof-hygiene scan summary, and the native-decision allowlist.
`pnpm formal:report` regenerates the report; `pnpm formal:audit` regenerates the
audit artifact; `pnpm formal:verify` checks the Lean build, report freshness,
generated-vector freshness, audit freshness, and formatting/drift checks on the
stable outputs. Dedicated
formal CI workflows run the same `pnpm formal:verify` gate for changes to the
Lean workspace, stable formal artifacts, and implementation files guarded by
formal vectors, including in the generated public repository snapshot. The
vector-consuming TypeScript tests run in the core test gate; the Rust
input-commitment, bitmap, and guest-model vector consumers run in the zkVM Rust
test gate.

The input commitment model is a byte-layout model, not a SHA-256 security proof.
It makes the implementation widths explicit through well-formedness
assumptions: vote count, vote index, `treeSize`, and `totalExpected` are encoded
as `u32`; each Merkle path length is encoded as `u16`. Its
permutation-invariance theorem is stated over the hashed vote encoding fields;
generated vector `id` labels are deliberately not part of the modeled pre-hash
bytes.

Phase 2, Phase 3, and Phase 4 theorem dependencies are checked with
`#print axioms` under Lean `v4.29.1` by `pnpm formal:audit`. The allowlisted
Lean core axioms are `propext`,
`Quot.sound`, and `Classical.choice`. The `pack_bits_get_bit` theorem also
depends on generated `native_decide` axioms from the exhaustive byte-bit case
split in `byteValueAt_get_bit`; `formal-audit.json` allowlists
`native_decide` only in `formal/StarkBallotFormal/Bitmap.lean`. There are no
`sorry` terms or hand-written project-specific axioms in the formal sources.

## Claim Boundaries

| Category      | Current claim                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proved        | Fail-closed summary invariants, journal count partition facts, canonical input-order facts, LSB-first bitmap facts, abstract guest tally/order invariants, and guest count plus tally-bucket bounds under explicit input limits. |
| Vector-tested | TypeScript summary/display behavior, TypeScript and Rust input commitment encoding, TypeScript and Rust bitmap packing/Merkle behavior, TypeScript check-definition metadata, and Rust guest-model correspondence cases.         |
| Assumed       | SHA-256 collision resistance, RISC Zero receipt soundness, compiler/runtime correctness, and correctness of implementation surfaces outside the vector-tested contracts.                                                         |
| Not claimed   | Full formal verification of the voting system, full Rust zkVM guest correctness, AWS runtime verification, React rendering correctness as a whole, or production election security.                                              |

Generated artifacts must not contain private artifacts such as `input.json`,
`verification.json`, `included-bitmap.json`, or `seen-bitmap.json`.

The formal workspace marks its library, vector emitter, and report emitter as
Lake default targets. `cd formal && lake check-build` should pass, and
`pnpm formal:build` should build non-empty targets rather than reporting
`0 jobs`.
