import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import {
  buildFinalizationArtifactS3Keys,
  TARGET_PROOF_ARTIFACT_PREFIX,
} from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';

type ScopedFinalizationLocator = Pick<
  AwsPersistedFinalizationResult,
  'verificationExecutionId' | 's3BundleKey' | 'verificationResult'
>;

type ArtifactFileName = 'bundle.zip' | 'verification.json';

export interface FinalizationArtifactKeyIdentity {
  sessionId: string;
  executionId: string;
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[key];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function resolveArtifactKeyIdentity(
  key: string,
  expectedFileName: ArtifactFileName,
): FinalizationArtifactKeyIdentity | null {
  const segments = key.split('/').filter(Boolean);
  const prefixSegments = TARGET_PROOF_ARTIFACT_PREFIX.split('/').filter(Boolean);
  if (
    segments.length !== prefixSegments.length + 3 ||
    segments[segments.length - 1] !== expectedFileName ||
    !prefixSegments.every((segment, index) => segments[index] === segment)
  ) {
    return null;
  }

  const sessionId = segments[segments.length - 3];
  const executionId = segments[segments.length - 2];
  if (!sessionId || !executionId) {
    return null;
  }
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

function matchesCanonicalArtifactKey(
  key: string,
  sessionId: string,
  executionId: string,
  artifact: ArtifactFileName,
): boolean {
  const expectedKeys = buildFinalizationArtifactS3Keys(sessionId, executionId);
  return key === (artifact === 'bundle.zip' ? expectedKeys.bundleS3Key : expectedKeys.reportS3Key);
}

export function hasConsistentFinalizationLocatorAuthority(
  sessionId: string,
  result: ScopedFinalizationLocator,
): boolean {
  if (!isSafeVerifierSegment(sessionId)) {
    return false;
  }

  const executionId = result.verificationExecutionId;
  const nestedExecutionId = getStringField(result.verificationResult, 'executionId');
  const topLevelBundleKey = result.s3BundleKey;
  const nestedBundleKey = getStringField(result.verificationResult, 's3BundleKey');
  const reportKey = getStringField(result.verificationResult, 's3ReportKey');
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
    (!scopedExecutionId || !matchesCanonicalArtifactKey(topLevelBundleKey, sessionId, scopedExecutionId, 'bundle.zip'))
  ) {
    return false;
  }

  if (nestedBundleKey !== undefined) {
    if (topLevelBundleKey !== nestedBundleKey) {
      return false;
    }
    if (
      !scopedExecutionId ||
      !matchesCanonicalArtifactKey(nestedBundleKey, sessionId, scopedExecutionId, 'bundle.zip')
    ) {
      return false;
    }
  }

  if (
    reportKey !== undefined &&
    (!scopedExecutionId || !matchesCanonicalArtifactKey(reportKey, sessionId, scopedExecutionId, 'verification.json'))
  ) {
    return false;
  }

  return true;
}
