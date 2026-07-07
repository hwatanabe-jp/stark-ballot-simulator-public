import * as ecr from '@aws-sdk/client-ecr';

const { ECRClient, DescribeImageSigningStatusCommand } = ecr;

/**
 * @param {unknown} event
 */
export const handler = async (event) => {
  const record = typeof event === 'object' && event !== null ? /** @type {Record<string, unknown>} */ (event) : {};
  const imageUri = record['imageUri'];
  const registryId = record['registryId'];
  const imageRegion = record['imageRegion'];
  const repositoryName = record['repositoryName'];
  const imageDigest = record['imageDigest'];

  if (typeof imageUri !== 'string' || imageUri.length === 0) {
    throw new Error('imageUri is required');
  }
  if (typeof registryId !== 'string' || !/^[0-9]{12}$/.test(registryId)) {
    throw new Error('registryId is required and must be a 12-digit AWS account ID');
  }
  if (typeof imageRegion !== 'string' || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(imageRegion)) {
    throw new Error('imageRegion is required and must be an AWS region');
  }
  if (typeof repositoryName !== 'string' || repositoryName.length === 0) {
    throw new Error('repositoryName is required');
  }
  if (typeof imageDigest !== 'string' || !imageDigest.startsWith('sha256:')) {
    throw new Error('imageDigest is required and must start with sha256:');
  }
  const expectedImageUri = `${registryId}.dkr.ecr.${imageRegion}.amazonaws.com/${repositoryName}@${imageDigest}`;
  if (imageUri !== expectedImageUri) {
    throw new Error('imageUri must match registryId, imageRegion, repositoryName, and imageDigest');
  }

  const client = new ECRClient({ region: imageRegion });
  const response = await client.send(
    new DescribeImageSigningStatusCommand({
      registryId,
      repositoryName,
      imageId: {
        imageDigest,
      },
    }),
  );

  const status = response?.signingStatuses?.[0]?.status ?? 'MISSING';

  return {
    status,
    signingStatuses: response?.signingStatuses ?? [],
  };
};
