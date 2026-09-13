import { describe, expect, it } from 'vitest';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { getDefaultElectionConfigHash } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import {
  buildPublicInputArtifactFromZkvmInput,
  buildSupportedPublicInputArtifactFromZkvmInput,
  parsePublicInputArtifact,
  parseStoredPublicInputArtifact,
  parseSupportedPublicInputArtifact,
  toSupportedPublicInputArtifact,
} from '@stark-ballot/verification/public-input';

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
  it('gives generated artifacts a source that survives the stored representation', () => {
    const artifact = buildSupportedPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION);
    const persisted: unknown = JSON.parse(JSON.stringify(artifact));

    expect(artifact.provenance).toEqual({ source: 'generated' });
    expect(parseStoredPublicInputArtifact(persisted)).toEqual(artifact);
  });

  it('preserves bundle provenance when admitting and storing an external artifact', () => {
    const artifact = parseSupportedPublicInputArtifact(
      buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION),
      { source: 'bundle', finalizationId: 'finalization-1', bundleKey: 'sessions/session-1/bundle.zip' },
    );
    const persisted: unknown = JSON.parse(JSON.stringify(artifact));

    expect(artifact?.provenance).toEqual({
      source: 'bundle',
      finalizationId: 'finalization-1',
      bundleKey: 'sessions/session-1/bundle.zip',
    });
    expect(parseStoredPublicInputArtifact(persisted)).toEqual(artifact);
  });

  it('keeps observations without a source outside supported artifact authority', () => {
    const parsed = parsePublicInputArtifact(buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION));

    expect(parsed.valid).toBe(true);
    expect(parsed.typedAuthority).toBeDefined();
    expect(toSupportedPublicInputArtifact(parsed)).toBeUndefined();
  });

  it('separates the governed artifact format, typed authority, and provenance', () => {
    const artifact = buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION);
    const parsed = parsePublicInputArtifact(artifact, {
      source: 'generated',
      finalizationId: 'exec-1',
      bundleKey: 'sessions/session-1/exec-1/bundle.zip',
    });

    expect(artifact.votes[0]).not.toHaveProperty('choice');
    expect(artifact.votes[0]).not.toHaveProperty('random');
    expect(artifact).not.toHaveProperty('contractGeneration');

    expect(parsed.valid).toBe(true);
    expect(parsed.format).toEqual({
      schema: 'stark-ballot.public_input',
      version: '1.1',
    });
    expect(parsed.provenance).toEqual({
      source: 'generated',
      finalizationId: 'exec-1',
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

  it('rejects the retired repository-owned generation marker', () => {
    const artifact = buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION);

    const parsed = parsePublicInputArtifact(
      {
        ...artifact,
        contractGeneration: 'retired-generation',
      },
      {
        source: 'bundle',
        finalizationId: 'exec-2',
      },
    );

    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain('unexpected_key:contractGeneration');
    expect(parsed.typedAuthority).toBeUndefined();
  });

  it('retains observed governed format when the artifact is unsupported', () => {
    const parsed = parsePublicInputArtifact({
      ...buildPublicInputArtifactFromZkvmInput(baseInput, CURRENT_METHOD_VERSION),
      version: '0.9',
    });

    expect(parsed.valid).toBe(false);
    expect(parsed.format).toEqual({
      schema: 'stark-ballot.public_input',
      version: '0.9',
    });
    expect(parsed.observed.electionId).toBe(baseInput.electionId);
    expect(parsed.typedAuthority).toBeUndefined();
    expect(parsed.errors).toContain('version');
  });
});
