# Verification honesty

The product must never display **Verified** unless every mandatory
cryptographic and consistency check passes. Missing, corrupt, inconsistent, or
unavailable evidence fails closed and prevents the fully verified label.

Verification covers the cast receipt, bulletin-board inclusion and consistency,
tally inputs, ImageID, zkVM journal, and receipt verification. Mock evidence and
development-mode receipts support local demonstrations; they are not production
STARK proofs and must be labeled accordingly.

Operator and user-facing results distinguish checks that ran from checks that
were skipped, including the reason. A successful presentation cannot be
inferred from a partial report, a screenshot, or a deployment status alone.
