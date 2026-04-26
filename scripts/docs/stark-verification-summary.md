# STARK Proof Verification Summary

## Command-Line Verification Path

STARK receipt verification is owned by `verifier-service`, the Rust CLI that
calls `Receipt::verify(expected_image_id)`.

Use the repository test helper for the current tamper regression:

```bash
pnpm test:stark-tamper
```

For manual verification, build the verifier and run:

```bash
pnpm build:verifier-service
./verifier-service/target/release/verifier-service verify /path/to/bundle-or-receipt --image-id 0x...
```

`RISC0_DEV_MODE=1` receipts are fake/dev-mode receipts and are rejected by
`verifier-service` as non-production proof evidence.

## Historical Scenario Notes

The older scenario notes below are retained as context for the demo matrix.
They are not a substitute for `verifier-service verify` output.

### Older Run Observations

The older notes reported:

1. **STARK Proof Generation**: all 6 scenarios (S0-S5) produced ~1.5MB STARK proofs
2. **Receipt Structure**: receipts could be parsed correctly
3. **Journal Data**: vote counts and tamper detection data were extracted successfully
4. **Seal Data**: the seal was ~65KB

### Historical Verification Results

| Scenario | Description                        | Total Votes | Tampered | Claimed Distribution         |
| -------- | ---------------------------------- | ----------- | -------- | ---------------------------- |
| S0       | No tampering                       | 64          | 0        | A=14, B=13, C=13, D=12, E=12 |
| S1       | Ignore user                        | 63          | 1        | A=13, B=13, C=13, D=12, E=12 |
| S2       | Tamper claimed tally for your vote | 64          | 1        | A=13, B=13, C=13, D=12, E=13 |
| S3       | Ignore bot                         | 63          | 1        | A=13, B=13, C=13, D=12, E=12 |
| S4       | Tamper claimed tally for bot votes | 64          | 1        | A=13, B=14, C=13, D=12, E=12 |
| S5       | Random errors                      | 62          | 2        | A=12, B=13, C=13, D=12, E=12 |

> Note: S2/S4 now simulate **claimed tally tampering**. The zkVM journal still reflects the correct tally, while the published (claimed) counts diverge and are detected during verification.

Treat these notes as historical evidence only. For current proof evidence, rerun `pnpm test:stark-tamper` or the documented CLI path and inspect the resulting `verifier-service verify` output.
