import {
  PUBLIC_INPUT_SCHEMA,
  PUBLIC_INPUT_VERSION,
  type SupportedPublicInputArtifact,
} from '@stark-ballot/verification/public-input';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

export interface TestPublicInputArtifactOptions {
  source?: 'bundle' | 'generated';
  finalizationId?: string;
  bundleKey?: string;
  typedAuthority?: Partial<SupportedPublicInputArtifact['typedAuthority']>;
}

export function createTestPublicInputArtifact(
  options: TestPublicInputArtifactOptions = {},
): SupportedPublicInputArtifact {
  const source = options.source ?? 'generated';

  return {
    format: {
      schema: PUBLIC_INPUT_SCHEMA,
      version: PUBLIC_INPUT_VERSION,
    },
    provenance: {
      source,
      ...(options.finalizationId ? { finalizationId: options.finalizationId } : {}),
      ...(options.bundleKey ? { bundleKey: options.bundleKey } : {}),
    },
    typedAuthority: {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '0'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      votesCount: 1,
      uniqueIndices: true,
      uniqueCommitments: true,
      logId: '0x' + '2'.repeat(64),
      timestamp: 123,
      recomputedInputCommitment: '0x' + '3'.repeat(64),
      ...options.typedAuthority,
    },
  };
}
