import { logger } from './logger';

export const FINALIZATION_STATES = ['pending', 'running', 'succeeded', 'failed', 'timeout'] as const;
export type FinalizationEventState = (typeof FINALIZATION_STATES)[number];

export const FINALIZATION_FROM_STATES = ['none', ...FINALIZATION_STATES] as const;
export type FinalizationEventFromState = (typeof FINALIZATION_FROM_STATES)[number];

export const FINALIZATION_SOURCES = ['finalize', 'proof_dispatcher', 'writer_update', 'reconcile', 'cancel'] as const;
export type FinalizationEventSource = (typeof FINALIZATION_SOURCES)[number];

export const FINALIZATION_REASONS = [
  'FINALIZE_REQUESTED',
  'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
  'PROVER_INPUT_UPLOAD_FAILED',
  'SQS_PUBLISH_FAILED',
  'DISPATCH_REQUESTED',
  'STEP_FUNCTIONS_EXECUTION_CLOSED',
  'STEP_FUNCTIONS_DISPATCH',
  'RUNTIME_UPDATE_RECEIVED',
  'FINALIZATION_RESULT_INVALID',
  'FINALIZATION_DISPATCH_TIMEOUT',
  'FINALIZATION_OUTCOME_UNRECORDED',
  'EXECUTION_TIMED_OUT',
  'USER_CANCELLED',
  'FINALIZATION_NOT_CANCELLABLE',
  'STATE_PERSISTED',
  'IDEMPOTENT_RETRY',
  'EXECUTION_MISMATCH',
  'TERMINAL_STATE_STICKY',
  'INVALID_FINALIZATION_ARTIFACT',
  'CONDITIONAL_WRITE_CONFLICT',
  'FINALIZATION_FAILED',
  'FINALIZATION_BUNDLE_KEY_MISSING',
  'FINALIZATION_BUNDLE_RESTORE_FAILED',
  'PROVER_TASK_FAILED',
  'PROVER_IMAGE_SIGNATURE_FAILED',
  'PROVER_CAPACITY_WAIT_TIMEOUT',
  'PROVER_EXECUTION_ABORTED',
  'PROVER_EXECUTION_FAILED',
] as const;
export type FinalizationEventReason = (typeof FINALIZATION_REASONS)[number];

export const FINALIZATION_SLI_EXPECTED_DOMAIN_REASONS = [
  'FINALIZATION_RESULT_INVALID',
  'USER_CANCELLED',
  'INVALID_FINALIZATION_ARTIFACT',
] as const satisfies readonly FinalizationEventReason[];

export interface FinalizationTransitionMetadata {
  source: FinalizationEventSource;
  reason: FinalizationEventReason;
}

export const DISPATCH_DROP_REASONS = [
  'session_missing',
  'not_pending',
  'already_dispatched',
  'already_processed',
  'malformed',
] as const;
export type DispatchDropReason = (typeof DISPATCH_DROP_REASONS)[number];

export const FINALIZATION_UPDATE_TRANSPORTS = ['direct_writer', 'http_callback'] as const;
export type FinalizationUpdateTransport = (typeof FINALIZATION_UPDATE_TRANSPORTS)[number];

export const FINALIZATION_AUTH_RESULTS = ['not_applicable', 'not_checked', 'failed', 'passed'] as const;
export type FinalizationAuthResult = (typeof FINALIZATION_AUTH_RESULTS)[number];

export const FINALIZATION_UPDATE_OUTCOMES = [
  'applied',
  'payload_invalid',
  'secret_unavailable',
  'signature_headers_missing',
  'body_limit_invalid',
  'payload_too_large',
  'payload_read_failed',
  'timestamp_invalid',
  'skew_config_invalid',
  'timestamp_out_of_range',
  'signature_invalid',
  'transition_store_unavailable',
  'artifact_rejected',
  'handler_unavailable',
  'canonical_result_missing',
  'application_failed',
] as const;
export type FinalizationUpdateOutcome = (typeof FINALIZATION_UPDATE_OUTCOMES)[number];

export const QUEUE_NAMES = ['prover', 'verification'] as const;
export type CanonicalQueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_PUBLISH_RESULTS = ['succeeded', 'failed'] as const;
export type QueuePublishResult = (typeof QUEUE_PUBLISH_RESULTS)[number];

export const VERIFICATION_OUTCOMES = [
  'fully_verified',
  'demo_only',
  'in_progress',
  'missing_evidence',
  'verified_with_limitations',
  'user_vote_excluded',
  'votes_excluded',
  'votes_excluded_unknown',
  'recorded_integrity_failed',
  'published_tally_mismatch',
  'counted_integrity_failed',
  'cast_integrity_failed',
  'proof_verification_failed',
] as const;
export type VerificationRunOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const VERIFICATION_FAILURE_CATEGORIES = [
  'none',
  'verifier_crash',
  'corrupt_bundle',
  's3_denied',
  's3_missing',
  'timeout',
  'unknown',
] as const;
export type VerificationFailureCategory = (typeof VERIFICATION_FAILURE_CATEGORIES)[number];

export const SCENARIO_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type CanonicalScenarioId = (typeof SCENARIO_IDS)[number];

export const BUNDLE_DOWNLOAD_ENDPOINTS = ['bundle', 'report'] as const;
export type BundleDownloadEndpoint = (typeof BUNDLE_DOWNLOAD_ENDPOINTS)[number];

export const BUNDLE_DOWNLOAD_S3_ERROR_CODES = [
  'not_applicable',
  'no_such_key',
  'access_denied',
  'timeout',
  'throttled',
  'unknown',
] as const;
export type BundleDownloadS3ErrorCode = (typeof BUNDLE_DOWNLOAD_S3_ERROR_CODES)[number];

interface FinalizationCorrelationFields {
  session_id_hash?: string;
  finalization_id?: string;
}

export interface FinalizationAdmittedEvent {
  event: 'finalization_admitted';
  finalization_id: string;
}

export interface FinalizeTransitionAttemptedEvent extends FinalizationCorrelationFields {
  event: 'finalize_transition_attempted';
  to: FinalizationEventState;
  source: FinalizationEventSource;
  reason: FinalizationEventReason;
}

export interface FinalizeStateUpdateRejectedEvent extends FinalizationCorrelationFields {
  event: 'finalize_state_update_rejected';
  to: FinalizationEventState;
  source: FinalizationEventSource;
  reason: FinalizationEventReason;
}

export interface FinalizeStateTransitionEvent extends FinalizationCorrelationFields {
  event: 'finalize_state_transition';
  from: FinalizationEventFromState;
  to: FinalizationEventState;
  source: FinalizationEventSource;
  reason: FinalizationEventReason;
  changed: boolean;
}

export interface DispatchDroppedEvent extends FinalizationCorrelationFields {
  event: 'dispatch_dropped';
  reason: DispatchDropReason;
}

export interface FinalizationUpdateReceivedEvent extends FinalizationCorrelationFields {
  event: 'finalization_update_received';
  transport: FinalizationUpdateTransport;
  auth_result: FinalizationAuthResult;
  outcome_code: FinalizationUpdateOutcome;
}

interface QueuePublishEventBase extends FinalizationCorrelationFields {
  event: 'queue_publish';
  queue: CanonicalQueueName;
}

export type QueuePublishEvent =
  | (QueuePublishEventBase & {
      result: 'succeeded';
      sqs_message_id: string;
    })
  | (QueuePublishEventBase & {
      result: 'failed';
      sqs_message_id?: never;
    });

export interface VerificationRunSummaryEvent extends FinalizationCorrelationFields {
  event: 'verification_run_summary';
  outcome: VerificationRunOutcome;
  failure_category: VerificationFailureCategory;
  scenario_id: CanonicalScenarioId;
  failed_required_count: number;
  dev_mode_receipt: boolean;
}

export interface BundleDownloadFailedEvent extends FinalizationCorrelationFields {
  event: 'bundle_download_failed';
  endpoint: BundleDownloadEndpoint;
  http_status: number;
  s3_error_code: BundleDownloadS3ErrorCode;
  key_prefix: string;
}

export type CanonicalEvent =
  | FinalizationAdmittedEvent
  | FinalizeTransitionAttemptedEvent
  | FinalizeStateUpdateRejectedEvent
  | FinalizeStateTransitionEvent
  | DispatchDroppedEvent
  | FinalizationUpdateReceivedEvent
  | QueuePublishEvent
  | VerificationRunSummaryEvent
  | BundleDownloadFailedEvent;

export type CanonicalEventName = CanonicalEvent['event'];

export const CANONICAL_EVENT_ALLOWED_FIELDS = {
  bundle_download_failed: [
    'event',
    'endpoint',
    'http_status',
    's3_error_code',
    'key_prefix',
    'session_id_hash',
    'finalization_id',
  ],
  dispatch_dropped: ['event', 'reason', 'session_id_hash', 'finalization_id'],
  finalization_admitted: ['event', 'finalization_id'],
  finalization_update_received: [
    'event',
    'transport',
    'auth_result',
    'outcome_code',
    'session_id_hash',
    'finalization_id',
  ],
  finalize_state_transition: [
    'event',
    'from',
    'to',
    'source',
    'reason',
    'changed',
    'session_id_hash',
    'finalization_id',
  ],
  finalize_state_update_rejected: ['event', 'to', 'source', 'reason', 'session_id_hash', 'finalization_id'],
  finalize_transition_attempted: ['event', 'to', 'source', 'reason', 'session_id_hash', 'finalization_id'],
  queue_publish: ['event', 'queue', 'result', 'sqs_message_id', 'session_id_hash', 'finalization_id'],
  verification_run_summary: [
    'event',
    'outcome',
    'failure_category',
    'scenario_id',
    'failed_required_count',
    'dev_mode_receipt',
    'session_id_hash',
    'finalization_id',
  ],
} as const satisfies Readonly<Record<CanonicalEventName, readonly string[]>>;

const FINALIZATION_STATE_SET = new Set<string>(FINALIZATION_STATES);
const FINALIZATION_FROM_STATE_SET = new Set<string>(FINALIZATION_FROM_STATES);
const FINALIZATION_SOURCE_SET = new Set<string>(FINALIZATION_SOURCES);
const FINALIZATION_REASON_SET = new Set<string>(FINALIZATION_REASONS);
const DISPATCH_DROP_REASON_SET = new Set<string>(DISPATCH_DROP_REASONS);
const FINALIZATION_UPDATE_TRANSPORT_SET = new Set<string>(FINALIZATION_UPDATE_TRANSPORTS);
const FINALIZATION_AUTH_RESULT_SET = new Set<string>(FINALIZATION_AUTH_RESULTS);
const FINALIZATION_UPDATE_OUTCOME_SET = new Set<string>(FINALIZATION_UPDATE_OUTCOMES);
const QUEUE_NAME_SET = new Set<string>(QUEUE_NAMES);
const QUEUE_PUBLISH_RESULT_SET = new Set<string>(QUEUE_PUBLISH_RESULTS);
const VERIFICATION_OUTCOME_SET = new Set<string>(VERIFICATION_OUTCOMES);
const VERIFICATION_FAILURE_CATEGORY_SET = new Set<string>(VERIFICATION_FAILURE_CATEGORIES);
const SCENARIO_ID_SET = new Set<string>(SCENARIO_IDS);
const BUNDLE_DOWNLOAD_ENDPOINT_SET = new Set<string>(BUNDLE_DOWNLOAD_ENDPOINTS);
const BUNDLE_DOWNLOAD_S3_ERROR_CODE_SET = new Set<string>(BUNDLE_DOWNLOAD_S3_ERROR_CODES);
const SESSION_ID_HASH_PATTERN = /^sid_(?:[0-9a-f]{12}|unknown)$/;
const KEY_PREFIX_PATTERN = /^key_(?:[0-9a-f]{12}|unknown)$/;
const FINALIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SQS_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isFinalizationEventReason(value: unknown): value is FinalizationEventReason {
  return typeof value === 'string' && FINALIZATION_REASON_SET.has(value);
}

type CanonicalEventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is CanonicalEventRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRegisteredString(record: CanonicalEventRecord, key: string, registry: ReadonlySet<string>): string | null {
  const value = record[key];
  return typeof value === 'string' && registry.has(value) ? value : null;
}

function readOptionalCorrelations(record: CanonicalEventRecord): FinalizationCorrelationFields | null {
  const sessionIdHash = record['session_id_hash'];
  const finalizationId = record['finalization_id'];
  if (
    (sessionIdHash !== undefined &&
      (typeof sessionIdHash !== 'string' || !SESSION_ID_HASH_PATTERN.test(sessionIdHash))) ||
    (finalizationId !== undefined &&
      (typeof finalizationId !== 'string' || !FINALIZATION_ID_PATTERN.test(finalizationId)))
  ) {
    return null;
  }
  return {
    ...(typeof sessionIdHash === 'string' ? { session_id_hash: sessionIdHash } : {}),
    ...(typeof finalizationId === 'string' ? { finalization_id: finalizationId } : {}),
  };
}

function projectFinalizeDecisionEvent(
  record: CanonicalEventRecord,
  event: 'finalize_transition_attempted' | 'finalize_state_update_rejected',
): FinalizeTransitionAttemptedEvent | FinalizeStateUpdateRejectedEvent | undefined {
  const to = readRegisteredString(record, 'to', FINALIZATION_STATE_SET);
  const source = readRegisteredString(record, 'source', FINALIZATION_SOURCE_SET);
  const reason = readRegisteredString(record, 'reason', FINALIZATION_REASON_SET);
  const correlations = readOptionalCorrelations(record);
  if (!to || !source || !reason || !correlations) {
    return undefined;
  }
  return {
    event,
    to: to as FinalizationEventState,
    source: source as FinalizationEventSource,
    reason: reason as FinalizationEventReason,
    ...correlations,
  };
}

function projectCanonicalEvent(value: unknown): CanonicalEvent | undefined {
  if (!isRecord(value) || typeof value['event'] !== 'string') {
    return undefined;
  }
  const record = value;
  const correlations = readOptionalCorrelations(record);
  if (!correlations) {
    return undefined;
  }

  switch (record['event']) {
    case 'finalization_admitted':
      return correlations.finalization_id
        ? { event: 'finalization_admitted', finalization_id: correlations.finalization_id }
        : undefined;
    case 'finalize_transition_attempted':
      return projectFinalizeDecisionEvent(record, 'finalize_transition_attempted');
    case 'finalize_state_update_rejected':
      return projectFinalizeDecisionEvent(record, 'finalize_state_update_rejected');
    case 'finalize_state_transition': {
      const from = readRegisteredString(record, 'from', FINALIZATION_FROM_STATE_SET);
      const to = readRegisteredString(record, 'to', FINALIZATION_STATE_SET);
      const source = readRegisteredString(record, 'source', FINALIZATION_SOURCE_SET);
      const reason = readRegisteredString(record, 'reason', FINALIZATION_REASON_SET);
      const changed = record['changed'];
      if (!from || !to || !source || !reason || typeof changed !== 'boolean') {
        return undefined;
      }
      return {
        event: 'finalize_state_transition',
        from: from as FinalizationEventFromState,
        to: to as FinalizationEventState,
        source: source as FinalizationEventSource,
        reason: reason as FinalizationEventReason,
        changed,
        ...correlations,
      };
    }
    case 'dispatch_dropped': {
      const reason = readRegisteredString(record, 'reason', DISPATCH_DROP_REASON_SET);
      return reason ? { event: 'dispatch_dropped', reason: reason as DispatchDropReason, ...correlations } : undefined;
    }
    case 'finalization_update_received': {
      const transport = readRegisteredString(record, 'transport', FINALIZATION_UPDATE_TRANSPORT_SET);
      const authResult = readRegisteredString(record, 'auth_result', FINALIZATION_AUTH_RESULT_SET);
      const outcomeCode = readRegisteredString(record, 'outcome_code', FINALIZATION_UPDATE_OUTCOME_SET);
      if (!transport || !authResult || !outcomeCode) {
        return undefined;
      }
      return {
        event: 'finalization_update_received',
        transport: transport as FinalizationUpdateTransport,
        auth_result: authResult as FinalizationAuthResult,
        outcome_code: outcomeCode as FinalizationUpdateOutcome,
        ...correlations,
      };
    }
    case 'queue_publish': {
      const queue = readRegisteredString(record, 'queue', QUEUE_NAME_SET);
      const result = readRegisteredString(record, 'result', QUEUE_PUBLISH_RESULT_SET);
      const sqsMessageId = record['sqs_message_id'];
      if (
        !queue ||
        !result ||
        (sqsMessageId !== undefined &&
          (typeof sqsMessageId !== 'string' || !SQS_MESSAGE_ID_PATTERN.test(sqsMessageId))) ||
        (result === 'succeeded' && typeof sqsMessageId !== 'string') ||
        (result === 'failed' && sqsMessageId !== undefined)
      ) {
        return undefined;
      }
      return result === 'succeeded'
        ? {
            event: 'queue_publish',
            queue: queue as CanonicalQueueName,
            result: 'succeeded',
            sqs_message_id: sqsMessageId as string,
            ...correlations,
          }
        : {
            event: 'queue_publish',
            queue: queue as CanonicalQueueName,
            result: 'failed',
            ...correlations,
          };
    }
    case 'verification_run_summary': {
      const outcome = readRegisteredString(record, 'outcome', VERIFICATION_OUTCOME_SET);
      const failureCategory = readRegisteredString(record, 'failure_category', VERIFICATION_FAILURE_CATEGORY_SET);
      const scenarioId = readRegisteredString(record, 'scenario_id', SCENARIO_ID_SET);
      const failedRequiredCount = record['failed_required_count'];
      const devModeReceipt = record['dev_mode_receipt'];
      if (
        !outcome ||
        !failureCategory ||
        !scenarioId ||
        typeof failedRequiredCount !== 'number' ||
        !Number.isInteger(failedRequiredCount) ||
        failedRequiredCount < 0 ||
        typeof devModeReceipt !== 'boolean'
      ) {
        return undefined;
      }
      return {
        event: 'verification_run_summary',
        outcome: outcome as VerificationRunOutcome,
        failure_category: failureCategory as VerificationFailureCategory,
        scenario_id: scenarioId as CanonicalScenarioId,
        failed_required_count: failedRequiredCount,
        dev_mode_receipt: devModeReceipt,
        ...correlations,
      };
    }
    case 'bundle_download_failed': {
      const endpoint = readRegisteredString(record, 'endpoint', BUNDLE_DOWNLOAD_ENDPOINT_SET);
      const s3ErrorCode = readRegisteredString(record, 's3_error_code', BUNDLE_DOWNLOAD_S3_ERROR_CODE_SET);
      const httpStatus = record['http_status'];
      const keyPrefix = record['key_prefix'];
      if (
        !endpoint ||
        !s3ErrorCode ||
        typeof httpStatus !== 'number' ||
        !Number.isInteger(httpStatus) ||
        httpStatus < 400 ||
        httpStatus > 599 ||
        typeof keyPrefix !== 'string' ||
        !KEY_PREFIX_PATTERN.test(keyPrefix)
      ) {
        return undefined;
      }
      return {
        event: 'bundle_download_failed',
        endpoint: endpoint as BundleDownloadEndpoint,
        http_status: httpStatus,
        s3_error_code: s3ErrorCode as BundleDownloadS3ErrorCode,
        key_prefix: keyPrefix,
        ...correlations,
      };
    }
    default:
      return undefined;
  }
}

function emitProjectedCanonicalEvent(event: CanonicalEvent): void {
  if (
    event.event === 'finalize_state_update_rejected' ||
    event.event === 'dispatch_dropped' ||
    event.event === 'bundle_download_failed'
  ) {
    logger.warn(event.event, event);
    return;
  }
  logger.info(event.event, event);
}

export function emitCanonicalEvent(event: CanonicalEvent): void {
  try {
    const projected = projectCanonicalEvent(event);
    if (projected) {
      emitProjectedCanonicalEvent(projected);
    }
  } catch {
    // Telemetry must never alter product behavior, including if the logger is replaced in tests.
  }
}
