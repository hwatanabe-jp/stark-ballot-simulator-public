import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationWorkItem } from '@stark-ballot/application/finalize/finalization-work-item';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const executorMocks = vi.hoisted(() => ({
  getDefaultExecutor: vi.fn(() =>
    Promise.resolve({
      execute: vi.fn(),
      type: 'mock' as const,
      version: 'test',
    }),
  ),
}));
const queueMocks = vi.hoisted(() => ({
  publishProverWorkMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('@stark-ballot/node-adapters/zkvm/executor-factory', () => ({
  getDefaultExecutor: executorMocks.getDefaultExecutor,
}));
vi.mock('@stark-ballot/aws-adapters/sqs/publishProverWorkMessage', () => ({
  publishProverWorkMessage: queueMocks.publishProverWorkMessage,
}));

import { createFinalizationDependencies } from './finalizationDependencies';

describe('finalization runtime profile composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['local-demo', 'local-proof-development', 'local-proof-production'] as const)(
    'binds executor construction to the injected %s profile without legacy mode APIs',
    async (profileName) => {
      const profile = localRuntimeProfile(profileName);
      const dependencies = createFinalizationDependencies(profile);

      await dependencies.getExecutor();

      expect(executorMocks.getDefaultExecutor).toHaveBeenCalledWith(profile.proof);
      expect(dependencies).not.toHaveProperty('resolveZkvmMode');
      expect(dependencies).not.toHaveProperty('getZkvmModeViolation');
    },
  );

  it('binds the immutable target profile into prover queue publication', async () => {
    const profile = targetRuntimeProfile();
    const dependencies = createFinalizationDependencies(profile);
    const workItem = {
      inputSource: 's3',
      sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
      finalizationId: asFinalizationId('FINALIZATION123'),
      queuedAtMs: 1_700_000_000_000,
      expectedImageId: `0x${'1'.repeat(64)}`,
      scenarios: [],
      simulateTampering: false,
      scenarioContext: {
        scenarios: [],
        tamperMode: 'none',
        claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        claimedTotalVotes: 1,
        summary: {
          ignoredCount: 0,
          recountedCount: 0,
          userRecountChoice: null,
        },
      },
    } satisfies FinalizationWorkItem;

    await dependencies.finalizationQueue.publish(workItem, 1);

    expect(queueMocks.publishProverWorkMessage).toHaveBeenCalledWith(profile, workItem);
  });
});
