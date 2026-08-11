import { describe, expect, it } from 'vitest';
import { collectPublicBoundaryViolationPaths } from './public-boundary-scan';

function s3ObjectUrl(hostParts: string[], objectPath: string): string {
  return `https://${hostParts.join('.')}/${objectPath}`;
}

describe('public boundary scanner', () => {
  it('requires explicit capability-token exceptions', () => {
    const fixture = {
      data: {
        capabilityToken: 'v1.mock-session-capability-token',
      },
    };

    expect(collectPublicBoundaryViolationPaths(fixture)).toEqual(['data.capabilityToken']);
    expect(
      collectPublicBoundaryViolationPaths(fixture, [], {
        allowedCapabilityTokenPaths: new Set(['data.capabilityToken']),
      }),
    ).toEqual([]);
  });

  it('detects private artifact names inside paths and messages', () => {
    expect(
      collectPublicBoundaryViolationPaths({
        errors: ['failed to read /tmp/verifier-work/input.json', 'report stored at private/reports/verification.json'],
      }),
    ).toEqual(['errors[]', 'errors[]']);
  });

  it('detects private artifact names used as object keys', () => {
    expect(
      collectPublicBoundaryViolationPaths({
        files: {
          'input.json': true,
        },
        'verification.json': {
          size: 123,
        },
        artifacts: {
          'Included-Bitmap.Json': 'case variant',
        },
      }),
    ).toEqual(['files.input.json', 'verification.json', 'artifacts.Included-Bitmap.Json']);
  });

  it('detects stack-like text and private locator strings in allowed-shaped fields', () => {
    const fixture = {
      data: {
        verificationReport: {
          errors: [
            'Error: verifier failed\n    at run (/var/task/index.js:1:1)',
            `${s3ObjectUrl(
              ['bucket', 's3', 'ap-northeast-1', 'amazonaws', 'com'],
              'sessions/session-1/exec-1/bundle.zip',
            )}?X-Amz-Signature=abc`,
            'sessions/session-1/exec-1/verification.json',
            'v1.eyJzaWQiOiJzZXNzaW9uLTEifQ.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ],
        },
      },
    };

    expect(collectPublicBoundaryViolationPaths(fixture)).toEqual([
      'data.verificationReport.errors[]',
      'data.verificationReport.errors[]',
      'data.verificationReport.errors[]',
      'data.verificationReport.errors[]',
    ]);
  });

  it('detects retired bundle and report locator fields in public-shaped objects', () => {
    expect(
      collectPublicBoundaryViolationPaths({
        data: {
          bundleUrl: '/api/sessions/session-1/finalizations/finalization-1/artifacts/bundle',
          reportUrl: '/api/sessions/session-1/finalizations/finalization-1/artifacts/report',
          bundleMetadata: {
            uploadedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    ).toEqual(['data.bundleUrl', 'data.reportUrl', 'data.bundleMetadata', 'data.bundleMetadata.uploadedAt']);
  });

  it('detects locator-contextual uploadedAt and expiresAt without flagging unrelated TTL fields', () => {
    expect(
      collectPublicBoundaryViolationPaths({
        data: {
          s3: {
            uploadedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:05:00.000Z',
          },
          verifierResult: {
            uploadedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:05:00.000Z',
          },
          session: {
            expiresAt: 1730000000000,
          },
          debugToken: {
            expiresAt: 1730000000000,
          },
          cache: {
            expiresAt: 1730000000000,
          },
        },
      }),
    ).toEqual([
      'data.s3.uploadedAt',
      'data.s3.expiresAt',
      'data.verifierResult.uploadedAt',
      'data.verifierResult.expiresAt',
    ]);
  });
});
