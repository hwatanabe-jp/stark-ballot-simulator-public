import type {
  BundleDownloadFailedEvent,
  CanonicalEvent,
  FinalizeTransitionAttemptedEvent,
  QueuePublishEvent,
  VerificationRunSummaryEvent,
} from '@stark-ballot/diagnostics/canonicalEvents';

const attempted = {
  event: 'finalize_transition_attempted',
  to: 'pending',
  source: 'finalize',
  reason: 'FINALIZE_REQUESTED',
} satisfies FinalizeTransitionAttemptedEvent;
void attempted;

const guardRefusalAttempt = {
  event: 'finalize_transition_attempted',
  to: 'failed',
  source: 'cancel',
  reason: 'FINALIZATION_NOT_CANCELLABLE',
} satisfies FinalizeTransitionAttemptedEvent;
void guardRefusalAttempt;

const canonical = {
  event: 'bundle_download_failed',
  endpoint: 'report',
  http_status: 403,
  s3_error_code: 'access_denied',
  key_prefix: 'key_0123456789ab',
} satisfies CanonicalEvent;
void canonical;

const callerAttemptMustNotInferFrom: FinalizeTransitionAttemptedEvent = {
  event: 'finalize_transition_attempted',
  to: 'running',
  source: 'proof_dispatcher',
  reason: 'DISPATCH_REQUESTED',
  // @ts-expect-error Callers cannot supply an inferred prior finalization state.
  from: 'pending',
};
void callerAttemptMustNotInferFrom;

const callerRefusalMustNotInferFrom: FinalizeTransitionAttemptedEvent = {
  event: 'finalize_transition_attempted',
  to: 'running',
  source: 'proof_dispatcher',
  reason: 'STEP_FUNCTIONS_EXECUTION_CLOSED',
  // @ts-expect-error Caller refusals cannot supply an inferred prior finalization state.
  from: 'pending',
};
void callerRefusalMustNotInferFrom;

// @ts-expect-error Successful queue publication requires the bounded AWS message identifier.
const successfulQueuePublishWithoutMessageId: QueuePublishEvent = {
  event: 'queue_publish',
  queue: 'prover',
  result: 'succeeded',
};
void successfulQueuePublishWithoutMessageId;

const summaryWithUndeclaredField: VerificationRunSummaryEvent = {
  event: 'verification_run_summary',
  outcome: 'fully_verified',
  failure_category: 'none',
  scenario_id: 'S0',
  failed_required_count: 0,
  dev_mode_receipt: false,
  // @ts-expect-error Canonical event contracts reject fields not declared in the catalog.
  raw_checks: [],
};
void summaryWithUndeclaredField;

const bundleWithRawKey: BundleDownloadFailedEvent = {
  event: 'bundle_download_failed',
  endpoint: 'bundle',
  http_status: 404,
  s3_error_code: 'no_such_key',
  key_prefix: 'key_0123456789ab',
  // @ts-expect-error Full storage keys are forbidden from the canonical bundle event.
  s3_key: 'sessions/raw-session/bundle.zip',
};
void bundleWithRawKey;
