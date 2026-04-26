# Security Policy

## Scope

STARK Ballot Simulator is a portfolio/demo proof of concept for end-to-end verifiable voting. It is not a
production voting system, and the live demo must not be treated as election infrastructure.

Please do not submit secrets, credentials, private keys, personal data, or sensitive ballots to the live demo or to
issues. `RISC0_DEV_MODE=1` receipts are development-mode receipts and are not real STARK proofs.

## Reporting Vulnerabilities

Use GitHub private vulnerability reporting or a private security advisory when available. If private reporting is not
enabled, open a minimal issue asking for a private contact path and do not include exploit details, secrets, or live
tokens in the public issue.

Helpful reports include:

- affected route, script, or document path
- expected and observed behavior
- minimal reproduction steps against a local clone when possible
- whether the issue affects the live demo, the public repository snapshot, or both

## Testing Boundaries

Do not run automated vulnerability scans, load tests, fuzzers, credential stuffing, or destructive tests against
`stark-ballot-sim.hwatanabe.dev` or `specs.stark-ballot-sim.hwatanabe.dev` without prior authorization. Local testing
against your own clone is welcome.

When testing AWS, Terraform, S3, or callback behavior, use resources you control. Do not attempt to access or enumerate
private infrastructure, buckets, queues, logs, or accounts.

## Supported Version

Security review should target the current `main` branch or the generated public snapshot identified by
`.public-export-manifest.json`.

## Known PoC Limits

- ballot secrecy against the operator is not a goal for every demo path
- educational tamper scenarios intentionally expose unrealistic failure modes
- public bundles intentionally exclude `input.json`, `verification.json`, `included-bitmap.json`, and `seen-bitmap.json`
- the verification UI must never show "Verified" unless all required checks pass
