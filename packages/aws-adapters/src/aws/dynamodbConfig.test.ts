import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const dynamoClientMocks = vi.hoisted(() => ({
  configs: [] as unknown[],
  documentClient: {},
  from: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor(config: unknown) {
      dynamoClientMocks.configs.push(config);
    }
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: dynamoClientMocks.from,
  },
}));

import {
  getSharedDynamoDocumentClient,
  resetSharedDynamoDocumentClientForTests,
} from '@stark-ballot/aws-adapters/aws/dynamodbConfig';

describe('getSharedDynamoDocumentClient', () => {
  afterEach(() => {
    resetSharedDynamoDocumentClientForTests();
    vi.clearAllMocks();
    dynamoClientMocks.configs.length = 0;
  });

  it('derives the target client region from the immutable profile', () => {
    const profile = targetRuntimeProfile();
    if (profile.external.kind !== 'aws') {
      throw new Error('Expected target runtime profile');
    }
    dynamoClientMocks.from.mockReturnValue(dynamoClientMocks.documentClient);

    getSharedDynamoDocumentClient(profile, { AWS_REGION: 'us-east-1' });

    expect(dynamoClientMocks.configs).toEqual([{ region: profile.external.region }]);
  });

  it('retains validated environment configuration for the local endpoint test path', () => {
    dynamoClientMocks.from.mockReturnValue(dynamoClientMocks.documentClient);

    getSharedDynamoDocumentClient(localRuntimeProfile(), {
      AWS_REGION: 'ap-northeast-1',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
    });

    expect(dynamoClientMocks.configs).toEqual([
      {
        region: 'ap-northeast-1',
        endpoint: 'http://127.0.0.1:8000',
        credentials: {
          accessKeyId: 'local',
          secretAccessKey: 'local',
        },
      },
    ]);
  });
});
