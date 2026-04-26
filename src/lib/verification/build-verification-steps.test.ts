import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeCommitment, CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { BulletinConsistencyProvider, VerificationPublicInputAuthority } from '@/lib/verification/engine/types';
import { getVerificationStepInputs } from '@/lib/verification/verification-checks';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { buildVerificationSteps } from './build-verification-steps';

vi.mock('./merkle', () => ({
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

import { verifyCTMerkleInclusion } from './merkle';
import { explainVoteInclusionStatus, verifyMyVoteWasCounted } from '@/lib/verification/bitmap-verifier';
import { resolveConfiguredSthSources, verifySthThirdParty } from '@/lib/verification/sth-verifier';
import { createTestJournal } from '@/lib/testing/test-helpers';

const createPublicInputAuthority = (
  overrides: Partial<VerificationPublicInputAuthority> = {},
): VerificationPublicInputAuthority => ({
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: '0x' + '0'.repeat(64),
  votesCount: 1,
  treeSize: 1,
  totalExpected: 1,
  bulletinRoot: '0x' + '1'.repeat(64),
  logId: '0x' + '2'.repeat(64),
  timestamp: 123,
  uniqueIndices: true,
  uniqueCommitments: true,
  recomputedInputCommitment: '0x' + '4'.repeat(64),
  source: 'generated',
  ...overrides,
  methodVersion: overrides.methodVersion ?? CURRENT_METHOD_VERSION,
});

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

describe('buildVerificationSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveConfiguredSthSources).mockReturnValue([]);
    vi.mocked(explainVoteInclusionStatus).mockResolvedValue({
      valid: true,
      included: true,
      leafIndex: 0,
      bitOffset: 0,
      privacyNotice: 'notice',
      statusDetail: 'counted',
    });
    vi.mocked(verifyMyVoteWasCounted).mockResolvedValue({
      valid: true,
      included: true,
      leafIndex: 0,
      bitOffset: 0,
      privacyNotice: 'notice',
    });
  });

  it('returns steps in fixed order with inputs and success statuses when data is valid', async () => {
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(true);

    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const electionManifest = buildElectionManifest(electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: 1,
      timestamp: 123,
      bulletinRoot: '0x' + '1'.repeat(64),
    });
    const journal = createJournal({
      electionId,
      electionConfigHash: electionManifest.electionConfigHash,
      bulletinRoot: closeStatement.bulletinRoot,
      sthDigest: closeStatement.sthDigest,
    });
    const random = '0x' + 'a'.repeat(64);
    const commitment = computeCommitment(electionId, 0, random);
    const voteReceipt = {
      voteId: '11111111-1111-4111-8111-111111111111',
      commitment,
      bulletinIndex: 0,
      bulletinRootAtCast: journal.bulletinRoot,
      timestamp: 1700000000000,
    };
    const bulletin: BulletinConsistencyProvider = {
      getConsistencyProof: () => ({
        oldSize: 1,
        newSize: journal.treeSize,
        proofNodes: [],
      }),
      getRootAtSize: () => journal.bulletinRoot,
      getSize: () => journal.treeSize,
      verifyConsistency: () => true,
    };

    const steps = await buildVerificationSteps({
      castSource: 'server',
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
          merklePath: [],
          bulletinRootAtCast: journal.bulletinRoot,
        },
      },
      journal,
      electionConfigHash: electionManifest.electionConfigHash,
      logId: closeStatement.logId,
      electionManifest,
      closeStatement,
      publicInputAuthority: createPublicInputAuthority({
        electionId,
        electionConfigHash: electionManifest.electionConfigHash,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        logId: closeStatement.logId,
        timestamp: closeStatement.timestamp,
        recomputedInputCommitment: journal.inputCommitment,
      }),
      bitmapProofSource: 'mock',
      bulletin,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      inputCommitment: journal.inputCommitment,
      includedBitmapRoot: journal.includedBitmapRoot,
      verificationStatus: 'success',
      verificationReportStatus: 'success',
    });

    expect(steps.map((step) => step.id)).toEqual([
      'cast_as_intended',
      'recorded_as_cast',
      'counted_as_recorded',
      'stark_verification',
    ]);

    expect(steps.map((step) => step.inputs)).toEqual([
      getVerificationStepInputs('cast_as_intended'),
      getVerificationStepInputs('recorded_as_cast'),
      getVerificationStepInputs('counted_as_recorded'),
      getVerificationStepInputs('stark_verification'),
    ]);

    expect(steps.map((step) => step.status)).toEqual(['success', 'success', 'success', 'success']);
  });

  it('marks cast_as_intended failed when commitment mismatches', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const random = '0x' + 'b'.repeat(64);
    const commitment = computeCommitment(electionId, 0, random);
    const steps = await buildVerificationSteps({
      castSource: 'server',
      electionId,
      voteReceipt: {
        voteId: '11111111-1111-4111-8111-111111111111',
        commitment: '0x' + '9'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1700000000000,
      },
      userVote: {
        vote: 'A',
        random,
        commitment,
        voteId: '11111111-1111-4111-8111-111111111111',
      },
    });

    const cast = steps.find((step) => step.id === 'cast_as_intended');
    expect(cast?.status).toBe('failed');
  });

  it('marks recorded_as_cast failed when inclusion proof fails', async () => {
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(false);

    const steps = await buildVerificationSteps({
      voteReceipt: {
        voteId: '11111111-1111-4111-8111-111111111111',
        commitment: '0x' + '2'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '3'.repeat(64),
        timestamp: 1700000000000,
      },
      userVote: {
        vote: 'A',
        random: '0x' + '1'.repeat(64),
        commitment: '0x' + '2'.repeat(64),
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: '0x' + '3'.repeat(64),
        },
      },
    });

    const recorded = steps.find((step) => step.id === 'recorded_as_cast');
    expect(recorded?.status).toBe('failed');
  });

  it('marks recorded_as_cast failed when required consistency proof fails', async () => {
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(true);

    const journal = createJournal({
      treeSize: 2,
      totalExpected: 2,
      bulletinRoot: '0x' + '4'.repeat(64),
      verifiedTally: [2, 0, 0, 0, 0],
      totalVotes: 2,
      validVotes: 2,
      seenIndicesCount: 2,
    });
    const electionId = journal.electionId;
    const random = '0x' + 'c'.repeat(64);
    const commitment = computeCommitment(electionId, 0, random);
    const voteReceipt = {
      voteId: '11111111-1111-4111-8111-111111111111',
      commitment,
      bulletinIndex: 0,
      bulletinRootAtCast: '0x' + '5'.repeat(64),
      timestamp: 1700000000000,
    };
    const bulletin: BulletinConsistencyProvider = {
      getConsistencyProof: () => ({
        oldSize: 1,
        newSize: 2,
        proofNodes: [],
      }),
      getRootAtSize: (size) => (size === 1 ? '0x' + '6'.repeat(64) : journal.bulletinRoot),
      getSize: () => 2,
      verifyConsistency: () => true,
    };

    const steps = await buildVerificationSteps({
      castSource: 'server',
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
          merklePath: [],
          bulletinRootAtCast: voteReceipt.bulletinRootAtCast,
        },
      },
      journal,
      bulletin,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      verificationStatus: 'success',
      verificationReportStatus: 'success',
    });

    const recorded = steps.find((step) => step.id === 'recorded_as_cast');
    expect(recorded?.status).toBe('failed');
    expect(recorded?.error).toContain('Root mismatch');
  });

  it('returns recorded_as_cast not_run when treeSize is missing', async () => {
    const steps = await buildVerificationSteps({
      userVote: {
        vote: 'A',
        random: '0x' + '1'.repeat(64),
        commitment: '0x' + '2'.repeat(64),
        proof: {
          leafIndex: 0,
          merklePath: [],
          bulletinRootAtCast: '0x' + '3'.repeat(64),
        },
      },
    });

    const recorded = steps.find((step) => step.id === 'recorded_as_cast');
    expect(recorded?.status).toBe('not_run');
  });

  it('treats dev_mode as success when allowDevModeVerification is true', async () => {
    const steps = await buildVerificationSteps({
      verificationStatus: 'dev_mode',
      allowDevModeVerification: true,
    });

    const stark = steps.find((step) => step.id === 'stark_verification');
    expect(stark?.status).toBe('success');
  });

  it('marks counted_as_recorded failed when excluded votes are present', async () => {
    const steps = await buildVerificationSteps({
      verificationStatus: 'success',
      missingSlots: 1,
      invalidPresentedSlots: 0,
    });

    const counted = steps.find((step) => step.id === 'counted_as_recorded');
    expect(counted?.status).toBe('failed');
    expect(counted?.error).toContain('excludedSlots=1');

    const cast = steps.find((step) => step.id === 'cast_as_intended');
    expect(cast?.status).toBe('not_run');
  });

  it('marks counted_as_recorded failed when a required input-commitment check fails', async () => {
    const journal = createJournal();

    const steps = await buildVerificationSteps({
      verificationStatus: 'success',
      journal,
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      verifiedTally: [1, 0, 0, 0, 0],
      missingSlots: 0,
      invalidPresentedSlots: 0,
      excludedSlots: 0,
      inputCommitment: journal.inputCommitment,
      publicInputAuthority: createPublicInputAuthority({
        votesCount: 1,
        treeSize: 1,
        totalExpected: 1,
        bulletinRoot: journal.bulletinRoot,
        recomputedInputCommitment: '0x' + '9'.repeat(64),
      }),
    });

    const counted = steps.find((step) => step.id === 'counted_as_recorded');
    expect(counted?.status).toBe('failed');
  });

  it('returns counted_as_recorded not_run when journal is missing', async () => {
    const steps = await buildVerificationSteps({
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      verifiedTally: [1, 0, 0, 0, 0],
      missingSlots: 0,
      invalidPresentedSlots: 0,
    });

    const counted = steps.find((step) => step.id === 'counted_as_recorded');
    expect(counted?.status).toBe('not_run');
  });

  it('reuses provided check results without re-running STH verification', async () => {
    vi.mocked(resolveConfiguredSthSources).mockReturnValue(['https://example.com/sth']);

    const steps = await buildVerificationSteps({
      castSource: 'client',
      userVote: {
        proof: {
          treeSize: 1,
        },
      },
      checkResults: new Map([
        ['recorded_index_in_range', { status: 'success' as const }],
        ['recorded_inclusion_proof', { status: 'success' as const }],
        ['recorded_consistency_proof', { status: 'success' as const }],
        ['recorded_sth_third_party', { status: 'success' as const }],
      ]),
    });

    const recorded = steps.find((step) => step.id === 'recorded_as_cast');
    expect(recorded?.status).toBe('success');
    expect(vi.mocked(verifySthThirdParty)).not.toHaveBeenCalled();
  });

  it('prefers verificationStatus running over report status for stark_verification', async () => {
    const steps = await buildVerificationSteps({
      verificationStatus: 'running',
      verificationReportStatus: 'success',
    });

    const stark = steps.find((step) => step.id === 'stark_verification');
    expect(stark?.status).toBe('running');
  });

  it('marks counted_as_recorded pending while STARK verification is running', async () => {
    const steps = await buildVerificationSteps({
      verificationStatus: 'running',
      journal: createJournal(),
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      verifiedTally: [1, 0, 0, 0, 0],
    });

    const counted = steps.find((step) => step.id === 'counted_as_recorded');
    expect(counted?.status).toBe('pending');
  });

  it('marks stark_verification failed when image ID check fails even if receipt verification succeeded', async () => {
    const steps = await buildVerificationSteps({
      verificationStatus: 'success',
      verificationReportStatus: 'success',
      verificationReport: {
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '2'.repeat(64),
      },
    });

    const stark = steps.find((step) => step.id === 'stark_verification');
    expect(stark?.status).toBe('failed');
  });

  it('forces cast_as_intended to not_run when castSource is client', async () => {
    const steps = await buildVerificationSteps({
      castSource: 'client',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '9'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1700000000000,
      },
      userVote: {
        vote: 'A',
        random: '0x' + 'b'.repeat(64),
        commitment: '0x' + '8'.repeat(64),
      },
    });

    const cast = steps.find((step) => step.id === 'cast_as_intended');
    expect(cast?.status).toBe('not_run');
  });

  it('defaults cast_as_intended to not_run when castSource is omitted', async () => {
    const steps = await buildVerificationSteps({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '9'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1700000000000,
      },
      userVote: {
        vote: 'A',
        random: '0x' + 'b'.repeat(64),
        commitment: '0x' + '8'.repeat(64),
      },
    });

    const cast = steps.find((step) => step.id === 'cast_as_intended');
    expect(cast?.status).toBe('not_run');
  });
});
