# Verification honesty

The product may display **Verified** only when every mandatory cryptographic
and consistency check passes. Missing, corrupt, inconsistent, or unavailable
evidence blocks that result.

Verification covers the cast receipt, bulletin-board inclusion and consistency,
tally inputs, ImageID, zkVM journal, and receipt verification. Mock evidence and
development-mode receipts support local demonstrations; they are not production
STARK proofs and must be labeled accordingly.

Operator and user-facing results identify which checks ran and why others
were skipped. The complete required check results determine display eligibility;
a partial report, screenshot, or deployment status alone cannot establish success.

The Public Specs define the [four-stage verification model](https://specs.stark-ballot-sim.hwatanabe.dev/verification/four-stage-model.html)
and [verdict conditions](https://specs.stark-ballot-sim.hwatanabe.dev/verification/gating-logic.html).
