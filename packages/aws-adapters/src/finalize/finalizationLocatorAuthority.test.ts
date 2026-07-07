import { describe, expect, it } from 'vitest';
import {
  hasConsistentFinalizationLocatorAuthority,
  resolveBundleKeyIdentity,
  resolveReportKeyIdentity,
} from './finalizationLocatorAuthority';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function createScopedResult(
  overrides: Partial<
    Pick<AwsPersistedFinalizationResult, 'verificationExecutionId' | 's3BundleKey' | 'verificationResult'>
  > = {},
): Pick<AwsPersistedFinalizationResult, 'verificationExecutionId' | 's3BundleKey' | 'verificationResult'> {
  return {
    verificationExecutionId: 'exec-1',
    ...overrides,
  };
}

describe('finalization locator authority', () => {
  it('parses scoped bundle and report identities from S3 keys', () => {
    expect(resolveBundleKeyIdentity('sessions/session-1/exec-1/bundle.zip')).toEqual({
      sessionId: 'session-1',
      executionId: 'exec-1',
    });
    expect(resolveReportKeyIdentity('sessions/session-1/exec-1/verification.json')).toEqual({
      sessionId: 'session-1',
      executionId: 'exec-1',
    });
  });

  it('rejects artifact keys outside the canonical target prefix', () => {
    expect(resolveBundleKeyIdentity('archive/session-1/exec-1/bundle.zip')).toBeNull();
    expect(resolveReportKeyIdentity('archive/session-1/exec-1/verification.json')).toBeNull();
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          ...omitUndefinedProperties({ s3BundleKey: 'archive/session-1/exec-1/bundle.zip' }),
        }),
      ),
    ).toBe(false);
  });

  it('accepts local-only finalized authority scoped by top-level execution id', () => {
    expect(hasConsistentFinalizationLocatorAuthority('session-1', createScopedResult())).toBe(true);
  });

  it('rejects a top-level bundle key that points to a different finalized scope', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          ...omitUndefinedProperties({ s3BundleKey: 'sessions/other-session/other-exec/bundle.zip' }),
        }),
      ),
    ).toBe(false);
  });

  it('rejects nested bundle metadata when the top-level authoritative bundle key is missing', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          ...omitUndefinedProperties({ s3BundleKey: undefined }),
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
            ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects nested verification execution when the top-level selector is missing', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', {
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
        },
      }),
    ).toBe(false);
  });

  it('rejects nested verification execution when the top-level selector is unsafe', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          verificationExecutionId: '../exec-1',
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a report key that drifts outside the top-level selector scope', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
            s3ReportKey: 'sessions/session-1/other-exec/verification.json',
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a nested execution id that disagrees with the top-level authority', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority(
        'session-1',
        createScopedResult({
          verificationResult: {
            status: 'success',
            executionId: 'exec-2',
          },
        }),
      ),
    ).toBe(false);
  });
});
