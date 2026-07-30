import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import {
  BUNDLE_DOWNLOAD_ENDPOINTS,
  BUNDLE_DOWNLOAD_S3_ERROR_CODES,
  CANONICAL_EVENT_ALLOWED_FIELDS,
  DISPATCH_DROP_REASONS,
  FINALIZATION_AUTH_RESULTS,
  FINALIZATION_FROM_STATES,
  FINALIZATION_REASONS,
  FINALIZATION_SOURCES,
  FINALIZATION_STATES,
  FINALIZATION_UPDATE_OUTCOMES,
  FINALIZATION_UPDATE_TRANSPORTS,
  QUEUE_NAMES,
  QUEUE_PUBLISH_RESULTS,
  SCENARIO_IDS,
  VERIFICATION_FAILURE_CATEGORIES,
  VERIFICATION_OUTCOMES,
  emitCanonicalEvent,
  type CanonicalEvent,
} from '../canonicalEvents';

const SESSION_ID_HASH = 'sid_0123456789ab';
const EXECUTION_ID = 'exec-canonical-event';

const canonicalEventSamples = [
  {
    event: 'finalize_transition_attempted',
    to: 'pending',
    source: 'finalize',
    reason: 'FINALIZE_REQUESTED',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'finalize_state_update_rejected',
    to: 'running',
    source: 'writer_update',
    reason: 'EXECUTION_MISMATCH',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'finalize_state_transition',
    from: 'pending',
    to: 'running',
    source: 'writer_update',
    reason: 'RUNTIME_UPDATE_RECEIVED',
    changed: true,
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'dispatch_dropped',
    reason: 'not_pending',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'finalization_update_received',
    transport: 'direct_writer',
    auth_result: 'not_applicable',
    outcome_code: 'applied',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'queue_publish',
    queue: 'prover',
    result: 'succeeded',
    sqs_message_id: '35f6c6bc-0189-49df-9d7b-8a60f6f15dc5',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'verification_run_summary',
    outcome: 'fully_verified',
    failure_category: 'none',
    scenario_id: 'S0',
    failed_required_count: 0,
    dev_mode_receipt: false,
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
  {
    event: 'bundle_download_failed',
    endpoint: 'bundle',
    http_status: 404,
    s3_error_code: 'no_such_key',
    key_prefix: 'key_0123456789ab',
    session_id_hash: SESSION_ID_HASH,
    execution_id: EXECUTION_ID,
  },
] as const satisfies readonly CanonicalEvent[];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical P2 event contracts', () => {
  it('snapshots every event-specific runtime field allowlist', () => {
    expect(CANONICAL_EVENT_ALLOWED_FIELDS).toMatchInlineSnapshot(`
      {
        "bundle_download_failed": [
          "event",
          "endpoint",
          "http_status",
          "s3_error_code",
          "key_prefix",
          "session_id_hash",
          "execution_id",
        ],
        "dispatch_dropped": [
          "event",
          "reason",
          "session_id_hash",
          "execution_id",
        ],
        "finalization_update_received": [
          "event",
          "transport",
          "auth_result",
          "outcome_code",
          "session_id_hash",
          "execution_id",
        ],
        "finalize_state_transition": [
          "event",
          "from",
          "to",
          "source",
          "reason",
          "changed",
          "session_id_hash",
          "execution_id",
        ],
        "finalize_state_update_rejected": [
          "event",
          "to",
          "source",
          "reason",
          "session_id_hash",
          "execution_id",
        ],
        "finalize_transition_attempted": [
          "event",
          "to",
          "source",
          "reason",
          "session_id_hash",
          "execution_id",
        ],
        "queue_publish": [
          "event",
          "queue",
          "result",
          "sqs_message_id",
          "session_id_hash",
          "execution_id",
        ],
        "verification_run_summary": [
          "event",
          "outcome",
          "failure_category",
          "scenario_id",
          "failed_required_count",
          "dev_mode_receipt",
          "session_id_hash",
          "execution_id",
        ],
      }
    `);
  });

  it('snapshots every closed P2 registry', () => {
    expect({
      BUNDLE_DOWNLOAD_ENDPOINTS,
      BUNDLE_DOWNLOAD_S3_ERROR_CODES,
      DISPATCH_DROP_REASONS,
      FINALIZATION_AUTH_RESULTS,
      FINALIZATION_FROM_STATES,
      FINALIZATION_REASONS,
      FINALIZATION_SOURCES,
      FINALIZATION_STATES,
      FINALIZATION_UPDATE_OUTCOMES,
      FINALIZATION_UPDATE_TRANSPORTS,
      QUEUE_NAMES,
      QUEUE_PUBLISH_RESULTS,
      SCENARIO_IDS,
      VERIFICATION_FAILURE_CATEGORIES,
      VERIFICATION_OUTCOMES,
    }).toMatchSnapshot();
  });

  it('emits each declared event with only its allowlisted fields', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (const sample of canonicalEventSamples) {
      emitCanonicalEvent({ ...sample, body: 'must-not-pass-the-type-boundary' } as unknown as CanonicalEvent);
    }

    const payloads = [...info.mock.calls, ...warn.mock.calls].map((call) => call[1] as Record<string, unknown>);
    expect(payloads).toHaveLength(canonicalEventSamples.length);
    for (const payload of payloads) {
      const event = payload['event'] as keyof typeof CANONICAL_EVENT_ALLOWED_FIELDS;
      expect(Object.keys(payload)).toEqual(CANONICAL_EVENT_ALLOWED_FIELDS[event]);
      expect(payload).not.toHaveProperty('body');
    }
  });

  it('drops runtime values outside the closed registries', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    emitCanonicalEvent({
      event: 'dispatch_dropped',
      reason: 'raw free text',
    } as unknown as CanonicalEvent);

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws into the product path when the logger fails', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('console unavailable');
    });

    expect(() => emitCanonicalEvent(canonicalEventSamples[7])).not.toThrow();
  });
});
