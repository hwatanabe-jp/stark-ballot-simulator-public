# Development Guides

This section contains implementation guides and development workflows for the STARK Ballot Simulator project.

## Available Guides

### 🇯🇵 [Verification Bundle and Flow](../../verification/README.md)

**Purpose**: Understand the current verification pipeline, bundle contract, and authenticated delivery flow
**Contents**:

- `/api/verify` and `/api/verification/run`
- Public bundle vs private artifacts
- Verification checks, summary, and fail-closed behavior
- Bundle/report download authority

### 🇯🇵 [STARK証明検証テストガイド](./stark-verification-testing.md)

**Purpose**: Test STARK proof generation and verification  
**Contents**:

- CLI E2E テストと主要スクリプト
- Dev mode と本番STARKの違い
- Journal フォーマットと解析方法

## Development Workflow

1. **Server verification**: Start with [verification/README.md](../../verification/README.md) and [verifier-service/README.md](../../../../verifier-service/README.md)
2. **Testing**: Validate with [stark-verification-testing.md](./stark-verification-testing.md) と CLI (`pnpm test:cli:*`, [docs/current/tests/cli.md](../../tests/cli.md))

## Key Topics Covered

- **Server verification**: Lambda B orchestration, S3 bundling, signed URL issuance
- **Cryptographic consistency**: SHA-256 commitments + RFC6962 CT Merkle
- **Receipts**: Dev vs production STARK receipts and ImageID checks
- **Testing**: CLI harness and zkVM smoke tests

## Related Sections

- Prerequisites: [Setup Guides](../1-setup/)
- System design: [Architecture Guides](../4-architecture/)
- Technical details: [Reference Guides](../5-reference/)
