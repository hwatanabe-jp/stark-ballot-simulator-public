import { describe, expect, it } from 'vitest';
import type { FinalizeScenarioData } from '../cli-test-helpers';
import { buildCliVerificationPresentationFixture } from '../cli-verification-fixtures';
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
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { VERIFICATION_CHECK_DEFINITIONS, type VerificationCheck } from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';

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
      ...buildCliVerificationPresentationFixture({
        steps: [
          { id: 'counted_as_recorded', status: 'success' },
          { id: 'stark_verification', status: 'success' },
        ],
        checks: [
          { id: 'counted_expected_vs_tree_size', status: 'success' },
          { id: 'counted_election_manifest_consistent', status: 'success' },
          { id: 'counted_close_statement_consistent', status: 'success' },
          { id: 'stark_receipt_verify', status: 'success' },
        ],
      }),
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

  it.each(['counted_my_vote_included', 'counted_input_commitment_match', 'stark_image_id_match'] as const)(
    'rejects a CLI payload that omits canonical required check %s',
    (missingCheckId) => {
      const data: FinalizeScenarioData = {
        ...buildCliVerificationPresentationFixture({
          steps: [
            { id: 'counted_as_recorded', status: 'success' },
            { id: 'stark_verification', status: 'success' },
          ],
          checks: [
            { id: 'counted_expected_vs_tree_size', status: 'success' },
            { id: 'counted_election_manifest_consistent', status: 'success' },
            { id: 'counted_close_statement_consistent', status: 'success' },
            { id: 'stark_receipt_verify', status: 'success' },
          ],
        }),
        journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
      };
      if (!data.verificationChecks) {
        throw new Error('Expected the CLI fixture to include verification checks');
      }
      data.verificationChecks = data.verificationChecks.filter((check) => check.id !== missingCheckId);

      expect(collectCliVerificationContractErrors(data)).toContain(
        `CLI verification payload missing required check ${missingCheckId}`,
      );
    },
  );

  it('prefers shared-policy stage statuses over stale flat step statuses', () => {
    const checks = VERIFICATION_CHECK_DEFINITIONS.map((definition): VerificationCheck => ({
      id: definition.id,
      status: definition.id === 'counted_election_manifest_consistent' ? 'failed' : 'success',
      evidence: definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    }));
    const presentationPolicy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks,
      context: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        sthSourcesConfigured: false,
      },
      verificationStatus: 'success',
      verificationReportStatus: 'success',
    });
    const data: FinalizeScenarioData = {
      verificationChecks: checks,
      verificationSteps: [
        { id: 'counted_as_recorded', status: 'success' },
        { id: 'stark_verification', status: 'success' },
      ],
      presentationPolicy,
    };

    expect(resolveVerificationStepStatuses(data)).toMatchObject({
      counted_as_recorded: 'failed',
      stark_verification: 'success',
    });
  });

  it('does not admit flat verification step statuses without the shared presentation policy', () => {
    const data: FinalizeScenarioData = {
      verificationSteps: [
        { id: 'counted_as_recorded', status: 'success' },
        { id: 'stark_verification', status: 'success' },
      ],
    };

    expect(resolveVerificationStepStatuses(data)).toEqual({});
    expect(collectCliVerificationContractErrors(data)).toEqual(
      expect.arrayContaining([
        'CLI verification payload missing required step counted_as_recorded',
        'CLI verification payload missing required step stark_verification',
      ]),
    );
  });

  it('derives counted-stage failure when manifest consistency fails', () => {
    const data: FinalizeScenarioData = {
      ...buildCliVerificationPresentationFixture({
        steps: [
          { id: 'counted_as_recorded', status: 'success' },
          { id: 'stark_verification', status: 'success' },
        ],
        checks: [
          { id: 'counted_expected_vs_tree_size', status: 'success' },
          { id: 'counted_election_manifest_consistent', status: 'failed' },
          { id: 'counted_close_statement_consistent', status: 'success' },
          { id: 'stark_receipt_verify', status: 'success' },
        ],
      }),
      journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
    };

    expect(data.presentationPolicy?.stageStatuses.counted_as_recorded).toBe('failed');
    expect(collectCliVerificationContractErrors(data)).toEqual([
      'CLI verification required check counted_election_manifest_consistent was failed',
    ]);
  });

  it('allows fail-closed scenarios to leave downstream required checks not run', () => {
    const data: FinalizeScenarioData = {
      ...buildCliVerificationPresentationFixture({
        steps: [
          { id: 'counted_as_recorded', status: 'failed' },
          { id: 'stark_verification', status: 'not_run' },
        ],
        checks: [
          { id: 'counted_expected_vs_tree_size', status: 'failed' },
          { id: 'counted_election_manifest_consistent', status: 'not_run' },
          { id: 'counted_close_statement_consistent', status: 'not_run' },
          { id: 'stark_receipt_verify', status: 'not_run' },
        ],
      }),
      journal: createTestJournal({ totalExpected: 64, validVotes: 63, excludedSlots: 1 }),
    };

    expect(collectCliVerificationContractErrors(data, { requireRequiredChecksSuccess: false })).toEqual([]);
  });

  it('flags legacy methodVersion in current-contract CLI fixtures', () => {
    const data: FinalizeScenarioData = {
      ...buildCliVerificationPresentationFixture({
        steps: [
          { id: 'counted_as_recorded', status: 'success' },
          { id: 'stark_verification', status: 'success' },
        ],
        checks: [
          { id: 'counted_expected_vs_tree_size', status: 'success' },
          { id: 'counted_election_manifest_consistent', status: 'success' },
          { id: 'counted_close_statement_consistent', status: 'success' },
          { id: 'stark_receipt_verify', status: 'success' },
        ],
      }),
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
      ...buildCliVerificationPresentationFixture({
        steps: [
          { id: 'counted_as_recorded', status: 'success' },
          { id: 'stark_verification', status: 'success' },
        ],
        checks: [
          { id: 'counted_expected_vs_tree_size', status: 'success' },
          { id: 'counted_election_manifest_consistent', status: 'success' },
          { id: 'counted_close_statement_consistent', status: 'success' },
          { id: 'stark_receipt_verify', status: 'success' },
        ],
      }),
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
