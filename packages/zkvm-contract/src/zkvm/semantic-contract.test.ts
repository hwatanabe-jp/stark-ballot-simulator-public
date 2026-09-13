import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import checkedDescriptorJson from '../../../../zkvm/contract-core/src/current-zkvm-semantic-contract.json';
import {
  CURRENT_ZKVM_SEMANTIC_CONTRACT,
  CURRENT_ZKVM_SEMANTIC_INTERFACE_SHA256,
  CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS,
  parseCurrentZkvmSemanticContract,
} from './semantic-contract';
import { CURRENT_METHOD_VERSION, INPUT_COMMITMENT_FORMAT_VERSION, VERIFIED_TALLY_WIDTH } from './types';
import {
  MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
  MAX_GUEST_SERIALIZED_INPUT_BYTES,
  MAX_GUEST_TOTAL_EXPECTED,
  MAX_GUEST_TOTAL_PATH_NODES,
  MAX_GUEST_TREE_SIZE,
  MAX_GUEST_VOTE_COUNT,
} from './work-budget';

describe('current zkVM semantic contract', () => {
  it('runtime-admits the checked Rust descriptor and exposes literal bindings', () => {
    expect(parseCurrentZkvmSemanticContract(checkedDescriptorJson)).toEqual(CURRENT_ZKVM_SEMANTIC_CONTRACT);
    expect(CURRENT_ZKVM_SEMANTIC_INTERFACE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expectTypeOf(CURRENT_ZKVM_SEMANTIC_CONTRACT.method.methodVersion).toEqualTypeOf<14>();
    expectTypeOf(CURRENT_ZKVM_SEMANTIC_CONTRACT.method.inputCommitmentFormatVersion).toEqualTypeOf<10>();
    expectTypeOf(CURRENT_ZKVM_SEMANTIC_CONTRACT.logicalJournal.tallyWidth).toEqualTypeOf<5>();

    expect(CURRENT_METHOD_VERSION).toBe(CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS.methodVersion);
    expect(INPUT_COMMITMENT_FORMAT_VERSION).toBe(CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS.inputCommitmentFormatVersion);
    expect(VERIFIED_TALLY_WIDTH).toBe(CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS.tallyWidth);
  });

  it('binds exact host input, logical journal, and host JSON field order', () => {
    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.hostInputJson.fields.map((field) => field.name)).toEqual([
      'election_id',
      'bulletin_root',
      'tree_size',
      'log_id',
      'timestamp',
      'total_expected',
      'election_config_hash',
      'votes',
      'election_config',
    ]);
    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.hostInputJson.electionConfigFields).toEqual([
      { name: 'totalExpected', type: 'u32' },
      { name: 'choices', type: 'string[]' },
      { name: 'version', type: 'string' },
      { name: 'botCount', type: 'u32' },
      { name: 'merkleTreeDepth', type: 'u32' },
    ]);
    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.logicalJournal.fields.map((field) => field.name)).toEqual([
      'election_id',
      'election_config_hash',
      'bulletin_root',
      'tree_size',
      'total_expected',
      'sth_digest',
      'verified_tally',
      'total_votes',
      'valid_votes',
      'invalid_votes',
      'seen_indices_count',
      'missing_slots',
      'invalid_presented_slots',
      'rejected_records',
      'seen_bitmap_root',
      'included_bitmap_root',
      'excluded_slots',
      'input_commitment',
      'method_version',
    ]);
    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.hostJsonProjection.fields.at(-1)).toEqual({
      name: 'imageId',
      type: 'hex[32]',
    });
    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.artifacts.publicInput).toEqual({
      canonicalFileName: 'public-input.json',
      schema: 'stark-ballot.public_input',
      version: '1.1',
      fields: [
        { name: 'schema', type: 'literal' },
        { name: 'version', type: 'literal' },
        { name: 'electionId', type: 'uuid' },
        { name: 'electionConfigHash', type: 'hex[32]' },
        { name: 'bulletinRoot', type: 'hex[32]' },
        { name: 'treeSize', type: 'u32' },
        { name: 'totalExpected', type: 'u32' },
        { name: 'logId', type: 'hex[32]' },
        { name: 'timestamp', type: 'u64' },
        { name: 'methodVersion', type: 'u32' },
        { name: 'votes', type: 'publicInputVote[]' },
      ],
      voteFields: [
        { name: 'index', type: 'u32' },
        { name: 'commitment', type: 'hex[32]' },
        { name: 'merklePath', type: 'hex[32][]' },
      ],
    });
  });

  it('derives TypeScript work bounds from the admitted descriptor', () => {
    expect({
      treeSizeMax: MAX_GUEST_TREE_SIZE,
      totalExpectedMax: MAX_GUEST_TOTAL_EXPECTED,
      voteCountMax: MAX_GUEST_VOTE_COUNT,
      merklePathNodesPerRecordMax: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
      totalMerklePathNodesMax: MAX_GUEST_TOTAL_PATH_NODES,
      serializedInputBytesMax: MAX_GUEST_SERIALIZED_INPUT_BYTES,
    }).toEqual({
      treeSizeMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.treeSizeMax,
      totalExpectedMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.totalExpectedMax,
      voteCountMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.voteCountMax,
      merklePathNodesPerRecordMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.merklePathNodesPerRecordMax,
      totalMerklePathNodesMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.totalMerklePathNodesMax,
      serializedInputBytesMax: CURRENT_ZKVM_SEMANTIC_CONTRACT.workBounds.serializedInputBytesMax,
    });
  });

  it('rejects unknown keys and semantic fingerprint drift', () => {
    expect(() => parseCurrentZkvmSemanticContract({ ...checkedDescriptorJson, unexpected: true })).toThrow(
      /exact keys/u,
    );
    expect(() =>
      parseCurrentZkvmSemanticContract({
        ...checkedDescriptorJson,
        method: { ...checkedDescriptorJson.method, methodVersion: checkedDescriptorJson.method.methodVersion + 1 },
      }),
    ).toThrow(/semanticSha256/u);
  });

  it('keeps opaque receipt serialization and the synthetic packed layout outside the descriptor', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'zkvm/contract-core/src/current-zkvm-semantic-contract.json'),
      'utf8',
    );

    expect(CURRENT_ZKVM_SEMANTIC_CONTRACT.artifacts.receipt.receiptPayload).toBe('opaque');
    expect(source).not.toContain('schemaVersion');
    expect(source).not.toContain('byteOffset');
    expect(source).not.toContain('272');
  });
});
