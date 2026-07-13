# zkVM Design and Evidence

This area collects the proof design, journal/reference material, mock behavior,
and decision records for the RISC Zero path. Current code, tests, and the
[verification pipeline](../verification/README.md) remain the runtime source of
truth.

## Reading Order

| Document                                        | Purpose                                                                                 | Language    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| [Final design](./final-design.md)               | Design intent, I/O contract, security model, and implementation rationale               | 🇯🇵 Japanese |
| [Proof structure](./stark-proof-structure.md)   | Receipt types, journal layout, verification characteristics, and operational limits     | 🇯🇵 Japanese |
| [Verified information](./stark-info-summary.md) | What the proof reveals, what stays private, and how claimed and verified tallies differ | 🇯🇵 Japanese |
| [Mock zkVM](./mock-zkvm.md)                     | JavaScript mock modes and their testing role                                            | 🇬🇧 English  |
| [References](./references.md)                   | External RISC Zero and cryptographic references                                         | 🇬🇧 English  |
| [Decision records](./decisions/README.md)       | The reasoning and rollout evidence behind the current contract                          | 🇬🇧 English  |

The final-design document records design intent and historical rationale; it is
not an evergreen replacement for implementation-oriented verification docs.
Private expert feedback and historical phase notes are not part of this public
guide set.

## Current Contract at a Glance

- Development paths may use fake receipts under `RISC0_DEV_MODE=1`; production
  verification must reject them as production proof evidence.
- The current journal is a fixed 272-byte, methodVersion 14 layout.
- The journal exposes aggregate tally and integrity metadata, not individual
  vote openings.
- ImageID, method version, input commitment, bitmap roots, election manifest,
  close statement, and receipt verification all participate in a fail-closed
  verdict.
- Performance figures are environment-dependent evidence, not protocol
  guarantees.

## Evidence Framing

The decision files show how the contract evolved and which trade-offs were
accepted. The formal area machine-checks selected invariants and feeds vectors
into implementation tests. Neither body of evidence proves the complete
application or makes this PoC suitable for real elections.

Forward-looking priorities are tracked in the [roadmap](../roadmap.md).
