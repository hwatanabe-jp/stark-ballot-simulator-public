import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';

const constructorMocks = vi.hoisted(() => ({
  validateEnv: vi.fn(),
  memory: vi.fn(),
  file: vi.fn(),
  dynamo: vi.fn(),
  documentClient: {},
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: constructorMocks.validateEnv,
}));

vi.mock('@stark-ballot/aws-adapters/aws/dynamodbConfig', () => ({
  getSharedDynamoDocumentClient: vi.fn(() => constructorMocks.documentClient),
}));

vi.mock('./mockSessionStore', () => ({
  MockSessionStore: class {
    constructor() {
      constructorMocks.memory();
    }
  },
}));

vi.mock('./fileMockSessionStore', () => ({
  FileMockSessionStore: class {
    constructor() {
      constructorMocks.file();
    }
  },
}));

vi.mock('./dynamoSessionStore', () => ({
  DynamoSessionStore: class {
    constructor(config: unknown) {
      constructorMocks.dynamo(config);
    }
  },
}));

import { getGlobalStore, resetGlobalStore } from './storeInstance';

describe('global store runtime profile selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGlobalStore();
  });

  it.each([
    ['local-demo', 'memory'],
    ['static-mock-e2e', 'file'],
    ['target-aws-async', 'dynamo'],
  ] as const)('selects %s from the injected profile', (profileName, expected) => {
    const profile = profileName === 'target-aws-async' ? targetRuntimeProfile() : localRuntimeProfile(profileName);

    getGlobalStore(profile);

    expect(constructorMocks[expected]).toHaveBeenCalledOnce();
    expect(constructorMocks.validateEnv).toHaveBeenCalledWith(profile);
  });

  it('injects target profile table identifiers into the Dynamo store', () => {
    const profile = targetRuntimeProfile();

    getGlobalStore(profile);

    if (profile.external.kind !== 'aws') {
      throw new Error('Expected target runtime profile');
    }
    expect(constructorMocks.dynamo).toHaveBeenCalledWith({
      documentClient: constructorMocks.documentClient,
      sessionsTableName: profile.external.dynamo.sessionsTable,
      votesTableName: profile.external.dynamo.votesTable,
    });
  });
});
