import fs from 'node:fs';
import path from 'node:path';

export type VerifierLayerAssetPaths = {
  assetPath: string;
  binaryPath: string;
};

/**
 * Resolves the generated verifier Lambda layer paths relative to the repository root.
 */
export function resolveVerifierLayerAssetPaths(rootDir: string = process.cwd()): VerifierLayerAssetPaths {
  const assetPath = path.resolve(rootDir, 'verifier-service', 'lambda-layer');
  const binaryPath = path.join(assetPath, 'bin', 'verifier-service');

  return {
    assetPath,
    binaryPath,
  };
}

/**
 * Ensures the generated verifier Lambda layer binary exists before Amplify packages the asset.
 */
export function assertVerifierLayerBinaryExists(rootDir: string = process.cwd()): VerifierLayerAssetPaths {
  const assetPaths = resolveVerifierLayerAssetPaths(rootDir);

  if (!fs.existsSync(assetPaths.binaryPath)) {
    throw new Error(
      `Missing generated verifier layer binary at ${assetPaths.binaryPath}. Run ./verifier-service/scripts/build-lambda-layer.sh before deploying the Amplify backend.`,
    );
  }

  return assetPaths;
}
