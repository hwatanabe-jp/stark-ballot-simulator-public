# zkVM Contract Plans

This directory contains the maintained planning documents for the
current zkVM contract work.

These documents are decision records, not implementation checklists or
runtime source of truth. For current runtime behavior, prefer the code
plus:

- `docs/current/verification/README.md`
- `zkvm/README.md`

Treat `docs/current/guides/6-zkvm_design/final_design.md` as design
intent and historical rationale, not as the active runtime contract.

## Shared Principles

- The repository supports one current contract only.
- Backward compatibility is not a goal when it preserves avoidable
  complexity, ambiguous authority, or stale compatibility branches.
- Unsupported or stale current-only state must fail closed.
- A bounded increase in scope is acceptable when it materially improves
  robustness, authority clarity, or rollout safety.
- The UI must never show `Verified` unless all required checks pass.

## Document Responsibilities

1. [Current Contract Generation Boundary Plan](./01-current-contract-generation-boundary-and-stale-state-plan.md)
   Defines what the current-generation boundary is, where it is owned,
   and how stale or corrupt state is classified before reads or writes
   proceed. **Status: WS0 implemented (commit `a0e0a79`).**
2. [Current Contract Authority Model and Public-Input Plan](./02-current-contract-authority-model-and-public-input-plan.md)
   Defines which fields and artifacts hold authority, who owns
   `public-input.json` acceptance, and how authority migrates away from
   `PublicInputSummary`. **Status: Cutover implemented (commit `3a02a08`).**
3. [Current Contract Public API and Download Plan](./03-current-contract-public-api-and-download-plan.md)
   Defines the route-visible fail-closed contract for unsupported or
   corrupt state, plus the authenticated browser and CLI download model.
   **Status: Route-visible contract and download authority implemented
   (commit `eaf034f`).**
4. [Canonical zkVM Path and Legacy Cleanup Plan](./04-canonical-zkvm-path-and-legacy-cleanup-plan.md)
   Defines what becomes canonical after hardening and which duplicate or
   legacy paths are then removed. **Status: WS1 implemented (commit
   `f0d6456`), WS2 implemented (commit `16dfb94`), WS3 implemented
   (commit `b63ca9b`), WS4 implemented (commit `654ba8e`), WS5
   implemented (commit `7f1d1df`).**
5. [Current Contract Ballot Evaluation Semantics Plan](./05-current-contract-ballot-evaluation-semantics-plan.md)
   Defines the current proof-bound ballot evaluation vocabulary and the
   slot-versus-record semantics that guest, host, and mock paths must
   share. **Status: implemented (commit `cd64efe`).**
6. [Current Contract Complexity Pruning Plan](./06-current-contract-complexity-pruning-plan.md)
   Defines the fact-checked post-01-05 compatibility residue that
   survived in finalized state, verification inputs, count vocabulary,
   and completion-state docs, plus the current-only pruning rules used
   to remove or quarantine it. **Status: internal pruning implemented
   (commit `b951166`); public alias and delivery-URL response fields
   remain projection-only deletion debt unless a later 03 cutover
   removes them.**
7. [Current Public Boundary Cutover Plan](./07-current-public-boundary-cutover-plan.md)
   Defines the explicit public-contract cutover for removing the
   projection-only count aliases, delivery-URL fields, URL-refresh
   behavior, and parse-only `proofMode` compatibility left after 06,
   while keeping authenticated bundle/report endpoints as the only
   browser and CLI download authority. **Status: implemented (commit
   `930026f`).**

## Current-State Reading Note

- 01-05 remain the decision records for the implemented rollout.
- Even so, some completion-state wording in 03 and 04 now understates
  compatibility residue that still survives in the codebase, especially
  delivery-URL and sync-finalize or status compatibility projections.
- When 03 or 04 and 06 disagree about that post-01-05 residue or its
  pruning status, prefer 06 for current-state reading.
- 07 owns the planned explicit public-boundary cutover for residue that
  06 intentionally left as projection-only or parse-only public deletion
  debt.
- 03 and 04 are fixed historical decision records and are not planned
  rewrite targets; future residue changes belong in 06, this index,
  implementation-oriented docs, or a new follow-up note.

## Reading Order

1. Read the boundary plan.
2. Read the authority and `public-input.json` plan.
3. Read the public API and download plan.
4. Read the cleanup plan.
5. Read the ballot evaluation semantics plan.
6. Read the complexity-pruning follow-up before planning cleanup of
   remaining compatibility residue, and whenever you need the
   fact-checked post-01-05 current state when older completion-state
   wording sounds too fully cleaned up.
7. Read the public-boundary cutover plan before removing public route
   aliases, public delivery URL fields, browser or CLI fallback parsing,
   URL-refresh download behavior, or `proofMode` compatibility.

## Historical Execution Order (01-05)

This sequence is the completed rollout order for 01-05.
The 06 document is the follow-up cleanup and current-state addendum for
residue that should be deleted or quarantined on top of that settled
baseline, not normalized as steady-state compatibility.

1. Establish the generation boundary and stale-state model.
2. Move consumers onto explicit authority ownership and the supported
   `public-input.json` contract.
3. Lock the public API, restore, and authenticated download contract on
   top of that boundary.
4. Start canonical cleanup only after the first three documents are
   satisfied.
5. Lock the current ballot evaluation semantics only after cleanup has
   made the surviving current paths explicit.

## Property-Based Testing Position

Property-based testing is a cross-cutting evidence strategy in this
directory, not an optional afterthought.

The reason is simple: the strongest guarantees in this cleanup program
do not come only from prose ownership rules. They come from keeping the
intentionally canonical implementations under generative pressure that
can expose edge cases humans are unlikely to enumerate by hand.

That evidence position lives primarily in
[Canonical zkVM Path and Legacy Cleanup Plan](./04-canonical-zkvm-path-and-legacy-cleanup-plan.md),
because that document decides which implementations remain intentionally
canonical and therefore deserve sustained investment.

In practice, that means:

- canonical CT append-only logic and canonical bitmap root or proof
  logic receive the main PBT investment
- parity vectors, fixtures, and PBT are complementary evidence, not
  substitutes for one another
- deletion-bound helpers receive only the characterization coverage
  needed to remove them safely
- shrunk counterexamples should be promoted into checked fixtures or
  vectors instead of remaining one-off local findings

## Deliberate Omissions

These documents intentionally avoid becoming exhaustive implementation
checklists. Detailed route inventories, touched-file lists, rollout
checklists, and command matrices belong in task-specific notes, PRs, or
test plans rather than in the decision documents themselves.
