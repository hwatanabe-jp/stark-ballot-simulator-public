import { describe, expect, it } from 'vitest';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import {
  buildPublicInputArtifactFromZkvmInput,
  parsePublicInputArtifact,
} from '@/lib/verification/public-input-contract';

const baseInput: ZkVMInput = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: getDefaultElectionConfigHash(),
  bulletinRoot: `0x${'1'.repeat(64)}`,
  treeSize: 1,
  totalExpected: 1,
  logId: `0x${'2'.repeat(64)}`,
  timestamp: 123,
  votes: [
    {
      index: 0,
      choice: 0,
      random: `0x${'3'.repeat(64)}`,
      commitment: `0x${'4'.repeat(64)}`,
      merklePath: [],
    },
  ],
};

describe('public-input contract', () => {
  it('separates typed authority, compatibility marker, and provenance', () => {
    const artifact = buildPublicInputArtifactFromZkvmInput(
      baseInput,
      CURRENT_METHOD_VERSION,
      resolveCurrentContractGeneration(),
    );
    const parsed = parsePublicInputArtifact(artifact, {
      source: 'generated',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(artifact.votes[0]).not.toHaveProperty('choice');
    expect(artifact.votes[0]).not.toHaveProperty('random');

    expect(parsed.valid).toBe(true);
    expect(parsed.compatibilityMarker).toEqual({
      schema: 'stark-ballot.public_input',
      version: '1.1',
      contractGeneration: resolveCurrentContractGeneration(),
    });
    expect(parsed.provenance).toEqual({
      source: 'generated',
      executionId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });
    expect(parsed.typedAuthority).toMatchObject({
      electionId: baseInput.electionId,
      electionConfigHash: baseInput.electionConfigHash,
      methodVersion: CURRENT_METHOD_VERSION,
      bulletinRoot: baseInput.bulletinRoot,
      treeSize: baseInput.treeSize,
      totalExpected: baseInput.totalExpected,
      votesCount: 1,
      uniqueIndices: true,
      uniqueCommitments: true,
      logId: baseInput.logId,
      timestamp: baseInput.timestamp,
    });
    expect(typeof parsed.typedAuthority?.recomputedInputCommitment).toBe('string');
    expect(parsed.typedAuthority).not.toHaveProperty('contractGeneration');

    expect(parsed.typedAuthority?.votesCount).toBe(1);
  });

  it('keeps contractGeneration as a compatibility-only marker', () => {
    const artifact = {
      ...buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION, '2026-04-zkvm-current-v2'),
      contractGeneration: '2026-04-zkvm-current-v2',
    };

    const parsed = parsePublicInputArtifact(artifact, {
      source: 'bundle',
      executionId: 'exec-2',
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.compatibilityMarker.contractGeneration).toBe('2026-04-zkvm-current-v2');
    expect(parsed.typedAuthority).toBeDefined();
    expect(parsed.typedAuthority).not.toHaveProperty('contractGeneration');
  });

  it('retains compatibility markers when the artifact becomes unsupported', () => {
    const parsed = parsePublicInputArtifact({
      ...buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION, resolveCurrentContractGeneration()),
      version: '0.9',
    });

    expect(parsed.valid).toBe(false);
    expect(parsed.compatibilityMarker).toEqual({
      schema: 'stark-ballot.public_input',
      version: '0.9',
      contractGeneration: resolveCurrentContractGeneration(),
    });
    expect(parsed.observed.electionId).toBe(baseInput.electionId);
    expect(parsed.typedAuthority).toBeUndefined();
    expect(parsed.errors).toContain('version');
  });
});
