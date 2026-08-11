import path from 'node:path';
import { ARTIFACT_DELIVERY_LIMITS, type ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import { createS3ArtifactReader } from '@stark-ballot/aws-adapters/aws/s3-artifact-reader';
import { createLocalArtifactReader } from '@stark-ballot/node-adapters/artifact-reader';
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';

export interface ArtifactDeliveryDependencies {
  artifactReader: ArtifactReader;
}

export type ArtifactDeliveryDependencyOverrides = Partial<ArtifactDeliveryDependencies>;

function resolveLocalArtifactBaseDir(): string {
  const configured = process.env['VERIFIER_WORK_DIR']?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function createDefaultArtifactReader(profile: ResolvedRuntimeProfile): ArtifactReader {
  if (isTargetAwsRuntime(profile)) {
    return createS3ArtifactReader({
      limits: ARTIFACT_DELIVERY_LIMITS,
      profile,
    });
  }

  return createLocalArtifactReader({
    baseDir: resolveLocalArtifactBaseDir(),
    bundlePolicy: resolvePublicBundlePolicy('sync'),
    limits: ARTIFACT_DELIVERY_LIMITS,
  });
}

export function createArtifactDeliveryDependencies(
  profile: ResolvedRuntimeProfile,
  overrides: ArtifactDeliveryDependencyOverrides = {},
): ArtifactDeliveryDependencies {
  return {
    artifactReader: overrides.artifactReader ?? createDefaultArtifactReader(profile),
  };
}
