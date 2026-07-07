import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  assertDynamoDbEndpointAllowed,
  requireDynamoDbRegion,
  resolveDynamoDbEndpoint,
  resolveDynamoDbRegion,
} from '@stark-ballot/runtime-config/env/dynamodbConfig';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface DynamoDocumentClientConfig {
  documentClient?: DynamoDBDocumentClient;
}

let sharedDocumentClient: DynamoDBDocumentClient | null = null;

export { assertDynamoDbEndpointAllowed, requireDynamoDbRegion, resolveDynamoDbEndpoint, resolveDynamoDbRegion };

export function getSharedDynamoDocumentClient(env: NodeJS.ProcessEnv = process.env): DynamoDBDocumentClient {
  if (sharedDocumentClient) {
    return sharedDocumentClient;
  }

  assertDynamoDbEndpointAllowed(env);
  const endpoint = resolveDynamoDbEndpoint(env);
  const client = new DynamoDBClient({
    region: requireDynamoDbRegion(env),
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
