import { describe, it, expect } from 'vitest';
import {
  admitAppDeploymentStatus,
  canonicalAppDeploymentStatusJson,
  parseCanonicalAppDeploymentStatus,
  APP_DEPLOYMENT_STATUS_MAX_BYTES,
} from './app-deployment-status.js';
import { resolveAllowedDeploymentTarget } from './index.js';
import { assertAppStatusPublicationOrder } from './app-deployment-status-publication.js';
const target = 'stark-dev/develop';
const source = 'a'.repeat(40);
function status() {
  return {
    deploymentId: `dep_${'b'.repeat(32)}`,
    source: {
      shortSha: source.slice(0, 12),
      commitUrl: `${resolveAllowedDeploymentTarget(target).repositoryUrl}/commit/${source}`,
    },
    prover: { imageDigestPrefix: 'sha256:cccccccccccc', imageId: `0x${'d'.repeat(64)}`, methodVersion: 4 },
    deploymentMode: 'normal',
    planDisposition: 'changed',
    smokeOutcome: 'passed',
    acceptedAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    staleAfter: '2026-11-10T00:00:00.000Z',
  };
}
describe('App status public boundary', () => {
  it('preserves exact DTO, thirty day freshness, accepted timestamp and byte ceiling', () => {
    const body = canonicalAppDeploymentStatusJson(status(), target);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(APP_DEPLOYMENT_STATUS_MAX_BYTES);
    expect(parseCanonicalAppDeploymentStatus(body, target)).toEqual(status());
  });
  it.each([
    { updatedAt: '2026-10-12T00:00:00.000Z' },
    { staleAfter: '2026-11-11T00:00:00.000Z' },
    { smokeOutcome: 'failed' },
    { privateRecord: {} },
    { source: { shortSha: source.slice(0, 12), commitUrl: `https://foreign.example/commit/${source}` } },
  ])('rejects detached freshness, failed smoke and private fields %j', (patch) => {
    expect(() => admitAppDeploymentStatus({ ...status(), ...patch }, target)).toThrow();
  });
  it('rejects whitespace/reformatted stored bytes and oversized documents', () => {
    expect(() => parseCanonicalAppDeploymentStatus(JSON.stringify(status()), target)).toThrow();
    expect(() => parseCanonicalAppDeploymentStatus(' '.repeat(4097), target)).toThrow('limit');
  });
});

describe('App status acceptance ordering', () => {
  const original = canonicalAppDeploymentStatusJson(status(), target);
  const newer = canonicalAppDeploymentStatusJson(
    {
      ...status(),
      deploymentId: `dep_${'c'.repeat(32)}`,
      acceptedAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      staleAfter: '2026-11-11T00:00:00.000Z',
    },
    target,
  );
  it('admits exact duplicate delivery and strictly newer checkpoint acceptance', () => {
    expect(() => assertAppStatusPublicationOrder(original, original, target)).not.toThrow();
    expect(() => assertAppStatusPublicationOrder(original, newer, target)).not.toThrow();
  });
  it('rejects reversed delivery and conflicting acceptance at the same timestamp', () => {
    expect(() => assertAppStatusPublicationOrder(newer, original, target)).toThrow('acceptance');
    const conflict = canonicalAppDeploymentStatusJson({ ...status(), deploymentId: `dep_${'c'.repeat(32)}` }, target);
    expect(() => assertAppStatusPublicationOrder(original, conflict, target)).toThrow('acceptance');
  });
});
