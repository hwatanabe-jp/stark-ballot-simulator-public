import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import {
  buildMountedBehaviorProbeSnapshot,
  buildMountedBehaviorProbes,
  buildProbeStore,
  deterministicProbeRequestId,
  sortMountedBehaviorSnapshots,
  validateMountedBehaviorCoverage,
} from './public-contract-probe-policy';
import type { MountedBehaviorProbeSnapshot } from './public-contract-policy';

function emptySnapshot(probe: ReturnType<typeof buildMountedBehaviorProbes>[number]): MountedBehaviorProbeSnapshot {
  return {
    probeId: probe.probeId,
    mode: probe.mode,
    method: probe.method,
    path: new URL(probe.url).pathname,
    status: 200,
    headers: {},
    body: {
      bytes: 0,
      sha256: '0'.repeat(64),
    },
  };
}

describe('public contract mounted-behavior probe policy', () => {
  it('builds exact lifecycle-owned probe records without an aggregate compatibility surface', async () => {
    const sessionId = 'session-baseline-mounted';
    const finalizationId = 'finalization-baseline-mounted';
    const admittedSessionId = asSessionId(sessionId);
    const admittedFinalizationId = asFinalizationId(finalizationId);
    const store = buildProbeStore(sessionId, finalizationId);

    expect('getSession' in store).toBe(false);
    expect('updateSession' in store).toBe(false);
    await expect(store.getSessionIdentity(admittedSessionId)).resolves.toMatchObject({
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
    });
    await expect(store.getVotingRecord(admittedSessionId)).resolves.toMatchObject({
      sessionId,
      userParticipation: { status: 'cast', voteIndex: 0 },
    });
    await expect(store.getCurrentFinalizationRecord(admittedSessionId)).resolves.toMatchObject({
      sessionId,
      finalizationId,
      state: { status: 'succeeded', finalizationId },
      finalizationResult: { finalizationId },
    });
    await expect(store.getVerificationResultRecord(admittedSessionId, admittedFinalizationId)).resolves.toMatchObject({
      sessionId,
      finalizationId,
      verificationResult: { status: 'success' },
    });
    await expect(
      buildProbeStore(sessionId, finalizationId, { bitmapEvidence: 'unavailable' }).getBitmapData(
        admittedSessionId,
        admittedFinalizationId,
      ),
    ).resolves.toBeNull();
  });

  it('builds the exact deterministic probe inventory from admitted identifiers and headers', () => {
    const probes = buildMountedBehaviorProbes({
      sessionId: 'session-baseline-mounted',
      finalizationId: 'finalization-baseline-mounted',
      pathCapabilityHeaders: { 'X-Session-Capability': 'capability' },
    });

    expect(probes.map(({ probeId }) => probeId)).toEqual([
      'lambda.bundle.cors-preflight.range-header',
      'lambda.bundle.missing-capability.error-envelope',
      'lambda.bundle.local-binary.no-store',
      'lambda.bundle.range-unsatisfiable.416',
      'lambda.bundle.cross-session-capability-denied',
      'lambda.report.local-json.no-store',
      'lambda.current-finalization.succeeded.no-store',
      'lambda.bitmap.missing-capability.error-envelope',
      'lambda.bitmap.etag.private-cache',
      'lambda.bitmap.conditional.no-body',
      'readonly.sessions-post.not-mounted',
      'lambda.finalization-callback.not-mounted',
      'full.finalization-callback.invalid-request.error-envelope',
      'full.finalization-callback.cors-preflight.not-public',
    ]);
    expect(probes.find(({ probeId }) => probeId === 'lambda.bundle.range-unsatisfiable.416')).toMatchObject({
      headers: {
        'X-Session-Capability': 'capability',
        Range: 'bytes=999999-1000000',
      },
      expectCanonicalJson: true,
    });
  });

  it('validates and deterministically sorts the complete coverage inventory', () => {
    const probes = buildMountedBehaviorProbes({
      sessionId: 'session-baseline-mounted',
      finalizationId: 'finalization-baseline-mounted',
      pathCapabilityHeaders: {},
    });
    const coverage = validateMountedBehaviorCoverage(probes.map(emptySnapshot));

    expect(coverage.map(({ caseId }) => caseId)).toEqual(
      [...coverage.map(({ caseId }) => caseId)].sort((left, right) => left.localeCompare(right)),
    );
    expect(() =>
      validateMountedBehaviorCoverage(
        probes.filter(({ probeId }) => probeId !== 'lambda.bundle.local-binary.no-store').map(emptySnapshot),
      ),
    ).toThrow(
      'Mounted behavior coverage case bundle-local-binary-headers-cache-privacy references missing probe lambda.bundle.local-binary.no-store',
    );
  });

  it('projects captured response bytes, selected headers, and canonical JSON diagnostics exactly', () => {
    const probe = {
      probeId: 'lambda.example.error',
      mode: 'lambda' as const,
      method: 'GET',
      url: 'http://localhost/api/example?ignored=true',
      expectCanonicalJson: true,
    };
    const expectedRequestId = deterministicProbeRequestId(probe.probeId);
    const bodyText = JSON.stringify({
      error: { code: 'INVALID_REQUEST' },
      meta: { requestId: expectedRequestId },
    });
    const bytes = new TextEncoder().encode(bodyText);
    const headers = new Headers({
      'content-type': 'application/json',
      'x-request-id': expectedRequestId,
      'cache-control': 'no-store',
      'x-unreviewed-header': 'not-recorded',
    });

    expect(
      buildMountedBehaviorProbeSnapshot({
        probe,
        status: 400,
        headers,
        bytes,
        expectedRequestId,
      }),
    ).toEqual({
      probeId: probe.probeId,
      mode: 'lambda',
      method: 'GET',
      path: '/api/example',
      status: 400,
      headers: {
        'accept-ranges': null,
        'access-control-allow-headers': null,
        'access-control-allow-methods': null,
        'access-control-allow-origin': null,
        'cache-control': 'no-store',
        'content-disposition': null,
        'content-range': null,
        'content-type': 'application/json',
        etag: null,
        vary: null,
        'x-stark-bundle-range-chunk-size': null,
        'x-request-id': expectedRequestId,
      },
      body: {
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        jsonError: 'INVALID_REQUEST',
        jsonKeys: ['error', 'meta'],
        jsonRequestId: expectedRequestId,
      },
    });
  });

  it('preserves request-ID admission errors and snapshot ordering', () => {
    const probe = {
      probeId: 'lambda.example',
      mode: 'lambda' as const,
      method: 'GET',
      url: 'http://localhost/api/example',
    };
    expect(() =>
      buildMountedBehaviorProbeSnapshot({
        probe,
        status: 200,
        headers: new Headers(),
        bytes: new Uint8Array(),
        expectedRequestId: 'expected',
      }),
    ).toThrow('Mounted behavior probe lambda.example request ID header mismatch: expected expected, received <none>');

    const snapshots = ['zeta', 'alpha'].map((probeId): MountedBehaviorProbeSnapshot => ({
      probeId,
      mode: 'lambda',
      method: 'GET',
      path: `/${probeId}`,
      status: 200,
      headers: {},
      body: { bytes: 0, sha256: '0'.repeat(64) },
    }));
    expect(sortMountedBehaviorSnapshots(snapshots).map(({ probeId }) => probeId)).toEqual(['alpha', 'zeta']);
  });
});
