# Reference Guides

This section contains technical reference documentation and detailed analysis of STARK proofs. The content reflects the current implementation.

## Available Guides

### 🇯🇵 [STARK証明の構造と特性](./stark-proof-structure.md)

**Purpose**: RISC Zero zkVM STARK receipt structure and current operational characteristics
**Contents**:

- Receipt structure (Composite vs Fake) and verification contract
- Journal layout (current methodVersion=14, fixed 272-byte layout)
- Proof size/time characteristics (environment dependent)
- Scalability notes and operational considerations

### 🇯🇵 [STARK証明検証で得られる情報の詳細分析](./stark-info-summary.md)

**Purpose**: What information is revealed by the current STARK verification flow
**Contents**:

- Verified tally vs UI/claimed tally (educational tamper scenarios)
- Privacy analysis (what remains private)
- Data available from journal and verification pipeline
- How tamper scenarios are inferred without individual vote disclosure

## Key Technical Details

### STARK Proof Characteristics

- **Receipt type**: Fake receipts in dev (`RISC0_DEV_MODE=1`) vs Composite STARK in production
- **Size**: Fake receipts are small (few KB); real receipt JSON artifacts are typically hundreds of KB to ~2MB
- **Generation time**: Fake receipts ~100ms; real proofs are minutes (64 votes ≈ ~370s on current baseline; environment dependent)
- **Verification time**: Seconds
- **Security level**: 100+ bits (RISC Zero default)

### Journal Data Structure (current layout)

- **Size**: 272 bytes
- **Parsed fields (ordered)**:
  - electionId (16 bytes)
  - electionConfigHash (32)
  - bulletinRoot (32)
  - treeSize (u32)
  - totalExpected (u32)
  - sthDigest (32)
  - verifiedTally (5 x u32)
  - totalVotes, validVotes, invalidVotes, seenIndicesCount, missingSlots, invalidPresentedSlots, rejectedRecords (u32 each)
  - seenBitmapRoot (32)
  - includedBitmapRoot (32)
  - excludedSlots (u32)
  - inputCommitment (32)
  - methodVersion (u32)
- **Note**: `tamperDetected` and `imageId` are not part of the raw journal bytes. JSON projections may add `imageId` as comparison-only metadata.

### Privacy Guarantees

- ✅ **Protected**: Individual vote contents (choice/random) and voter-vote linkage
- ✅ **Protected**: Order of votes and per-vote modifications
- ⚠️ **Exposed (aggregate)**: Verified tally, totals, and integrity counters
- ✅ **Always public**: Bulletin root, STH digest, input commitment, bitmap root (verification metadata)

## Use Cases

- **Performance planning**: Use proof size/time ranges, not fixed numbers
- **Security review**: Understand what is revealed by the journal
- **Integration**: Align API consumers with the current journal layout (methodVersion=14, `seenBitmapRoot` required)
- **Verification UX**: Separate UI/claimed results from zkVM-verified outputs

## Related Sections

- Implementation: [Development Guides](../2-development/)
- System design: [Architecture Guides](../4-architecture/)
- Testing: [STARK Verification Testing](../2-development/stark-verification-testing.md)
