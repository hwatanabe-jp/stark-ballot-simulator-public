import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';

declare const store: FinalizationLifecycleStore;
declare const result: FinalizationResultAuthority;

void store.markFinalizationRunning('session-1', {
  executionId: 'exec-1',
  queuedAt: 1,
  contractGeneration: 'contract-generation',
  startedAt: 2,
  // @ts-expect-error AWS runtime metadata must stay out of pure application lifecycle payloads.
  stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
});

void store.markFinalizationSucceeded('session-1', {
  executionId: 'exec-1',
  queuedAt: 1,
  contractGeneration: 'contract-generation',
  startedAt: 2,
  completedAt: 3,
  finalizationResult: result,
  // @ts-expect-error AWS bundle metadata must stay out of pure application lifecycle payloads.
  bundleMetadata: {
    s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
  },
});
