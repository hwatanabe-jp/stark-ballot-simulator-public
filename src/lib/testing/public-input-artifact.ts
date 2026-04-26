import { resolveCurrentContractGeneration } from '@/lib/contract';
import type { SupportedPublicInputArtifact } from '@/lib/verification/public-input-contract';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

export interface TestPublicInputArtifactOptions {
  contractGeneration?: string;
  source?: 'bundle' | 'generated';
  executionId?: string;
  bundleKey?: string;
  typedAuthority?: Partial<SupportedPublicInputArtifact['typedAuthority']>;
}

export function createTestPublicInputArtifact(
  options: TestPublicInputArtifactOptions = {},
): SupportedPublicInputArtifact {
  const source = options.source ?? 'generated';

  return {
    compatibilityMarker: {
      schema: 'stark-ballot.public_input',
      version: '1.1',
      contractGeneration: options.contractGeneration ?? resolveCurrentContractGeneration(),
    },
    provenance: {
      source,
      ...(options.executionId ? { executionId: options.executionId } : {}),
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
