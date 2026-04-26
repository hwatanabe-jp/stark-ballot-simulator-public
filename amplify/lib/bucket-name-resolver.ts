/**
 * Resolves proof bundle bucket name from environment variables
 * @param env - Environment variables (defaults to process.env)
 * @returns Resolved bucket name
 */
export function resolveProofBundleBucketName(env: NodeJS.ProcessEnv = process.env): string {
  const DEFAULT_PROOF_BUNDLE_BUCKET = 'stark-ballot-simulator-proof-bundles-develop';
  return env.S3_PROOF_BUCKET ?? DEFAULT_PROOF_BUNDLE_BUCKET;
}
