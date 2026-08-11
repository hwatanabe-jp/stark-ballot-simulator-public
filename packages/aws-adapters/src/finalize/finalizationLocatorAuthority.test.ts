import { describe, expect, it } from 'vitest';
import {
  hasConsistentFinalizationLocatorAuthority,
  resolveBundleKeyIdentity,
  resolveReportKeyIdentity,
} from './finalizationLocatorAuthority';

describe('finalization locator authority', () => {
  it('parses scoped bundle and report identities from S3 keys', () => {
    expect(resolveBundleKeyIdentity('sessions/session-1/exec-1/bundle.zip')).toEqual({
      sessionId: 'session-1',
      finalizationId: 'exec-1',
    });
    expect(resolveReportKeyIdentity('sessions/session-1/exec-1/verification.json')).toEqual({
      sessionId: 'session-1',
      finalizationId: 'exec-1',
    });
  });

  it('rejects artifact keys outside the canonical target prefix', () => {
    expect(resolveBundleKeyIdentity('archive/session-1/exec-1/bundle.zip')).toBeNull();
    expect(resolveReportKeyIdentity('archive/session-1/exec-1/verification.json')).toBeNull();
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1', {
        s3BundleKey: 'archive/session-1/exec-1/bundle.zip',
      }),
    ).toBe(false);
  });

  it('accepts local-only finalized authority scoped by the finalization id', () => {
    expect(hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1')).toBe(true);
  });

  it('rejects a bundle key that points to a different finalized scope', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1', {
        s3BundleKey: 'sessions/other-session/other-exec/bundle.zip',
      }),
    ).toBe(false);
  });

  it('accepts one canonical bundle locator without duplicated result authority', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1', {
        s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
      }),
    ).toBe(true);
  });

  it('rejects a missing finalization selector', () => {
    expect(hasConsistentFinalizationLocatorAuthority('session-1', '')).toBe(false);
  });

  it('rejects an unsafe finalization selector', () => {
    expect(hasConsistentFinalizationLocatorAuthority('session-1', '../exec-1')).toBe(false);
  });

  it('rejects a report key that drifts outside the finalization scope', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1', {
        s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
        s3ReportKey: 'sessions/session-1/other-exec/verification.json',
      }),
    ).toBe(false);
  });

  it('accepts canonical report delivery metadata without nested lifecycle identity', () => {
    expect(
      hasConsistentFinalizationLocatorAuthority('session-1', 'exec-1', {
        s3ReportKey: 'sessions/session-1/exec-1/verification.json',
      }),
    ).toBe(true);
  });
});
