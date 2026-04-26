import { describe, expect, it } from 'vitest';
import type { FinalizeScenarioData } from '../cli-test-helpers';
import { createTestJournal } from '../test-helpers';
import {
  collectCliVerificationContractErrors,
  isCtProofMissing,
  mergeFetchedVoteProof,
  resolveReceiptPayload,
  resolveTallyResult,
  resolveUserVoteProof,
  resolveVerificationCheckStatuses,
  resolveVerificationStepStatuses,
  shouldFetchVoteProof,
} from '../cli-voting-flow-helpers';
import type { VerificationCheck } from '@/lib/verification/verification-checks';
import type { VerificationStep } from '@/lib/knowledge';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

function buildCheck(id: VerificationCheck['id'], status: VerificationCheck['status']): VerificationCheck {
  return {
    id,
    status,
    evidence: id === 'stark_receipt_verify' ? 'zk' : 'public',
    inputs: ['proofBundleStatus'],
  };
}

function buildStep(id: VerificationStep['id'], status: VerificationStep['status']): VerificationStep {
  return {
    id,
    status,
    inputs: [],
  };
}

describe('cli-voting-flow-helpers', () => {
  it('resolves tally using bulletinRoot fallback', () => {
    const data: FinalizeScenarioData = {
      tally: {
        counts: { A: 1, B: 2 },
        bulletinRoot: '0xbulletin',
        totalVotes: 3,
      },
    };

    const result = resolveTallyResult(data);

    expect(result).not.toBeNull();
    expect(result?.merkleRoot).toBe('0xbulletin');
    expect(result?.totalVotes).toBe(3);
    expect(result?.tamperedCount).toBe(0);
  });

  it('derives totals when tally metadata is absent', () => {
    const data: FinalizeScenarioData = {
      tally: { A: 4, B: 1 },
      merkleRoot: '0xmerkle',
    };

    const result = resolveTallyResult(data);

    expect(result?.totalVotes).toBe(5);
    expect(result?.merkleRoot).toBe('0xmerkle');
  });

  it('extracts receipt payload from proof fields', () => {
    const data: FinalizeScenarioData = {
      proof: {
        receipt: 'receipt-data',
        imageId: '0ximage',
        tamperDetected: true,
      },
    };

    const result = resolveReceiptPayload(data);

    expect(result).toEqual({
      receipt: 'receipt-data',
      imageId: '0ximage',
      tamperDetected: true,
    });
  });

  it('resolves user vote proof fields with proof overrides', () => {
    const data: FinalizeScenarioData = {
      userVote: {
        commitment: '0xcommit',
        merklePath: ['0x01'],
        leafIndex: 1,
        treeSize: 10,
        proof: {
          merklePath: ['0x02'],
          leafIndex: 2,
          treeSize: 12,
          bulletinRootAtCast: '0xroot',
        },
      },
    };

    const result = resolveUserVoteProof(data);

    expect(result).toEqual({
      commitment: '0xcommit',
      merklePath: ['0x01'],
      leafIndex: 1,
      treeSize: 10,
      bulletinRootAtCast: '0xroot',
    });
  });

  it('signals when vote proof should be refetched', () => {
    expect(shouldFetchVoteProof(null, 'vote-id')).toBe(true);
    expect(shouldFetchVoteProof({ merklePath: [] }, 'vote-id')).toBe(true);
    expect(shouldFetchVoteProof({ merklePath: ['0x01'] }, 'vote-id')).toBe(false);
    expect(shouldFetchVoteProof({ merklePath: [] }, undefined)).toBe(false);
  });

  it('merges fetched vote proof with existing values', () => {
    const merged = mergeFetchedVoteProof(
      { commitment: '0xexisting', treeSize: 8 },
      {
        merklePath: ['0x02'],
        leafIndex: 5,
        treeSize: 12,
        bulletinRootAtCast: '0xroot',
      },
      '0xfallback',
    );

    expect(merged).toEqual({
      commitment: '0xexisting',
      merklePath: ['0x02'],
      leafIndex: 5,
      treeSize: 12,
      bulletinRootAtCast: '0xroot',
    });
  });

  it('treats empty CT paths as valid for treeSize <= 1', () => {
    expect(isCtProofMissing({ merklePath: [], treeSize: 1 })).toBe(false);
    expect(isCtProofMissing({ merklePath: [], treeSize: 2 })).toBe(true);
    expect(isCtProofMissing({})).toBe(true);
  });

  it('resolves verification check and step statuses for the current contract', () => {
    const data: FinalizeScenarioData = {
      verificationSteps: [buildStep('counted_as_recorded', 'success'), buildStep('stark_verification', 'success')],
      verificationChecks: [
        buildCheck('counted_expected_vs_tree_size', 'success'),
        buildCheck('counted_election_manifest_consistent', 'success'),
        buildCheck('counted_close_statement_consistent', 'success'),
        buildCheck('stark_receipt_verify', 'success'),
      ],
      journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
    };

    expect(resolveVerificationCheckStatuses(data)).toMatchObject({
      counted_expected_vs_tree_size: 'success',
      counted_election_manifest_consistent: 'success',
      counted_close_statement_consistent: 'success',
      stark_receipt_verify: 'success',
    });
    expect(resolveVerificationStepStatuses(data)).toMatchObject({
      counted_as_recorded: 'success',
      stark_verification: 'success',
    });
    expect(collectCliVerificationContractErrors(data)).toEqual([]);
    expect(data.journal?.methodVersion).toBe(CURRENT_METHOD_VERSION);
  });

  it('flags counted-stage success when manifest consistency fails', () => {
    const data: FinalizeScenarioData = {
      verificationSteps: [buildStep('counted_as_recorded', 'success'), buildStep('stark_verification', 'success')],
      verificationChecks: [
        buildCheck('counted_expected_vs_tree_size', 'success'),
        buildCheck('counted_election_manifest_consistent', 'failed'),
        buildCheck('counted_close_statement_consistent', 'success'),
        buildCheck('stark_receipt_verify', 'success'),
      ],
      journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
    };

    expect(collectCliVerificationContractErrors(data)).toEqual(
      expect.arrayContaining([
        'CLI verification required check counted_election_manifest_consistent was failed',
        'Verification contract mismatch: counted_as_recorded was success while counted_election_manifest_consistent=failed',
      ]),
    );
  });

  it('flags legacy methodVersion in current-contract CLI fixtures', () => {
    const data: FinalizeScenarioData = {
      verificationSteps: [buildStep('counted_as_recorded', 'success'), buildStep('stark_verification', 'success')],
      verificationChecks: [
        buildCheck('counted_expected_vs_tree_size', 'success'),
        buildCheck('counted_election_manifest_consistent', 'success'),
        buildCheck('counted_close_statement_consistent', 'success'),
        buildCheck('stark_receipt_verify', 'success'),
      ],
      journal: {
        ...createTestJournal({ totalExpected: 64, validVotes: 64 }),
        methodVersion: 10,
      },
    };

    expect(collectCliVerificationContractErrors(data)).toContain(
      `CLI verification journal methodVersion 10 does not match current contract ${CURRENT_METHOD_VERSION}`,
    );
  });

  it('flags current count mirrors that disagree with the journal authority', () => {
    const data: FinalizeScenarioData = {
      verificationSteps: [buildStep('counted_as_recorded', 'success'), buildStep('stark_verification', 'success')],
      verificationChecks: [
        buildCheck('counted_expected_vs_tree_size', 'success'),
        buildCheck('counted_election_manifest_consistent', 'success'),
        buildCheck('counted_close_statement_consistent', 'success'),
        buildCheck('stark_receipt_verify', 'success'),
      ],
      journal: createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingSlots: 2,
        invalidPresentedSlots: 1,
        excludedSlots: 3,
      }),
      missingSlots: 0,
      invalidPresentedSlots: 0,
      validVotes: 64,
      excludedSlots: 0,
    };

    expect(collectCliVerificationContractErrors(data)).toEqual(
      expect.arrayContaining([
        'CLI verification count mismatch: missingSlots=0 does not match journal.missingSlots=2',
        'CLI verification count mismatch: invalidPresentedSlots=0 does not match journal.invalidPresentedSlots=1',
        'CLI verification count mismatch: validVotes=64 does not match journal.validVotes=61',
        'CLI verification count mismatch: excludedSlots=0 does not match journal.excludedSlots=3',
      ]),
    );
  });
});
