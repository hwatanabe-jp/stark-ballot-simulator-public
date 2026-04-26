import { describe, expect, it } from 'vitest';
import {
  isRecoverableCurrentLiveSession,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
  resolveSessionFinalizationArtifactState,
} from '@/lib/contract';

describe('currentArtifact boundary helpers', () => {
  it('returns null when a live session has no persisted finalization branch', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
      }),
    ).toBeNull();
  });

  it('classifies a non-finalized running branch by wrapper generation', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationState: {
          status: 'running',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
        },
      }),
    ).toBe('unsupported_current_artifact');
  });

  it('fails closed when a persisted branch is generation-less even if the session generation is current', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'pending',
          executionId: 'exec-1',
          queuedAt: 1,
        },
      }),
    ).toBe('corrupt_or_unreadable');
  });

  it('classifies an unreadable stale finalized wrapper as unsupported_current_artifact when its generation is known', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: true,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: '2026-04-zkvm-current-v2',
      }),
    ).toBe('unsupported_current_artifact');
  });

  it('fails closed when a current finalized wrapper has no authoritative finalization result', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: true,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
          completedAt: 3,
        },
      }),
    ).toBe('corrupt_or_unreadable');
  });

  it('fails closed when a current finalized wrapper is missing the top-level verificationExecutionId', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: true,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
          completedAt: 3,
        },
        finalizationResult: {
          journal: { methodVersion: 12 },
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
          },
        },
      }),
    ).toBe('corrupt_or_unreadable');
  });

  it('fails closed when a current finalized wrapper has an unsafe top-level verificationExecutionId', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: true,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
          completedAt: 3,
        },
        finalizationResult: {
          journal: { methodVersion: 12 },
          verificationExecutionId: '../exec-1',
          verificationResult: {
            status: 'success',
            executionId: 'exec-1',
          },
        },
      }),
    ).toBe('corrupt_or_unreadable');
  });

  it('keeps a current running wrapper recoverable before a final result exists', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'running',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
        },
      }),
    ).toBe('supported');
  });

  it('fails closed when an unreadable persisted wrapper is tracked only by explicit branch presence', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        hasPersistedFinalizationBranch: true,
        contractGeneration: resolveCurrentContractGeneration(),
      }),
    ).toBe('corrupt_or_unreadable');

    expect(
      resolveAuthoritativeWriteContractGeneration({
        finalized: false,
        hasPersistedFinalizationBranch: true,
        contractGeneration: resolveCurrentContractGeneration(),
      }),
    ).toBeUndefined();
  });

  it('preserves explicit stale-current failure markers without repairing wrapper generation', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'failed',
          executionId: 'exec-1',
          queuedAt: 1,
          failedAt: 2,
          error: {
            code: 'UNSUPPORTED_CURRENT_ARTIFACT',
            message: 'stale execution',
          },
        },
      }),
    ).toBe('unsupported_current_artifact');
  });

  it('ignores persisted supported markers and re-classifies from the wrapper boundary', () => {
    expect(
      resolveSessionFinalizationArtifactState({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationArtifactState: 'supported',
        finalizationState: {
          status: 'running',
          executionId: 'exec-1',
          queuedAt: 1,
          startedAt: 2,
        },
      }),
    ).toBe('unsupported_current_artifact');
  });

  it('uses the live session generation only before a finalization branch exists', () => {
    expect(
      resolveAuthoritativeWriteContractGeneration({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
      }),
    ).toBe(resolveCurrentContractGeneration());

    expect(
      resolveAuthoritativeWriteContractGeneration({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationState: {
          status: 'pending',
          executionId: 'exec-1',
          queuedAt: 1,
        },
      }),
    ).toBe('stale-contract-generation');
  });

  it('treats fail-closed live records as non-recoverable for admission control', () => {
    expect(
      isRecoverableCurrentLiveSession({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
      }),
    ).toBe(true);

    expect(
      isRecoverableCurrentLiveSession({
        finalized: false,
        contractGeneration: 'stale-contract-generation',
      }),
    ).toBe(false);

    expect(
      isRecoverableCurrentLiveSession({
        finalized: false,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationArtifactState: 'corrupt_or_unreadable',
      }),
    ).toBe(false);
  });
});
