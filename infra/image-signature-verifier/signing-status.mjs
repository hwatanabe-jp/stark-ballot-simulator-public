import * as ecr from '@aws-sdk/client-ecr';

const { DescribeImageSigningStatusCommand, ECRClient } = ecr;

export function createEcrSigningStatusLookup() {
  /** @type {Map<string, InstanceType<typeof ECRClient>>} */
  const clients = new Map();
  /**
   * @param {{
   *   imageRegion: string;
   *   registryId: string;
   *   repositoryName: string;
   *   imageDigest: string;
   * }} invocation
   * @param {AbortSignal} abortSignal
   */
  return async (invocation, abortSignal) => {
    let client = clients.get(invocation.imageRegion);
    if (!client) {
      client = new ECRClient({ region: invocation.imageRegion });
      clients.set(invocation.imageRegion, client);
    }
    const response = await client.send(
      new DescribeImageSigningStatusCommand({
        registryId: invocation.registryId,
        repositoryName: invocation.repositoryName,
        imageId: { imageDigest: invocation.imageDigest },
      }),
      { abortSignal },
    );
    return response.signingStatuses;
  };
}
