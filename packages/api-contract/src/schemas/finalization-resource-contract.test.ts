import { describe, expect, it } from 'vitest';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { API_ROUTES, TARGET_API_ROUTE_CONTRACTS, buildApiRouteUrl, matchApiRoute } from '../routes';
import {
  CurrentFinalizationResponseSchema,
  FinalizationCancelRequestSchema,
  FinalizationResourceSchema,
  FinalizationResponseSchema,
} from './index';
import succeededFinalizationFixture from './fixtures/json/finalizations.post.succeeded.json';

const META = { requestId: 'request-finalization-contract' };
const FINALIZATION_ID = '01K19W7ZQK5PK0TQZDXJX1GJ5J';
const UINT32_OVERFLOW = 0x1_0000_0000;
const DIFFERENT_HEX = `0x${'7'.repeat(64)}`;
const VALID_VOTE_COMMITMENT = `0x${'b'.repeat(64)}`;
const VALID_CAST_ROOT = '0x000e336a908387d3532d981998a2aa81f31e7867ec97f763afe954364988b629';
const DIFFERENT_ELECTION_ID = '00000000-0000-4000-8000-000000000002';

type MutableRecord = Record<string, unknown>;
type MutableSucceededResponse = {
  data: {
    result: {
      authority: MutableRecord;
      presentation: MutableRecord;
      artifactAvailability: MutableRecord;
    };
  };
};

function cloneSucceededResponse(): MutableSucceededResponse {
  const response: MutableSucceededResponse = structuredClone(succeededFinalizationFixture);
  const { authority, presentation } = response.data.result;
  const journal = nestedRecord(authority, 'journal');
  const existingCloseStatement = nestedRecord(authority, 'closeStatement');
  const electionManifest = buildElectionManifest(String(journal['electionId']), buildDefaultElectionConfig());
  const closeStatement = buildCloseStatement({
    logId: String(existingCloseStatement['logId']),
    treeSize: Number(journal['treeSize']),
    timestamp: Number(existingCloseStatement['timestamp']),
    bulletinRoot: String(journal['bulletinRoot']),
  });

  authority['electionManifest'] = electionManifest;
  authority['closeStatement'] = closeStatement;
  journal['electionConfigHash'] = electionManifest.electionConfigHash;
  journal['sthDigest'] = closeStatement.sthDigest;
  presentation['sthDigest'] = closeStatement.sthDigest;

  const voterEvidence = nestedRecord(response.data.result, 'voterEvidence');
  const voteReceipt = nestedRecord(voterEvidence, 'voteReceipt');
  const userVote = nestedRecord(voterEvidence, 'userVote');
  const proof = nestedRecord(userVote, 'proof');
  voteReceipt['commitment'] = VALID_VOTE_COMMITMENT;
  voteReceipt['bulletinIndex'] = 0;
  voteReceipt['bulletinRootAtCast'] = VALID_CAST_ROOT;
  userVote['commitment'] = VALID_VOTE_COMMITMENT;
  proof['leafIndex'] = 0;
  proof['treeSize'] = 1;
  proof['merklePath'] = [];
  proof['bulletinRootAtCast'] = VALID_CAST_ROOT;

  return response;
}

function requireRecord(value: unknown, label: string): MutableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as MutableRecord;
}

function nestedRecord(parent: MutableRecord, key: string): MutableRecord {
  return requireRecord(parent[key], key);
}

function useDevModeReport(response: MutableSucceededResponse, receiptImageId: string | null): void {
  const { authority, presentation } = response.data.result;
  const report = nestedRecord(presentation, 'verificationReport');
  presentation['verificationStatus'] = 'dev_mode';
  presentation['verificationReport'] = {
    ...report,
    status: 'dev_mode',
    expected_image_id: authority['imageId'],
    receipt_image_id: receiptImageId,
    dev_mode_receipt: true,
  };
}

function useFailedReport(
  response: MutableSucceededResponse,
  expectedImageId: string,
  receiptImageId: string | null,
): void {
  const { presentation } = response.data.result;
  const report = nestedRecord(presentation, 'verificationReport');
  presentation['verificationStatus'] = 'failed';
  presentation['verificationReport'] = {
    ...report,
    status: 'failed',
    expected_image_id: expectedImageId,
    receipt_image_id: receiptImageId,
    dev_mode_receipt: false,
    errors: ['ImageID mismatch'],
  };
}

function useScenarioOne(response: MutableSucceededResponse, verificationStatus: 'success' | 'failed'): void {
  const { authority, presentation, artifactAvailability } = response.data.result;
  const journal = nestedRecord(authority, 'journal');

  Object.assign(journal, {
    verifiedTally: [12, 12, 14, 11, 14],
    totalVotes: 63,
    validVotes: 63,
    invalidVotes: 0,
    seenIndicesCount: 63,
    missingSlots: 1,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 1,
  });
  Object.assign(presentation, {
    tally: {
      counts: { A: 12, B: 12, C: 14, D: 11, E: 14 },
      totalVotes: 63,
      tamperedCount: 1,
    },
    verifiedTally: [12, 12, 14, 11, 14],
    tamperDetected: true,
    scenarios: ['S1'],
    tamperSummary: {
      ignoredVotes: 1,
      recountedVotes: 0,
      userRecountedTo: null,
      affectedBotIds: [],
    },
    seenIndicesCount: 63,
    missingSlots: 1,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 1,
  });

  if (verificationStatus === 'failed') {
    presentation['verificationStatus'] = 'failed';
    delete presentation['verificationReport'];
    artifactAvailability['report'] = 'available';
  }
}

const pendingResource = {
  finalizationId: FINALIZATION_ID,
  status: 'pending',
  queuedAtMs: 1_754_000_000_000,
  runtimeDiagnostics: {
    asyncMode: 'enabled',
    queue: {
      concurrencyLimit: 1,
      estimatedDurationMs: 30_000,
    },
  },
} as const;

describe('finalization resource contract', () => {
  it('uses one strict resource for create, current, and cancel responses', () => {
    expect(FinalizationResourceSchema.safeParse(pendingResource).success).toBe(true);
    expect(FinalizationResponseSchema.safeParse({ data: pendingResource, meta: META }).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse({ data: null, meta: META }).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse({ data: pendingResource, meta: META }).success).toBe(true);
  });

  it('rejects legacy identity, timestamp, locator, and aggregate fields', () => {
    for (const legacy of [
      { ...pendingResource, executionId: FINALIZATION_ID },
      { ...pendingResource, queuedAt: pendingResource.queuedAtMs },
      { ...pendingResource, statusUrl: '/api/sessions/session-1/status' },
      { ...pendingResource, executionArn: 'arn:aws:states:example' },
      { ...pendingResource, finalizationState: pendingResource },
    ]) {
      expect(FinalizationResourceSchema.safeParse(legacy).success).toBe(false);
    }
  });

  it('uses the finalization path identity for cancellation', () => {
    expect(FinalizationCancelRequestSchema.safeParse({}).success).toBe(true);
    expect(FinalizationCancelRequestSchema.safeParse({ reason: 'operator request' }).success).toBe(true);
    expect(
      FinalizationCancelRequestSchema.safeParse({
        finalizationId: FINALIZATION_ID,
      }).success,
    ).toBe(false);
    expect(
      FinalizationCancelRequestSchema.safeParse({
        executionId: FINALIZATION_ID,
      }).success,
    ).toBe(false);
  });

  it('exposes only resource-scoped finalization routes and keeps the callback out of the public inventory', () => {
    expect(API_ROUTES.createFinalization.routeId).toBe('sessions.finalizations.post');
    expect(API_ROUTES.currentFinalization.routeId).toBe('sessions.finalizations.current.get');
    expect(API_ROUTES.cancelFinalization.routeId).toBe('sessions.finalizations.cancel.post');
    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.routeId.includes('Callback'))).toBe(false);
    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.path.startsWith('/internal/'))).toBe(false);

    expect(
      buildApiRouteUrl(API_ROUTES.createFinalization, {
        params: { sessionId: 'session/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations');
    expect(
      buildApiRouteUrl(API_ROUTES.currentFinalization, {
        params: { sessionId: 'session/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/current');
    expect(
      buildApiRouteUrl(API_ROUTES.cancelFinalization, {
        params: { sessionId: 'session/one', finalizationId: FINALIZATION_ID },
      }),
    ).toBe(`/api/sessions/session%2Fone/finalizations/${FINALIZATION_ID}/cancel`);

    for (const [method, path] of [
      ['POST', '/api/finalize'],
      ['POST', '/api/finalize/cancel'],
      ['GET', '/api/sessions/session-1/status'],
      ['POST', '/api/finalize/callback'],
    ] as const) {
      expect(matchApiRoute(method, path)).toBeNull();
    }
  });

  it('declares capability-only path admission', () => {
    for (const route of [
      API_ROUTES.createFinalization,
      API_ROUTES.currentFinalization,
      API_ROUTES.cancelFinalization,
    ]) {
      expect(route.authScope).toBe('path-session-capability');
      expect(route.capabilityScope).toBe('path');
      expect(Object.keys(route.request.headers.shape)).toEqual(['X-Session-Capability']);
      expect(
        route.request.headers.safeParse({
          'X-Session-Capability': 'capability-token',
          'X-Session-ID': 'session-1',
        }).success,
      ).toBe(false);
    }
  });

  describe('succeeded public evidence admission', () => {
    it('preserves the current wire representation while accepting normalized duplicate hex values', () => {
      const response = cloneSucceededResponse();
      const { authority, presentation } = response.data.result;
      const journal = nestedRecord(authority, 'journal');
      const receipt = nestedRecord(authority, 'receipt');

      authority['imageId'] = String(authority['imageId']).slice(2).toUpperCase();
      for (const field of ['bulletinRoot', 'sthDigest', 'seenBitmapRoot', 'includedBitmapRoot', 'inputCommitment']) {
        presentation[field] = String(journal[field]).slice(2).toUpperCase();
      }

      const parsed = FinalizationResponseSchema.safeParse(response);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(response);
      }
      expect(receipt['imageId']).toBe(succeededFinalizationFixture.data.result.authority.receipt.imageId);
    });

    it.each(['electionManifest', 'closeStatement'] as const)(
      'rejects public audit authority with only %s missing',
      (missingArtifact) => {
        const response = cloneSucceededResponse();
        delete response.data.result.authority[missingArtifact];

        expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
      },
    );

    it.each([
      ['manifest unknown key', 'electionManifest', 'unexpected', true],
      ['manifest election UUID', 'electionManifest', 'electionId', 'not-a-uuid'],
      ['manifest totalExpected u32 bound', 'electionManifest', 'totalExpected', UINT32_OVERFLOW],
      ['manifest botCount u32 bound', 'electionManifest', 'botCount', UINT32_OVERFLOW],
      ['manifest nonempty choices', 'electionManifest', 'choices', []],
      ['manifest nonempty choice', 'electionManifest', 'choices', ['A', '']],
      ['manifest positive tree depth', 'electionManifest', 'merkleTreeDepth', 0],
      ['close statement unknown key', 'closeStatement', 'unexpected', true],
      ['close statement positive tree size', 'closeStatement', 'treeSize', 0],
      ['close statement u32 tree bound', 'closeStatement', 'treeSize', UINT32_OVERFLOW],
      ['close statement safe timestamp', 'closeStatement', 'timestamp', Number.MAX_SAFE_INTEGER + 1],
    ] as const)('rejects invalid public audit %s', (_label, artifact, field, value) => {
      const response = cloneSucceededResponse();
      const artifactRecord = nestedRecord(response.data.result.authority, artifact);
      artifactRecord[field] = value;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      ['electionId', DIFFERENT_ELECTION_ID],
      ['totalExpected', 63],
    ] as const)('rejects a manifest %s that contradicts the journal', (field, value) => {
      const response = cloneSucceededResponse();
      const manifest = nestedRecord(response.data.result.authority, 'electionManifest');
      manifest[field] = value;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a manifest whose declared hash contradicts its own configuration', () => {
      const response = cloneSucceededResponse();
      const manifest = nestedRecord(response.data.result.authority, 'electionManifest');
      manifest['version'] = 'self-hash-mismatch';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a self-consistent manifest hash that contradicts the journal', () => {
      const response = cloneSucceededResponse();
      const { authority } = response.data.result;
      const manifest = nestedRecord(authority, 'electionManifest');
      authority['electionManifest'] = buildElectionManifest(String(manifest['electionId']), {
        ...buildDefaultElectionConfig(),
        version: 'journal-hash-mismatch',
      });

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      ['treeSize', 63],
      ['bulletinRoot', DIFFERENT_HEX],
    ] as const)('rejects a close statement %s that contradicts the journal', (field, value) => {
      const response = cloneSucceededResponse();
      const closeStatement = nestedRecord(response.data.result.authority, 'closeStatement');
      closeStatement[field] = value;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a close statement digest that contradicts its own inputs', () => {
      const response = cloneSucceededResponse();
      const closeStatement = nestedRecord(response.data.result.authority, 'closeStatement');
      closeStatement['timestamp'] = Number(closeStatement['timestamp']) + 1;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a recomputed close statement digest that contradicts the journal', () => {
      const response = cloneSucceededResponse();
      const { authority } = response.data.result;
      const journal = nestedRecord(authority, 'journal');
      const closeStatement = nestedRecord(authority, 'closeStatement');
      authority['closeStatement'] = buildCloseStatement({
        logId: String(closeStatement['logId']),
        treeSize: Number(closeStatement['treeSize']),
        timestamp: Number(closeStatement['timestamp']) + 1,
        bulletinRoot: String(closeStatement['bulletinRoot']),
      });

      expect(authority['closeStatement']).not.toEqual(closeStatement);
      expect(journal['sthDigest']).not.toBe(nestedRecord(authority, 'closeStatement')['sthDigest']);
      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('requires the current succeeded seen bitmap root', () => {
      const response = cloneSucceededResponse();
      delete response.data.result.presentation['seenBitmapRoot'];

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      ['verifiedTally', [12, 13, 14, 11, 14]],
      ['bulletinRoot', DIFFERENT_HEX],
      ['missingSlots', 1],
      ['invalidPresentedSlots', 1],
      ['rejectedRecords', 1],
      ['totalExpected', 63],
      ['treeSize', 63],
      ['excludedSlots', 1],
      ['sthDigest', DIFFERENT_HEX],
      ['seenBitmapRoot', DIFFERENT_HEX],
      ['includedBitmapRoot', DIFFERENT_HEX],
      ['inputCommitment', DIFFERENT_HEX],
      ['seenIndicesCount', 63],
    ] as const)('rejects a presentation %s that contradicts the journal', (field, value) => {
      const response = cloneSucceededResponse();
      response.data.result.presentation[field] = value;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each(['journal', 'receipt'] as const)('rejects an authority ImageID that contradicts the %s', (owner) => {
      const response = cloneSucceededResponse();
      const ownerRecord = nestedRecord(response.data.result.authority, owner);
      ownerRecord['imageId'] = DIFFERENT_HEX;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each(['success', 'dev_mode', 'failed'] as const)(
      'rejects a %s report whose expected ImageID contradicts authority',
      (status) => {
        const response = cloneSucceededResponse();
        const { presentation } = response.data.result;
        if (status === 'dev_mode') {
          useDevModeReport(response, DIFFERENT_HEX);
          nestedRecord(presentation, 'verificationReport')['expected_image_id'] = DIFFERENT_HEX;
        } else if (status === 'failed') {
          useFailedReport(response, DIFFERENT_HEX, DIFFERENT_HEX);
        } else {
          const report = nestedRecord(presentation, 'verificationReport');
          report['expected_image_id'] = DIFFERENT_HEX;
          report['receipt_image_id'] = DIFFERENT_HEX;
        }

        expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
      },
    );

    it('rejects a dev-mode report without an authority-bound receipt ImageID', () => {
      const response = cloneSucceededResponse();
      useDevModeReport(response, null);

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('allows a failed report to preserve a receipt ImageID mismatch as failure evidence', () => {
      const response = cloneSucceededResponse();
      useFailedReport(response, String(response.data.result.authority['imageId']), DIFFERENT_HEX);

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });

    it('requires finalized available voter evidence to carry the journal input commitment', () => {
      const response = cloneSucceededResponse();
      const voterEvidence = nestedRecord(response.data.result, 'voterEvidence');
      delete nestedRecord(voterEvidence, 'voteReceipt')['inputCommitment'];

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      ['vote identity', 'userVote', 'voteId', 'different-vote'],
      ['vote commitment', 'userVote', 'commitment', DIFFERENT_HEX],
      ['proof leaf index', 'proof', 'leafIndex', 1],
      ['cast root', 'proof', 'bulletinRootAtCast', DIFFERENT_HEX],
      ['journal input commitment', 'voteReceipt', 'inputCommitment', DIFFERENT_HEX],
      ['cast snapshot tree size', 'proof', 'treeSize', 2],
      ['cryptographic inclusion path', 'proof', 'merklePath', [DIFFERENT_HEX]],
    ] as const)('rejects available voter evidence with contradictory %s', (_label, owner, field, value) => {
      const response = cloneSucceededResponse();
      const voterEvidence = nestedRecord(response.data.result, 'voterEvidence');
      const userVote = nestedRecord(voterEvidence, 'userVote');
      const target = owner === 'proof' ? nestedRecord(userVote, 'proof') : nestedRecord(voterEvidence, owner);
      target[field] = value;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a cast snapshot that is newer than the final journal tree', () => {
      const response = cloneSucceededResponse();
      const voterEvidence = nestedRecord(response.data.result, 'voterEvidence');
      const voteReceipt = nestedRecord(voterEvidence, 'voteReceipt');
      const proof = nestedRecord(nestedRecord(voterEvidence, 'userVote'), 'proof');
      voteReceipt['bulletinIndex'] = 64;
      proof['leafIndex'] = 64;
      proof['treeSize'] = 65;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each(['scenarios', 'tamperDetected'] as const)('requires current presentation field %s', (field) => {
      const response = cloneSucceededResponse();
      delete response.data.result.presentation[field];

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('requires the current presentation tampered count', () => {
      const response = cloneSucceededResponse();
      delete nestedRecord(response.data.result.presentation, 'tally')['tamperedCount'];

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      ['an unknown scenario', ['S9']],
      ['multiple scenarios', ['S1', 'S2']],
      ['an explicit S0 singleton', ['S0']],
    ] as const)('rejects %s in the current scenario projection', (_label, scenarios) => {
      const response = cloneSucceededResponse();
      response.data.result.presentation['scenarios'] = scenarios;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each([
      [
        'tamper detection',
        (presentation: MutableRecord) => {
          presentation['tamperDetected'] = true;
        },
      ],
      [
        'tampered count',
        (presentation: MutableRecord) => {
          nestedRecord(presentation, 'tally')['tamperedCount'] = 1;
        },
      ],
      [
        'tamper summary',
        (presentation: MutableRecord) => {
          presentation['tamperSummary'] = {
            ignoredVotes: 1,
            recountedVotes: 0,
            userRecountedTo: null,
            affectedBotIds: [],
          };
        },
      ],
      [
        'claimed tally',
        (presentation: MutableRecord) => {
          presentation['tally'] = {
            counts: { A: 12, B: 13, C: 14, D: 11, E: 14 },
            totalVotes: 64,
            tamperedCount: 0,
          };
        },
      ],
    ] as const)('rejects an S0 presentation with forged %s', (_label, forgePresentation) => {
      const response = cloneSucceededResponse();
      forgePresentation(response.data.result.presentation);

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('admits a coherent S1 presentation with a fail-closed verification status', () => {
      const response = cloneSucceededResponse();
      useScenarioOne(response, 'failed');

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });

    it('rejects a success status when the journal contains counted exclusions', () => {
      const response = cloneSucceededResponse();
      useScenarioOne(response, 'success');

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('rejects a success status when total expected contradicts the final tree size', () => {
      const response = cloneSucceededResponse();
      const { authority, presentation } = response.data.result;
      delete authority['electionManifest'];
      delete authority['closeStatement'];
      nestedRecord(authority, 'journal')['totalExpected'] = 65;
      presentation['totalExpected'] = 65;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it.each(['not_run', 'running', 'dev_mode', 'failed'] as const)(
      'rejects a success report paired with %s verification status',
      (verificationStatus) => {
        const response = cloneSucceededResponse();
        response.data.result.presentation['verificationStatus'] = verificationStatus;

        expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
      },
    );

    it.each([
      ['present success report declared unavailable', 'success', false, 'unavailable'],
      ['absent success report declared available', 'success', true, 'available'],
      ['absent dev-mode report declared available', 'dev_mode', true, 'available'],
      ['absent not-run report declared available', 'not_run', true, 'available'],
      ['absent running report declared available', 'running', true, 'available'],
    ] as const)('rejects %s', (_label, verificationStatus, removeReport, availability) => {
      const response = cloneSucceededResponse();
      response.data.result.presentation['verificationStatus'] = verificationStatus;
      if (removeReport) {
        delete response.data.result.presentation['verificationReport'];
      }
      response.data.result.artifactAvailability['report'] = availability;

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('admits a successful status without a report only when report delivery is unavailable', () => {
      const response = cloneSucceededResponse();
      delete response.data.result.presentation['verificationReport'];
      response.data.result.artifactAvailability['report'] = 'unavailable';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });

    it('admits a failed status whose deliverable report was omitted by the public sanitizer', () => {
      const response = cloneSucceededResponse();
      response.data.result.presentation['verificationStatus'] = 'failed';
      delete response.data.result.presentation['verificationReport'];
      response.data.result.artifactAvailability['report'] = 'available';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });

    it('rejects seen bitmap availability without included bitmap availability', () => {
      const response = cloneSucceededResponse();
      response.data.result.artifactAvailability['includedBitmap'] = 'unavailable';
      response.data.result.artifactAvailability['seenBitmap'] = 'available';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    });

    it('allows included bitmap availability without seen bitmap availability', () => {
      const response = cloneSucceededResponse();
      response.data.result.artifactAvailability['includedBitmap'] = 'available';
      response.data.result.artifactAvailability['seenBitmap'] = 'unavailable';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });

    it('does not derive bundle or bitmap availability from the public result', () => {
      const response = cloneSucceededResponse();
      response.data.result.artifactAvailability['bundle'] = 'unavailable';
      response.data.result.artifactAvailability['includedBitmap'] = 'unavailable';
      response.data.result.artifactAvailability['seenBitmap'] = 'unavailable';

      expect(FinalizationResponseSchema.safeParse(response).success).toBe(true);
    });
  });
});
