import { assertSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

export const TARGET_PROOF_ARTIFACT_PREFIX = 'sessions/';

declare const awsS3KeyBrand: unique symbol;

export type S3Key = string & {
  readonly [awsS3KeyBrand]: 'S3Key';
};

export interface FinalizationArtifactS3Keys {
  inputS3Key: S3Key;
  outputS3Prefix: S3Key;
  bundleS3Key: S3Key;
  reportS3Key: S3Key;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

export function asS3Key(value: string): S3Key {
  if (value.length === 0) {
    throw new Error('s3Key must not be empty');
  }
  if (value.startsWith('/') || value.includes('//')) {
    throw new Error('s3Key must be a relative object key');
  }
  return value as S3Key;
}

export function buildFinalizationArtifactS3Keys(
  sessionId: string,
  finalizationId: string,
  prefix = TARGET_PROOF_ARTIFACT_PREFIX,
): FinalizationArtifactS3Keys {
  assertSafeVerifierSegment(sessionId, 'sessionId');
  assertSafeVerifierSegment(finalizationId, 'finalizationId');

  const baseKey = `${normalizePrefix(prefix)}${sessionId}/${finalizationId}`;
  return {
    inputS3Key: asS3Key(`${baseKey}/input.json`),
    outputS3Prefix: asS3Key(baseKey),
    bundleS3Key: asS3Key(`${baseKey}/bundle.zip`),
    reportS3Key: asS3Key(`${baseKey}/verification.json`),
  };
}
