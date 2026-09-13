import { describe, expect, it } from 'vitest';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { generateBitmapMerkleProof } from '@stark-ballot/verification/merkle/bitmap-merkle-tree';
import type { AdmittedConsistencyProof } from '../consistency-proof-types';
import { evaluateChecks } from './evaluate-checks';
import type { EvidenceAcquisition, VerificationEvaluationInput } from './types';

const ROOT = `0x${'1'.repeat(64)}`;

function admitted<T>(value: T): EvidenceAcquisition<T> {
  return { kind: 'admitted', value };
}

function consistencyContext(
  consistencyProof: EvidenceAcquisition<AdmittedConsistencyProof>,
): VerificationEvaluationInput {
  return {
    voteReceipt: {
      voteId: 'vote-1',
      commitment: `0x${'2'.repeat(64)}`,
      bulletinIndex: 0,
      bulletinRootAtCast: ROOT,
      timestamp: 1,
    },
    userVote: {
      commitment: `0x${'2'.repeat(64)}`,
      proof: {
        leafIndex: 0,
        treeSize: 1,
        merklePath: [],
        bulletinRootAtCast: ROOT,
      },
    },
    bulletinRoot: ROOT,
    treeSize: 1,
    consistencyProof,
  };
}

function admittedConsistencyProof(overrides: Partial<AdmittedConsistencyProof> = {}): AdmittedConsistencyProof {
  return {
    fromTreeSize: 1,
    toTreeSize: 1,
    rootAtFromTreeSize: ROOT,
    rootAtToTreeSize: ROOT,
    proofNodes: [],
    generatedAtMs: 1,
    ...overrides,
  };
}

describe('verification evidence acquisition outcomes', () => {
  it('evaluates an admitted consistency proof without a provider callback', async () => {
    const checks = await evaluateChecks(consistencyContext(admitted(admittedConsistencyProof())), [
      'recorded_consistency_proof',
    ]);

    expect(checks.get('recorded_consistency_proof')?.status).toBe('success');
  });

  it.each([
    ['unavailable', 'not_run'],
    ['malformed', 'failed'],
    ['transport_failed', 'failed'],
  ] as const)('maps %s consistency evidence to %s', async (kind, expectedStatus) => {
    const checks = await evaluateChecks(consistencyContext({ kind }), ['recorded_consistency_proof']);

    expect(checks.get('recorded_consistency_proof')?.status).toBe(expectedStatus);
  });

  it('rejects admitted consistency evidence for a different tree-size range', async () => {
    const checks = await evaluateChecks(consistencyContext(admitted(admittedConsistencyProof({ fromTreeSize: 2 }))), [
      'recorded_consistency_proof',
    ]);

    expect(checks.get('recorded_consistency_proof')?.status).toBe('failed');
  });

  it('evaluates admitted bitmap evidence without a provider callback', async () => {
    const bitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(bitmap);
    const context: VerificationEvaluationInput = {
      verifierOutcome: { status: 'success' },
      bitmapProofSource: 'real',
      treeSize: 1,
      includedBitmapRoot,
      includedBitmapProof: admitted(generateBitmapMerkleProof(bitmap, 0)),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: `0x${'2'.repeat(64)}`,
        bulletinIndex: 0,
        bulletinRootAtCast: ROOT,
        timestamp: 1,
      },
    };

    const checks = await evaluateChecks(context, ['counted_my_vote_included']);

    expect(checks.get('counted_my_vote_included')?.status).toBe('success');
  });

  it.each(['unavailable', 'malformed', 'transport_failed'] as const)(
    'keeps %s bitmap evidence not_run and therefore fail-closed',
    async (kind) => {
      const context: VerificationEvaluationInput = {
        verifierOutcome: { status: 'success' },
        bitmapProofSource: 'real',
        treeSize: 1,
        includedBitmapRoot: computeIncludedBitmapRoot([true]),
        includedBitmapProof: { kind },
        voteReceipt: {
          voteId: 'vote-1',
          commitment: `0x${'2'.repeat(64)}`,
          bulletinIndex: 0,
          bulletinRootAtCast: ROOT,
          timestamp: 1,
        },
      };

      const checks = await evaluateChecks(context, ['counted_my_vote_included']);

      expect(checks.get('counted_my_vote_included')?.status).toBe('not_run');
    },
  );
});
