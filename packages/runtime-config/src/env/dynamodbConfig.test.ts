import { describe, expect, it } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { assertDynamoDbEndpointAllowed } from '@stark-ballot/runtime-config/env/dynamodbConfig';

describe('assertDynamoDbEndpointAllowed', () => {
  it('allows a loopback endpoint for the injected local profile', () => {
    expect(() =>
      assertDynamoDbEndpointAllowed(localRuntimeProfile(), {
        DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
      }),
    ).not.toThrow();
  });

  it('rejects a loopback endpoint for the injected target profile', () => {
    expect(() =>
      assertDynamoDbEndpointAllowed(targetRuntimeProfile(), {
        DYNAMODB_ENDPOINT: 'http://localhost:8000',
      }),
    ).toThrow('DYNAMODB_ENDPOINT is local/test-only and is not allowed by the selected runtime profile.');
  });
});
