import { isSafeVerifierSegment } from '@/lib/finalize/finalize-urls';
import type { FinalizationResultAuthority } from '@/types/server';

type ScopedFinalizationLocator = Pick<
  FinalizationResultAuthority,
  'verificationExecutionId' | 's3BundleKey' | 'verificationResult'
>;

type ArtifactFileName = 'bundle.zip' | 'verification.json';

export interface FinalizationArtifactKeyIdentity {
  sessionId: string;
  executionId: string;
}

function resolveArtifactKeyIdentity(
  key: string,
  expectedFileName: ArtifactFileName,
): FinalizationArtifactKeyIdentity | null {
  const segments = key.split('/').filter(Boolean);
  if (segments.length < 3 || segments[segments.length - 1] !== expectedFileName) {
    return null;
  }

  const sessionId = segments[segments.length - 3];
  const executionId = segments[segments.length - 2];
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(executionId)) {
    return null;
  }

  return { sessionId, executionId };
}

export function resolveBundleKeyIdentity(key: string): FinalizationArtifactKeyIdentity | null {
  return resolveArtifactKeyIdentity(key, 'bundle.zip');
}

export function resolveReportKeyIdentity(key: string): FinalizationArtifactKeyIdentity | null {
  return resolveArtifactKeyIdentity(key, 'verification.json');
}

function matchesScopedAuthority(
  identity: FinalizationArtifactKeyIdentity | null,
  sessionId: string,
  executionId: string,
): boolean {
  return identity?.sessionId === sessionId && identity.executionId === executionId;
}

export function hasConsistentFinalizationLocatorAuthority(
  sessionId: string,
  result: ScopedFinalizationLocator,
): boolean {
  if (!isSafeVerifierSegment(sessionId)) {
    return false;
  }

  const executionId = result.verificationExecutionId;
  const nestedExecutionId = result.verificationResult?.executionId;
  const topLevelBundleKey = result.s3BundleKey;
  const nestedBundleKey = result.verificationResult?.s3BundleKey;
  const reportKey = result.verificationResult?.s3ReportKey;
  const requiresScopedExecutionId =
    nestedExecutionId !== undefined ||
    topLevelBundleKey !== undefined ||
    nestedBundleKey !== undefined ||
    reportKey !== undefined;
  const scopedExecutionId =
    typeof executionId === 'string' && isSafeVerifierSegment(executionId) ? executionId : undefined;

  if (requiresScopedExecutionId) {
    if (!scopedExecutionId) {
      return false;
    }
  }

  if (nestedExecutionId !== undefined) {
    if (!scopedExecutionId || !isSafeVerifierSegment(nestedExecutionId) || scopedExecutionId !== nestedExecutionId) {
      return false;
    }
  }

  if (
    topLevelBundleKey !== undefined &&
    (!scopedExecutionId ||
      !matchesScopedAuthority(resolveBundleKeyIdentity(topLevelBundleKey), sessionId, scopedExecutionId))
  ) {
    return false;
  }

  if (nestedBundleKey !== undefined) {
    if (topLevelBundleKey !== nestedBundleKey) {
      return false;
    }
    if (
      !scopedExecutionId ||
      !matchesScopedAuthority(resolveBundleKeyIdentity(nestedBundleKey), sessionId, scopedExecutionId)
    ) {
      return false;
    }
  }

  if (
    reportKey !== undefined &&
    (!scopedExecutionId || !matchesScopedAuthority(resolveReportKeyIdentity(reportKey), sessionId, scopedExecutionId))
  ) {
    return false;
  }

  return true;
}
