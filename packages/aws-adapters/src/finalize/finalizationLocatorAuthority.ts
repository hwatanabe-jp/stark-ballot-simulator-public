import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import {
  buildFinalizationArtifactS3Keys,
  TARGET_PROOF_ARTIFACT_PREFIX,
} from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';

type ArtifactFileName = 'bundle.zip' | 'verification.json';

export interface FinalizationArtifactKeyIdentity {
  sessionId: string;
  finalizationId: string;
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
  const finalizationId = segments[segments.length - 2];
  if (!sessionId || !finalizationId) {
    return null;
  }
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(finalizationId)) {
    return null;
  }

  return { sessionId, finalizationId };
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
  finalizationId: string,
  artifact: ArtifactFileName,
): boolean {
  const expectedKeys = buildFinalizationArtifactS3Keys(sessionId, finalizationId);
  return key === (artifact === 'bundle.zip' ? expectedKeys.bundleS3Key : expectedKeys.reportS3Key);
}

export function hasConsistentFinalizationLocatorAuthority(
  sessionId: string,
  finalizationId: string,
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput,
): boolean {
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(finalizationId)) {
    return false;
  }

  if (
    deliveryMetadata?.s3BundleKey !== undefined &&
    !matchesCanonicalArtifactKey(deliveryMetadata.s3BundleKey, sessionId, finalizationId, 'bundle.zip')
  ) {
    return false;
  }

  if (
    deliveryMetadata?.s3ReportKey !== undefined &&
    !matchesCanonicalArtifactKey(deliveryMetadata.s3ReportKey, sessionId, finalizationId, 'verification.json')
  ) {
    return false;
  }

  return true;
}
