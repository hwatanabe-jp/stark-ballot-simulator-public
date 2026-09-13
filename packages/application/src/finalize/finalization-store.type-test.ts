import {
  buildFinalizationCommand,
  type FinalizationLifecycleStore,
  type FinalizationQueuedPayload,
  type FinalizationRunningPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type {
  FinalizationId,
  FinalizationResultAuthority,
} from '@stark-ballot/application/finalize/finalization-types';
import type { CapabilityToken, SessionId } from '@stark-ballot/domain/types/identifiers';

declare const store: FinalizationLifecycleStore;
declare const result: FinalizationResultAuthority;
declare const sessionId: SessionId;
declare const finalizationId: FinalizationId;
declare const capabilityToken: CapabilityToken;
declare const queuedPayload: FinalizationQueuedPayload;
declare const runningPayload: FinalizationRunningPayload;

buildFinalizationCommand(sessionId, 'queue', queuedPayload);
buildFinalizationCommand(sessionId, 'start', runningPayload);
// @ts-expect-error - start commands require a payload with startedAtMs.
buildFinalizationCommand(sessionId, 'start', queuedPayload);
// @ts-expect-error - success commands require result authority and completedAtMs.
buildFinalizationCommand(sessionId, 'succeed', runningPayload);
// @ts-expect-error - timeout commands require timeoutAtMs.
buildFinalizationCommand(sessionId, 'time_out', runningPayload);

// @ts-expect-error - session and finalization identifiers are different authorities.
const finalizationFromSession: FinalizationId = sessionId;
void finalizationFromSession;

// @ts-expect-error - finalization and session identifiers are different authorities.
const sessionFromFinalization: SessionId = finalizationId;
void sessionFromFinalization;

// @ts-expect-error - capability credentials cannot be used as finalization identifiers.
const finalizationFromCapability: FinalizationId = capabilityToken;
void finalizationFromCapability;

// @ts-expect-error - capability credentials cannot be used as session identifiers.
const sessionFromCapability: SessionId = capabilityToken;
void sessionFromCapability;

// @ts-expect-error - finalization identifiers cannot be used as capability credentials.
const capabilityFromFinalization: CapabilityToken = finalizationId;
void capabilityFromFinalization;

void store.markFinalizationRunning(sessionId, {
  finalizationId,
  queuedAtMs: 1,
  startedAtMs: 2,
  // @ts-expect-error AWS runtime metadata must stay out of pure application lifecycle payloads.
  stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
});

void store.markFinalizationSucceeded(sessionId, {
  finalizationId,
  queuedAtMs: 1,
  startedAtMs: 2,
  completedAtMs: 3,
  finalizationResult: result,
  // @ts-expect-error AWS bundle metadata must stay out of pure application lifecycle payloads.
  bundleMetadata: {
    s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
  },
});
