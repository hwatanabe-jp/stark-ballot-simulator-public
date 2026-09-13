// Generated literal projection of the Rust-owned current descriptor.
// Freshness is enforced by semantic-contract.test.ts; do not edit independently.
export const CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS = {
  methodVersion: 14,
  inputCommitmentFormatVersion: 10,
  tallyWidth: 5,
  domainTags: {
    voteCommitment: 'stark-ballot:commit|v1.0',
    inputCommitment: 'stark-ballot:input|v1.0',
  },
  hostJsonProjectionFieldNames: [
    'electionId',
    'electionConfigHash',
    'bulletinRoot',
    'treeSize',
    'totalExpected',
    'sthDigest',
    'verifiedTally',
    'totalVotes',
    'validVotes',
    'invalidVotes',
    'seenIndicesCount',
    'missingSlots',
    'invalidPresentedSlots',
    'rejectedRecords',
    'seenBitmapRoot',
    'includedBitmapRoot',
    'excludedSlots',
    'inputCommitment',
    'methodVersion',
    'imageId',
  ],
} as const;

export const CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS = {
  descriptorType: 'stark-ballot.zkvm-semantic-contract.current',
  methodVersion: CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.methodVersion,
  inputCommitmentFormatVersion: CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.inputCommitmentFormatVersion,
  tallyWidth: CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.tallyWidth,
  hostJsonProjectionFieldNames: CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.hostJsonProjectionFieldNames,
  semanticSha256: 'b10614a70535aeeac6cadd40ff9cee5a49d90702513a4dd743fbd8be111539af',
  domainTags: CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.domainTags,
  workBounds: {
    treeSizeMin: 1,
    treeSizeMax: 1_000_000,
    totalExpectedMax: 1_000_000,
    voteCountMax: 1_000_000,
    merklePathNodesPerRecordMax: 65_535,
    totalMerklePathNodesMax: 1_000_000,
    serializedInputBytesMax: 67_108_864,
  },
  artifacts: {
    receipt: {
      hostFileSuffix: '-receipt.json',
      canonicalFileName: 'receipt.json',
      receiptPayload: 'opaque',
    },
    publicInput: {
      canonicalFileName: 'public-input.json',
      schema: 'stark-ballot.public_input',
      version: '1.1',
    },
    includedBitmap: {
      hostFileSuffix: '-bitmap.json',
      canonicalFileName: 'included-bitmap.json',
      schema: 'stark-ballot.included_bitmap',
      version: '1.0',
    },
    seenBitmap: {
      hostFileSuffix: '-seen-bitmap.json',
      canonicalFileName: 'seen-bitmap.json',
      schema: 'stark-ballot.seen_bitmap',
      version: '1.0',
    },
  },
} as const;
