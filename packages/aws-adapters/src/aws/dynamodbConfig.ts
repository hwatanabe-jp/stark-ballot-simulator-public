import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  assertDynamoDbEndpointAllowed,
  requireDynamoDbRegion,
  resolveDynamoDbEndpoint,
} from '@stark-ballot/runtime-config/env/dynamodbConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

let sharedDocumentClient: DynamoDBDocumentClient | null = null;

export function getSharedDynamoDocumentClient(
  profile: ResolvedRuntimeProfile,
  env: NodeJS.ProcessEnv = process.env,
): DynamoDBDocumentClient {
  if (sharedDocumentClient) {
    return sharedDocumentClient;
  }

  const endpoint = resolveDynamoDbEndpoint(env);
  if (endpoint) {
    assertDynamoDbEndpointAllowed(profile, env);
  }
  if (profile.external.kind !== 'aws' && !endpoint) {
    throw new Error('DynamoDB client construction requires a target AWS profile or a validated local endpoint.');
  }
  const client = new DynamoDBClient({
    region: profile.external.kind === 'aws' ? profile.external.region : requireDynamoDbRegion(env),
    ...omitUndefinedProperties({
      endpoint,
      credentials: endpoint
        ? {
            accessKeyId: 'local',
            secretAccessKey: 'local',
          }
        : undefined,
    }),
  });

  sharedDocumentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  return sharedDocumentClient;
}

export function resetSharedDynamoDocumentClientForTests(): void {
  sharedDocumentClient = null;
}

export function setSharedDynamoDocumentClientForTests(documentClient: DynamoDBDocumentClient): void {
  sharedDocumentClient = documentClient;
}
