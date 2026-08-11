import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import {
  emitCanonicalEvent,
  type FinalizationAuthResult,
  type FinalizationUpdateOutcome,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { readBoundedRequestBody } from '../../http/boundedRequestBody';
import { jsonResponse } from '../../http/response';
import type { ApiContextStore } from '../context';
import {
  authenticatePreparedFinalizationCallback,
  preflightFinalizationCallbackAuth,
} from '../security/finalizationCallbackAuth';
import { coordinateFinalizationCallback } from './finalizationCallbackCoordinator';

const DEFAULT_FINALIZE_CALLBACK_BODY_LIMIT_BYTES = 8 * 1024;

function emitHttpCallbackUpdateReceived(
  outcome: FinalizationUpdateOutcome,
  authResult: FinalizationAuthResult,
  correlation?: { sessionId: string; finalizationId: string },
): void {
  emitCanonicalEvent({
    event: 'finalization_update_received',
    transport: 'http_callback',
    auth_result: authResult,
    outcome_code: outcome,
    ...(correlation
      ? {
          session_id_hash: hashSessionIdForLogging(correlation.sessionId),
          finalization_id: correlation.finalizationId,
        }
      : {}),
  });
}

function resolveFinalizeCallbackBodyLimitBytes(rawValue: string | undefined): number | null {
  if (!rawValue || rawValue.trim().length === 0) {
    return DEFAULT_FINALIZE_CALLBACK_BODY_LIMIT_BYTES;
  }
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function admitFinalizationCallbackRequest(request: Request): Promise<{ rawBody: Uint8Array } | Response> {
  const preflight = preflightFinalizationCallbackAuth({
    timestampHeader: request.headers.get('x-finalization-writer-timestamp'),
    signatureHeader: request.headers.get('x-finalization-writer-signature'),
    ...omitUndefinedProperties({
      secret: process.env['FINALIZE_CALLBACK_SECRET'],
    }),
  });
  if (!preflight.ok) {
    emitHttpCallbackUpdateReceived(preflight.reason, preflight.authResult);
    return jsonResponse({ error: preflight.message }, { status: preflight.status });
  }

  const bodyLimitBytes = resolveFinalizeCallbackBodyLimitBytes(process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES']);
  if (bodyLimitBytes === null) {
    emitHttpCallbackUpdateReceived('body_limit_invalid', 'not_checked');
    return jsonResponse({ error: 'Invalid callback body limit configuration' }, { status: 500 });
  }

  const rawBodyResult = await readBoundedRequestBody(request, bodyLimitBytes);
  if (!rawBodyResult.ok) {
    if (rawBodyResult.reason === 'too_large') {
      emitHttpCallbackUpdateReceived('payload_too_large', 'not_checked');
      return jsonResponse({ error: 'Callback payload too large' }, { status: 413 });
    }
    emitHttpCallbackUpdateReceived('payload_read_failed', 'not_checked');
    return jsonResponse({ error: 'Invalid callback payload' }, { status: 400 });
  }

  const authResult = authenticatePreparedFinalizationCallback({
    rawBody: rawBodyResult.bytes,
    credentials: preflight.credentials,
    ...omitUndefinedProperties({
      maxSkewMs: process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'],
    }),
  });
  if (!authResult.ok) {
    emitHttpCallbackUpdateReceived(authResult.reason, authResult.authResult);
    return jsonResponse({ error: authResult.message }, { status: authResult.status });
  }

  return { rawBody: rawBodyResult.bytes };
}

/**
 * Apply an already authenticated callback payload.
 *
 * Raw-byte transport admission is the callback-only route exception and runs
 * before JSON admission, which remains owned by AWS adapters.
 */
export async function finalizeCallbackHandler(input: {
  rawBody: Uint8Array;
  sessionId: string;
  finalizationId: string;
  store: ApiContextStore;
}): Promise<Response> {
  if (!isSafeVerifierSegment(input.sessionId) || !isSafeVerifierSegment(input.finalizationId)) {
    emitHttpCallbackUpdateReceived('payload_invalid', 'passed');
    return jsonResponse({ error: 'Invalid callback path' }, { status: 400 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(input.rawBody)) as unknown;
  } catch {
    emitHttpCallbackUpdateReceived('payload_invalid', 'passed');
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const payload = parseFinalizationStateUpdatePayload(parsedJson);
  if (!payload) {
    emitHttpCallbackUpdateReceived('payload_invalid', 'passed');
    return jsonResponse({ error: 'Invalid callback payload' }, { status: 400 });
  }
  const correlation = {
    sessionId: payload.sessionId,
    finalizationId: payload.finalizationId,
  };
  if (payload.sessionId !== input.sessionId || payload.finalizationId !== input.finalizationId) {
    emitHttpCallbackUpdateReceived('payload_invalid', 'passed', correlation);
    return jsonResponse({ error: 'Callback identity mismatch' }, { status: 400 });
  }

  const coordinated = await coordinateFinalizationCallback({
    payload,
    store: input.store,
  });
  return jsonResponse(coordinated.body, { status: coordinated.status });
}
