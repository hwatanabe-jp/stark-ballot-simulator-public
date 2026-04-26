import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCommitment, CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import type { VerificationStepId } from '@/lib/knowledge';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import {
  VERIFICATION_CHECK_IDS,
  getVerificationRequiredCheckIdsForStep,
  type VerificationCheckId,
} from '@/lib/verification/verification-checks';
import { CHECK_EVALUATORS, evaluateAllChecks } from './evaluate-checks';
import { deriveStepStatusFromChecks } from './derive-stages';
import { buildVerificationSteps } from '../build-verification-steps';
import type { BuildVerificationStepsInput } from '../build-verification-steps';
import type { CheckResult, VerificationContext } from './types';

vi.mock('@/lib/verification/merkle', () => ({
  verifyCTMerkleInclusion: vi.fn(),
}));

vi.mock('@/lib/verification/bitmap-verifier', () => ({
  explainVoteInclusionStatus: vi.fn(),
  verifyMyVoteWasCounted: vi.fn(),
}));

vi.mock('@/lib/verification/sth-verifier', () => ({
  resolveConfiguredSthSources: vi.fn(),
  resolveConfiguredSthMinMatches: vi.fn(),
  verifySthThirdParty: vi.fn(),
}));

import { verifyCTMerkleInclusion } from '@/lib/verification/merkle';
import { verifyMyVoteWasCounted } from '@/lib/verification/bitmap-verifier';
import {
  resolveConfiguredSthMinMatches,
  resolveConfiguredSthSources,
  verifySthThirdParty,
} from '@/lib/verification/sth-verifier';
import { createTestJournal } from '@/lib/testing/test-helpers';

const createJournal = (overrides: Partial<ZkVMJournal> = {}): ZkVMJournal => ({
  ...createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: 1,
  }),
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: '0x' + '0'.repeat(64),
  bulletinRoot: '0x' + '1'.repeat(64),
  treeSize: 1,
  totalExpected: 1,
  sthDigest: '0x' + '2'.repeat(64),
  verifiedTally: [1, 0, 0, 0, 0],
  totalVotes: 1,
  validVotes: 1,
  invalidVotes: 0,
  seenIndicesCount: 1,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  includedBitmapRoot: '0x' + '3'.repeat(64),
  excludedSlots: 0,
  inputCommitment: '0x' + '4'.repeat(64),
  methodVersion: CURRENT_METHOD_VERSION,
  ...overrides,
});

const REQUIREMENT_CONTEXT = { sthSourcesConfigured: false } as const;

const createStepGuardContext = (stepId: VerificationStepId): VerificationContext => {
  switch (stepId) {
    case 'cast_as_intended':
      return {};
    case 'recorded_as_cast':
      return {
        userVote: {
          proof: {
            treeSize: 1,
          },
        },
      };
    case 'counted_as_recorded':
      return {
        journal: createJournal(),
      };
    case 'stark_verification':
      return {};
  }
};

describe('verification engine contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(true);
    vi.mocked(verifyMyVoteWasCounted).mockResolvedValue({
      valid: true,
      included: true,
      leafIndex: 0,
      bitOffset: 0,
      privacyNotice: 'notice',
    });
    vi.mocked(resolveConfiguredSthSources).mockReturnValue([]);
    vi.mocked(resolveConfiguredSthMinMatches).mockReturnValue(1);
    vi.mocked(verifySthThirdParty).mockResolvedValue({
      verified: true,
      consensus: true,
      sourcesChecked: 1,
      matchingSources: 1,
      errors: [],
    });
  });

  it('defines evaluators for every verification check id', () => {
    const evaluatorIds = Object.keys(CHECK_EVALUATORS).sort();
    const checkIds = [...VERIFICATION_CHECK_IDS].sort();
    expect(evaluatorIds).toEqual(checkIds);
  });

  it('ensures step success implies step checks success', async () => {
    const journal = createJournal();
    const electionId = journal.electionId;
    const random = '0x' + 'a'.repeat(64);
    const commitment = computeCommitment(electionId, 0, random);
    const voteReceipt = {
      voteId: '11111111-1111-4111-8111-111111111111',
      commitment,
      bulletinIndex: 0,
      bulletinRootAtCast: journal.bulletinRoot,
      timestamp: 1700000000000,
    };

    const input: BuildVerificationStepsInput = {
      electionId,
      voteReceipt,
      userVote: {
        vote: 'A',
        random,
        commitment,
        voteId: voteReceipt.voteId,
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [] as string[],
          bulletinRootAtCast: journal.bulletinRoot,
        },
      },
      journal,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      excludedSlots: 0,
      verificationStatus: 'success',
      verificationReportStatus: 'success',
      allowDevModeVerification: true,
      bitmapProofSource: 'mock',
      bitmapProofEndpoint: 'https://example.com/api/bitmap-proof',
      sessionId: 'session-1',
    };

    const [castStep, recordedStep, countedStep, starkStep] = await buildVerificationSteps(input);
    const checks = await evaluateAllChecks(input, { applyZkGate: false });

    const stepResults = {
      cast_as_intended: castStep,
      recorded_as_cast: recordedStep,
      counted_as_recorded: countedStep,
      stark_verification: starkStep,
    };

    for (const [stepId, step] of Object.entries(stepResults)) {
      if (step.status !== 'success') {
        continue;
      }
      const checkIds = getVerificationRequiredCheckIdsForStep(stepId as VerificationStepId, REQUIREMENT_CONTEXT);
      const failing = checkIds.filter((checkId) => checks.get(checkId)?.status !== 'success');
      expect(failing).toEqual([]);
    }
  });

  it.each(['failed', 'pending', 'running', 'not_run'] as const)(
    'never marks a step as success when a required check is %s',
    (blockingStatus) => {
      const stepIds: VerificationStepId[] = [
        'cast_as_intended',
        'recorded_as_cast',
        'counted_as_recorded',
        'stark_verification',
      ];

      for (const stepId of stepIds) {
        const checkIds = getVerificationRequiredCheckIdsForStep(stepId, REQUIREMENT_CONTEXT);
        const guardContext = createStepGuardContext(stepId);

        for (const checkId of checkIds) {
          const checks = new Map<VerificationCheckId, CheckResult>(
            checkIds.map((id) => [id, { status: 'success' as const }]),
          );
          checks.set(checkId, { status: blockingStatus });

          const result = deriveStepStatusFromChecks(stepId, checkIds, checks, guardContext);
          expect(result.status).not.toBe('success');
        }
      }
    },
  );
});
