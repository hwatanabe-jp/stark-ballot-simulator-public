# Architecture Guides

This section contains system design and architecture documentation for the STARK Ballot Simulator.

## Available Guides

### 🇯🇵 [AWS構成のよくある図（現状スナップショット）](./aws-architecture.md)

**Purpose**: Current AWS architecture overview (Amplify + Hono + proof pipeline)  
**Contents**:

- Frontend + API Gateway + Hono Lambda
- Amplify Data (AppSync/DynamoDB) + S3 proof bundles
- SQS → Step Functions → ECS Fargate prover pipeline
- Server-side STARK verification Lambda

## Key Topics

### Current Implementation (Educational PoC)

- **Purpose**: Demonstration of zero-knowledge voting concepts
- **Architecture**: Stateless, session-based (30-minute active TTL / 24-hour verification TTL)
- **Limitations**:
  - zkVM knows tampering scenarios in advance
  - Individual vote contents exposed when tampered
  - Not suitable for real elections

### Ideal Implementation

- **Privacy-first**: Individual votes never exposed
- **Trustless**: No need to trust aggregator or zkVM
- **Verifiable**: Mathematical proofs ensure integrity
- **Scalable**: Chunk processing for large elections

## Design Principles

1. **Role Separation**:
   - Voters: Submit commitments only
   - Aggregator: Collects and tallies (untrusted)
   - zkVM: Neutral verifier
   - Public Board: Transparency layer

2. **Privacy Protection**:
   - Witness data (choice, random) never in journal
   - Only aggregated results published
   - Selective disclosure for tampering

3. **Scalability**:
   - 10,000 votes per chunk
   - Parallel proof generation
   - Merkle tree optimization

## Related Documentation

- Implementation details: [Development Guides](../2-development/)
- STARK proof details: [Reference Guides](../5-reference/)
- Deployment considerations: [Deployment Guides](../3-deployment/)
