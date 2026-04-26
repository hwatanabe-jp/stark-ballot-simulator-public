import * as ecr from "@aws-sdk/client-ecr";

const { ECRClient, DescribeImageSigningStatusCommand } = ecr.default ?? ecr;

const client = new ECRClient({});

export const handler = async (event) => {
  const repositoryName = event?.repositoryName;
  const imageDigest = event?.imageDigest;

  if (typeof repositoryName !== "string" || repositoryName.length === 0) {
    throw new Error("repositoryName is required");
  }
  if (typeof imageDigest !== "string" || !imageDigest.startsWith("sha256:")) {
    throw new Error("imageDigest is required and must start with sha256:");
  }

  const response = await client.send(
    new DescribeImageSigningStatusCommand({
      repositoryName,
      imageId: {
        imageDigest,
      },
    })
  );

  const status = response?.signingStatuses?.[0]?.status ?? "MISSING";

  return {
    status,
    signingStatuses: response?.signingStatuses ?? [],
  };
};
