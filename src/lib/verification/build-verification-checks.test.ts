import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationCheckId } from '@/lib/verification/verification-checks';
import { buildVerificationChecks } from './build-verification-checks';

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
import {
  resolveConfiguredSthMinMatches,
  resolveConfiguredSthSources,
  verifySthThirdParty,
} from '@/lib/verification/sth-verifier';
import type { BulletinConsistencyProvider, VerificationPublicInputAuthority } from '@/lib/verification/engine/types';
import { explainVoteInclusionStatus, verifyMyVoteWasCounted } from '@/lib/verification/bitmap-verifier';
import { CURRENT_METHOD_VERSION, type ZkVMJournal } from '@/lib/zkvm/types';
import type { VoteReceipt } from '@/types/receipt';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { createTestJournal } from '@/lib/testing/test-helpers';

const createPublicInputAuthority = (
  overrides: Partial<VerificationPublicInputAuthority> = {},
): VerificationPublicInputAuthority => ({
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: '0x' + '1'.repeat(64),
  votesCount: 1,
  treeSize: 1,
  totalExpected: 1,
  bulletinRoot: '0x' + '1'.repeat(64),
  logId: '0x' + '2'.repeat(64),
  timestamp: 123,
  uniqueIndices: true,
  uniqueCommitments: true,
  recomputedInputCommitment: '0x' + 'a'.repeat(64),
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
  electionConfigHash: '0x' + '1'.repeat(64),
  bulletinRoot: '0x' + '2'.repeat(64),
  treeSize: 1,
  totalExpected: 1,
  sthDigest: '0x' + '3'.repeat(64),
  verifiedTally: [1, 0, 0, 0, 0],
  totalVotes: 1,
  validVotes: 1,
  invalidVotes: 0,
  seenIndicesCount: 1,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  includedBitmapRoot: '0x' + '4'.repeat(64),
  excludedSlots: 0,
  inputCommitment: '0x' + 'a'.repeat(64),
  methodVersion: CURRENT_METHOD_VERSION,
  ...overrides,
});

const findStatus = (checks: Array<{ id: VerificationCheckId; status: string }>, id: VerificationCheckId) =>
  checks.find((check) => check.id === id)?.status;

describe('buildVerificationChecks', () => {
  const defaultElectionConfig = buildDefaultElectionConfig();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_STH_SOURCES;
    vi.mocked(resolveConfiguredSthSources).mockReturnValue([]);
    vi.mocked(resolveConfiguredSthMinMatches).mockReturnValue(2);
    vi.mocked(verifySthThirdParty).mockResolvedValue({
      verified: false,
      consensus: false,
      sourcesChecked: 0,
      matchingSources: 0,
      errors: [],
    });
  });

  it('marks cast_choice_range failed when vote choice is invalid', async () => {
    const checks = await buildVerificationChecks({
      castSource: 'server',
      userVote: {
        vote: 'Z' as never,
      },
    });

    expect(findStatus(checks, 'cast_choice_range')).toBe('failed');
  });

  it('defaults cast checks to not_run when castSource is omitted', async () => {
    const checks = await buildVerificationChecks({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '1'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
      },
      userVote: {
        vote: 'A',
        random: '0x' + '3'.repeat(64),
      },
    });

    expect(findStatus(checks, 'cast_receipt_present')).toBe('not_run');
    expect(findStatus(checks, 'cast_choice_range')).toBe('not_run');
    expect(findStatus(checks, 'cast_random_format')).toBe('not_run');
    expect(findStatus(checks, 'cast_commitment_match')).toBe('not_run');
  });

  it('marks recorded_inclusion_proof failed when inclusion verification fails', async () => {
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(false);

    const checks = await buildVerificationChecks({
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '2'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '4'.repeat(64),
        timestamp: Date.now(),
      },
      userVote: {
        vote: 'A',
        random: '0x' + '1'.repeat(64),
        commitment: '0x' + '2'.repeat(64),
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: ['0x' + '3'.repeat(64)],
          bulletinRootAtCast: '0x' + '4'.repeat(64),
        },
      },
    });

    expect(findStatus(checks, 'recorded_inclusion_proof')).toBe('failed');
    expect(findStatus(checks, 'recorded_commitment_in_bulletin')).toBe('failed');
  });

  it('fails counted_missing_indices_zero when excluded votes are present', async () => {
    const checks = await buildVerificationChecks({
      missingSlots: 1,
      invalidPresentedSlots: 0,
      verificationStatus: 'success',
    });

    expect(findStatus(checks, 'counted_missing_indices_zero')).toBe('failed');
  });

  it('fails counted_missing_indices_zero when only current slot counts are provided', async () => {
    const checks = await buildVerificationChecks({
      missingSlots: 1,
      invalidPresentedSlots: 0,
      excludedSlots: 1,
      verificationStatus: 'success',
    });

    expect(findStatus(checks, 'counted_missing_indices_zero')).toBe('failed');
  });

  it('fails counted_missing_indices_zero when journal counts are invalid', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      journal: createJournal({
        missingSlots: Number.NaN,
      }),
    });

    expect(findStatus(checks, 'counted_missing_indices_zero')).toBe('failed');
  });

  it('uses journal tally when tally inputs are missing', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      journal: createJournal(),
    });

    expect(findStatus(checks, 'counted_tally_consistent')).toBe('success');
  });

  it('sets STARK checks to running when verificationStatus is running', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'running',
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      verifiedTally: [1, 0, 0, 0, 0],
    });

    expect(findStatus(checks, 'stark_image_id_match')).toBe('running');
    expect(findStatus(checks, 'stark_receipt_verify')).toBe('running');
    expect(findStatus(checks, 'counted_tally_consistent')).toBe('pending');
  });

  it('uses fallback STH inputs when journal is missing', async () => {
    vi.mocked(resolveConfiguredSthSources).mockReturnValue(['https://example.com/sth']);
    vi.mocked(resolveConfiguredSthMinMatches).mockReturnValue(1);
    vi.mocked(verifySthThirdParty).mockResolvedValue({
      verified: true,
      consensus: true,
      sourcesChecked: 1,
      matchingSources: 1,
      errors: [],
    });

    const checks = await buildVerificationChecks({
      sthDigest: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + 'b'.repeat(64),
      treeSize: 64,
      sessionId: 'session-1',
    });

    expect(findStatus(checks, 'recorded_sth_third_party')).toBe('success');
    expect(vi.mocked(verifySthThirdParty)).toHaveBeenCalledWith(
      {
        sthDigest: '0x' + 'a'.repeat(64),
        bulletinRoot: '0x' + 'b'.repeat(64),
        treeSize: 64,
      },
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('resolves relative STH sources against base URL', async () => {
    vi.mocked(resolveConfiguredSthSources).mockReturnValue(['/api/sth']);
    vi.mocked(resolveConfiguredSthMinMatches).mockReturnValue(1);
    vi.mocked(verifySthThirdParty).mockResolvedValue({
      verified: true,
      consensus: true,
      sourcesChecked: 1,
      matchingSources: 1,
      errors: [],
    });

    await buildVerificationChecks({
      sthDigest: '0x' + 'e'.repeat(64),
      bulletinRoot: '0x' + 'd'.repeat(64),
      treeSize: 64,
      sessionId: 'session-1',
      sthBaseUrl: 'https://api.example.com',
    });

    expect(vi.mocked(verifySthThirdParty)).toHaveBeenCalledWith(
      {
        sthDigest: '0x' + 'e'.repeat(64),
        bulletinRoot: '0x' + 'd'.repeat(64),
        treeSize: 64,
      },
      expect.objectContaining({
        sessionId: 'session-1',
        sources: ['https://api.example.com/api/sth'],
      }),
    );
  });

  it('forwards same-origin session auth headers to STH verification', async () => {
    vi.mocked(resolveConfiguredSthSources).mockReturnValue(['/api/sth']);
    vi.mocked(resolveConfiguredSthMinMatches).mockReturnValue(1);
    vi.mocked(verifySthThirdParty).mockResolvedValue({
      verified: true,
      consensus: true,
      sourcesChecked: 1,
      matchingSources: 1,
      errors: [],
    });

    await buildVerificationChecks({
      sthDigest: '0x' + 'c'.repeat(64),
      bulletinRoot: '0x' + 'd'.repeat(64),
      treeSize: 64,
      sessionId: 'session-1',
      sthBaseUrl: 'https://api.example.com',
      sessionAuthHeaders: {
        'X-Session-ID': 'session-1',
        'X-Session-Capability': 'capability-token',
      },
    });

    expect(vi.mocked(verifySthThirdParty)).toHaveBeenCalledWith(
      {
        sthDigest: '0x' + 'c'.repeat(64),
        bulletinRoot: '0x' + 'd'.repeat(64),
        treeSize: 64,
      },
      expect.objectContaining({
        sameOriginOrigin: 'https://api.example.com',
        sameOriginHeaders: {
          'X-Session-ID': 'session-1',
          'X-Session-Capability': 'capability-token',
        },
      }),
    );
  });

  it('adds a note when excluded votes block bitmap verification', async () => {
    const voteReceipt: VoteReceipt = {
      voteId: 'vote-1',
      commitment: '0x' + '1'.repeat(64),
      bulletinIndex: 0,
      bulletinRootAtCast: '0x' + '2'.repeat(64),
      timestamp: 1700000000,
    };

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      excludedSlots: 1,
      includedBitmapRoot: '0x' + '4'.repeat(64),
      voteReceipt,
    });

    const check = checks.find((entry) => entry.id === 'counted_my_vote_included');
    expect(check?.status).toBe('not_run');
    expect(check?.noteKey).toBe('pages.verify.stepsCard.notes.myVoteIncluded.excluded');
  });

  it('keeps recorded consistency checks not_run when CT proof treeSize is missing', async () => {
    const bulletinRootAtCast = '0x' + '1'.repeat(64);
    const bulletinRootFinal = '0x' + '2'.repeat(64);
    const bulletinIndex = 0;
    const treeSize = 3;

    const bulletin: BulletinConsistencyProvider = {
      getConsistencyProof: (oldSize: number, newSize: number) => ({
        oldSize,
        newSize,
        proofNodes: [],
      }),
      getRootAtSize: (size: number) => {
        if (size === bulletinIndex + 1) {
          return bulletinRootAtCast;
        }
        if (size === treeSize) {
          return bulletinRootFinal;
        }
        return '0x' + 'f'.repeat(64);
      },
      getSize: () => treeSize,
      verifyConsistency: () => true,
    };

    const checks = await buildVerificationChecks({
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '3'.repeat(64),
        bulletinIndex,
        bulletinRootAtCast,
        timestamp: Date.now(),
      },
      userVote: {
        commitment: '0x' + '3'.repeat(64),
        proof: {
          leafIndex: bulletinIndex,
          merklePath: ['0x' + '4'.repeat(64)],
          bulletinRootAtCast,
        },
      },
      bulletinRoot: bulletinRootFinal,
      treeSize,
      bulletin,
    });

    expect(findStatus(checks, 'recorded_consistency_proof')).toBe('not_run');
    expect(findStatus(checks, 'recorded_root_at_cast_consistent')).toBe('not_run');
  });

  it('fails recorded-as-cast checks when proof binding drifts from the receipt', async () => {
    const bulletinRootAtCast = '0x' + '1'.repeat(64);
    const bulletinRootFinal = '0x' + '2'.repeat(64);
    const bulletin: BulletinConsistencyProvider = {
      getConsistencyProof: () => ({
        oldSize: 1,
        newSize: 2,
        proofNodes: [],
      }),
      getRootAtSize: (size: number) => (size === 1 ? bulletinRootAtCast : bulletinRootFinal),
      getSize: () => 2,
      verifyConsistency: () => true,
    };

    const checks = await buildVerificationChecks({
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '3'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast,
        timestamp: Date.now(),
      },
      userVote: {
        commitment: '0x' + '3'.repeat(64),
        proof: {
          leafIndex: 1,
          treeSize: 2,
          merklePath: ['0x' + '4'.repeat(64)],
          bulletinRootAtCast,
        },
      },
      bulletinRoot: bulletinRootFinal,
      treeSize: 2,
      bulletin,
    });

    expect(findStatus(checks, 'recorded_inclusion_proof')).toBe('failed');
    expect(findStatus(checks, 'recorded_consistency_proof')).toBe('failed');
  });

  it('resolves public input summary checks from summary data', async () => {
    const summary = createPublicInputAuthority({
      votesCount: 2,
      treeSize: 2,
      uniqueIndices: false,
      uniqueCommitments: true,
    });

    const checks = await buildVerificationChecks({
      publicInputAuthority: summary,
    });

    expect(findStatus(checks, 'counted_input_sanity')).toBe('success');
    expect(findStatus(checks, 'counted_unique_indices')).toBe('failed');
    expect(findStatus(checks, 'counted_unique_commitments')).toBe('success');
  });

  it('matches input commitment against journal when STARK succeeds', async () => {
    const summary = createPublicInputAuthority({
      recomputedInputCommitment: '0x' + 'b'.repeat(64),
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      publicInputAuthority: summary,
      journal: createJournal({
        inputCommitment: '0x' + 'b'.repeat(64),
      }),
    });

    expect(findStatus(checks, 'counted_input_commitment_match')).toBe('success');
  });

  it('matches input commitment without journal when provided in input', async () => {
    const summary = createPublicInputAuthority({
      recomputedInputCommitment: '0x' + 'c'.repeat(64),
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      publicInputAuthority: summary,
      inputCommitment: '0x' + 'c'.repeat(64),
    });

    expect(findStatus(checks, 'counted_input_commitment_match')).toBe('success');
  });

  it('verifies election manifest and close statement bindings when public artifacts match', async () => {
    const electionManifest = buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', defaultElectionConfig);
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: 1,
      timestamp: 123,
      bulletinRoot: '0x' + '2'.repeat(64),
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      electionId: electionManifest.electionId,
      electionConfigHash: electionManifest.electionConfigHash,
      logId: closeStatement.logId,
      journal: createJournal({
        electionConfigHash: electionManifest.electionConfigHash,
        treeSize: closeStatement.treeSize,
        bulletinRoot: closeStatement.bulletinRoot,
        sthDigest: closeStatement.sthDigest,
      }),
      publicInputAuthority: createPublicInputAuthority({
        electionId: electionManifest.electionId,
        electionConfigHash: electionManifest.electionConfigHash,
        treeSize: closeStatement.treeSize,
        bulletinRoot: closeStatement.bulletinRoot,
        logId: closeStatement.logId,
        timestamp: closeStatement.timestamp,
      }),
      electionManifest,
      closeStatement,
    });

    expect(findStatus(checks, 'counted_election_manifest_consistent')).toBe('success');
    expect(findStatus(checks, 'counted_close_statement_consistent')).toBe('success');
  });

  it('keeps public binding checks not_run when public audit artifacts are missing', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      logId: '0x' + '2'.repeat(64),
      journal: createJournal(),
      publicInputAuthority: createPublicInputAuthority(),
    });

    expect(findStatus(checks, 'counted_election_manifest_consistent')).toBe('not_run');
    expect(findStatus(checks, 'counted_close_statement_consistent')).toBe('not_run');
  });

  it('fails public binding checks when manifest or close statement drift from journal', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      logId: '0x' + '2'.repeat(64),
      journal: createJournal(),
      publicInputAuthority: createPublicInputAuthority(),
      electionManifest: {
        ...buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', defaultElectionConfig),
        electionConfigHash: '0x' + '9'.repeat(64),
      },
      closeStatement: {
        ...buildCloseStatement({
          logId: '0x' + '2'.repeat(64),
          treeSize: 1,
          timestamp: 123,
          bulletinRoot: '0x' + '2'.repeat(64),
        }),
        bulletinRoot: '0x' + 'f'.repeat(64),
      },
    });

    expect(findStatus(checks, 'counted_election_manifest_consistent')).toBe('failed');
    expect(findStatus(checks, 'counted_close_statement_consistent')).toBe('failed');
  });

  it('fails close statement binding when timestamp drifts from public input', async () => {
    const electionManifest = buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', defaultElectionConfig);
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: 1,
      timestamp: 123,
      bulletinRoot: '0x' + '2'.repeat(64),
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      electionId: electionManifest.electionId,
      electionConfigHash: electionManifest.electionConfigHash,
      logId: closeStatement.logId,
      journal: createJournal({
        electionConfigHash: electionManifest.electionConfigHash,
        treeSize: closeStatement.treeSize,
        bulletinRoot: closeStatement.bulletinRoot,
        sthDigest: closeStatement.sthDigest,
      }),
      publicInputAuthority: createPublicInputAuthority({
        electionId: electionManifest.electionId,
        electionConfigHash: electionManifest.electionConfigHash,
        treeSize: closeStatement.treeSize,
        bulletinRoot: closeStatement.bulletinRoot,
        logId: closeStatement.logId,
        timestamp: 999,
      }),
      electionManifest,
      closeStatement,
    });

    expect(findStatus(checks, 'counted_close_statement_consistent')).toBe('failed');
  });

  it('returns failed for all ZK checks when STARK fails', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'failed',
      publicInputAuthority: createPublicInputAuthority(),
      journal: createJournal(),
    });

    expect(findStatus(checks, 'counted_tally_consistent')).toBe('failed');
    expect(findStatus(checks, 'counted_missing_indices_zero')).toBe('failed');
    expect(findStatus(checks, 'counted_expected_vs_tree_size')).toBe('failed');
    expect(findStatus(checks, 'counted_election_manifest_consistent')).toBe('failed');
    expect(findStatus(checks, 'counted_close_statement_consistent')).toBe('failed');
    expect(findStatus(checks, 'counted_my_vote_included')).toBe('failed');
    expect(findStatus(checks, 'counted_input_commitment_match')).toBe('failed');
    expect(findStatus(checks, 'stark_image_id_match')).toBe('failed');
    expect(findStatus(checks, 'stark_receipt_verify')).toBe('failed');
  });

  it('verifies counted_my_vote_included via bitmap proof when trusted', async () => {
    vi.mocked(verifyMyVoteWasCounted).mockResolvedValueOnce({
      valid: true,
      included: true,
      leafIndex: 0,
      bitOffset: 0,
      privacyNotice: 'notice',
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      bitmapProofSource: 'mock',
      bitmapProofEndpoint: 'https://example.com/api/bitmap-proof',
      sessionId: 'session-123',
      includedBitmapRoot: '0x' + 'f'.repeat(64),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '1'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
      },
    });

    expect(findStatus(checks, 'counted_my_vote_included')).toBe('success');
    expect(vi.mocked(verifyMyVoteWasCounted)).toHaveBeenCalledWith(
      0,
      '0x' + 'f'.repeat(64),
      expect.objectContaining({ apiEndpoint: 'https://example.com/api/bitmap-proof', sessionId: 'session-123' }),
    );
  });

  it('adds an explanatory note when seen bitmap shows the index was not presented', async () => {
    vi.mocked(explainVoteInclusionStatus).mockResolvedValueOnce({
      valid: true,
      included: false,
      seen: false,
      leafIndex: 0,
      bitOffset: 0,
      privacyNotice: 'notice',
      statusDetail: 'not_presented',
    });

    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      bitmapProofSource: 'real',
      bitmapProofEndpoint: 'https://example.com/api/bitmap-proof',
      sessionId: 'session-123',
      includedBitmapRoot: '0x' + 'f'.repeat(64),
      seenBitmapRoot: '0x' + 'e'.repeat(64),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '1'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
      },
    });

    const check = checks.find((entry) => entry.id === 'counted_my_vote_included');
    expect(check?.status).toBe('failed');
    expect(check?.noteKey).toBe('pages.verify.stepsCard.notes.myVoteIncluded.notPresented');
    expect(vi.mocked(explainVoteInclusionStatus)).toHaveBeenCalledWith(
      0,
      {
        includedBitmapRoot: '0x' + 'f'.repeat(64),
        seenBitmapRoot: '0x' + 'e'.repeat(64),
      },
      expect.objectContaining({ apiEndpoint: 'https://example.com/api/bitmap-proof', sessionId: 'session-123' }),
    );
  });

  it('uses current slot counts for the my-vote-excluded note when the journal is omitted', async () => {
    const checks = await buildVerificationChecks({
      verificationStatus: 'success',
      missingSlots: 1,
      invalidPresentedSlots: 0,
      excludedSlots: 1,
    });

    const check = checks.find((entry) => entry.id === 'counted_my_vote_included');
    expect(check?.status).toBe('not_run');
    expect(check?.noteKey).toBe('pages.verify.stepsCard.notes.myVoteIncluded.excluded');
  });

  it('forces cast checks to not_run when castSource is client', async () => {
    const checks = await buildVerificationChecks({
      castSource: 'client',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '1'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
      },
      userVote: {
        vote: 'A',
        random: '0x' + '3'.repeat(64),
      },
    });

    expect(findStatus(checks, 'cast_receipt_present')).toBe('not_run');
    expect(findStatus(checks, 'cast_choice_range')).toBe('not_run');
    expect(findStatus(checks, 'cast_random_format')).toBe('not_run');
    expect(findStatus(checks, 'cast_commitment_match')).toBe('not_run');
  });
});
