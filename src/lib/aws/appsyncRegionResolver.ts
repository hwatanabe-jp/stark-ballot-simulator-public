/**
 * Resolve AppSync region from environment variables or endpoint hostname.
 */
export function resolveAppSyncRegion(endpointUrl: URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitRegion = env.AMPLIFY_DATA_REGION ?? env.AWS_REGION;
  if (explicitRegion && explicitRegion.length > 0) {
    return explicitRegion;
  }

  const match = endpointUrl.hostname.match(/\.appsync(?:-realtime)?-api\.([a-z0-9-]+)\.amazonaws\.com$/i);
  return match?.[1];
}
