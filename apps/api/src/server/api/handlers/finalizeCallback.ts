import { createHmac, timingSafeEqual } from 'crypto';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import type { ApiContext } from '../context';
import { jsonResponse } from '../../http/response';
import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import { FinalizeCallbackResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import { type FinalizationStateUpdateApplyResult } from '@stark-ballot/application/finalize/finalization-state-update';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { isAwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import {
  parseFinalizationStateUpdatePayload,
  type AwsFinalizationStateUpdatePayload,
} from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import {
  emitCanonicalEvent,
  type FinalizationAuthResult,
  type FinalizationUpdateOutcome,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const DEFAULT_MAX_CALLBACK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_FINALIZE_CALLBACK_BODY_LIMIT_BYTES = 8 * 1024;

function emitHttpCallbackUpdateReceived(
  outcome: FinalizationUpdateOutcome,
  authResult: FinalizationAuthResult,
  payload?: AwsFinalizationStateUpdatePayload,
): void {
  emitCanonicalEvent({
    event: 'finalization_update_received',
    transport: 'http_callback',
    auth_result: authResult,
    outcome_code: outcome,
    ...(payload
      ? {
          session_id_hash: hashSessionIdForLogging(payload.sessionId),
          execution_id: payload.executionId,
        }
      : {}),
  });
}

function resolveFinalizeCallbackMaxSkewMs(rawValue: string | undefined): number | null {
  if (!rawValue || rawValue.trim().length === 0) {
    return DEFAULT_MAX_CALLBACK_SKEW_MS;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function resolveFinalizeCallbackBodyLimitBytes(rawValue: string | undefined): number | null {
  if (!rawValue || rawValue.trim().length === 0) {
    return DEFAULT_FINALIZE_CALLBACK_BODY_LIMIT_BYTES;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

async function readCallbackBodyWithLimit(request: Request, limitBytes: number): Promise<string | Response> {
  const contentLength = parseContentLength(request.headers);
  if (contentLength !== null && contentLength > limitBytes) {
    return jsonResponse({ error: 'Callback payload too large' }, { status: 413 });
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let bodyText = '';

  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation errors after definitive rejection.
        }
        return jsonResponse({ error: 'Callback payload too large' }, { status: 413 });
      }
      bodyText += decoder.decode(chunk, { stream: true });
      result = await reader.read();
    }
    bodyText += decoder.decode();
  } catch {
    return jsonResponse({ error: 'Invalid callback payload' }, { status: 400 });
  }

  return bodyText;
}

/**
 * Handle async finalization callback updates.
 * Note: HMAC validation only; no session/Turnstile middleware is applied.
 */
export async function finalizeCallbackHandler({ request, store }: ApiContext): Promise<Response> {
  const secret = process.env['FINALIZE_CALLBACK_SECRET']?.trim();
  if (!secret || isUnresolvedRuntimeSecretPlaceholder(secret)) {
    emitHttpCallbackUpdateReceived('secret_unavailable', 'not_checked');
    return jsonResponse({ error: 'Callback secret not configured' }, { status: 500 });
  }

  const timestampHeader = request.headers.get('x-finalization-writer-timestamp');
  const signatureHeader = request.headers.get('x-finalization-writer-signature');

  if (!timestampHeader || !signatureHeader) {
    emitHttpCallbackUpdateReceived('signature_headers_missing', 'failed');
    return jsonResponse({ error: 'Missing signature headers' }, { status: 401 });
  }

  const bodyLimitBytes = resolveFinalizeCallbackBodyLimitBytes(process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES']);
  if (bodyLimitBytes === null) {
    emitHttpCallbackUpdateReceived('body_limit_invalid', 'not_checked');
    return jsonResponse({ error: 'Invalid callback body limit configuration' }, { status: 500 });
  }

  const rawBodyResult = await readCallbackBodyWithLimit(request, bodyLimitBytes);
  if (rawBodyResult instanceof Response) {
    emitHttpCallbackUpdateReceived(
      rawBodyResult.status === 413 ? 'payload_too_large' : 'payload_read_failed',
      'not_checked',
    );
    return rawBodyResult;
  }
  const rawBody = rawBodyResult;

  const timestamp = Date.parse(timestampHeader);
  if (Number.isNaN(timestamp)) {
    emitHttpCallbackUpdateReceived('timestamp_invalid', 'failed');
    return jsonResponse({ error: 'Invalid signature timestamp' }, { status: 401 });
  }

  const maxSkewMs = resolveFinalizeCallbackMaxSkewMs(process.env['FINALIZE_CALLBACK_MAX_SKEW_MS']);
  if (maxSkewMs === null) {
    emitHttpCallbackUpdateReceived('skew_config_invalid', 'not_checked');
    return jsonResponse({ error: 'Invalid callback skew configuration' }, { status: 500 });
  }
  if (Math.abs(Date.now() - timestamp) > maxSkewMs) {
    emitHttpCallbackUpdateReceived('timestamp_out_of_range', 'failed');
    return jsonResponse({ error: 'Signature timestamp out of range' }, { status: 401 });
  }

  const expectedSignature = createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');

  const providedSignature = signatureHeader.trim().toLowerCase();
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(providedSignature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    emitHttpCallbackUpdateReceived('signature_invalid', 'failed');
    return jsonResponse({ error: 'Invalid callback signature' }, { status: 401 });
  }

  let payload: AwsFinalizationStateUpdatePayload;
  try {
    const parsed = parseFinalizationStateUpdatePayload(JSON.parse(rawBody) as unknown);
    if (!parsed) {
      emitHttpCallbackUpdateReceived('payload_invalid', 'passed');
      return jsonResponse({ error: 'Invalid callback payload' }, { status: 400 });
    }
    payload = parsed;
  } catch {
    emitHttpCallbackUpdateReceived('payload_invalid', 'passed');
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  let result: FinalizationStateUpdateApplyResult;

  try {
    if (!isAwsFinalizationRuntimeTransitionStore(store)) {
      emitHttpCallbackUpdateReceived('transition_store_unavailable', 'passed', payload);
      return jsonResponse({ error: 'Runtime finalization handler unavailable' }, { status: 501 });
    }
    result = await applyAwsFinalizationStateUpdatePayload({ payload, store });
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      emitHttpCallbackUpdateReceived('artifact_rejected', 'passed', payload);
      return jsonResponse(
        {
          error: error.code,
          artifactState: error.artifactState,
          details: error.details,
        },
        { status: 409 },
      );
    }
    if (error instanceof Error) {
      if (error.message === 'Success handler unavailable') {
        emitHttpCallbackUpdateReceived('handler_unavailable', 'passed', payload);
        return jsonResponse({ error: 'Success handler unavailable' }, { status: 501 });
      }
      if (error.message === 'Failure handler unavailable') {
        emitHttpCallbackUpdateReceived('handler_unavailable', 'passed', payload);
        return jsonResponse({ error: 'Failure handler unavailable' }, { status: 501 });
      }
      if (error.message === 'Timeout handler unavailable') {
        emitHttpCallbackUpdateReceived('handler_unavailable', 'passed', payload);
        return jsonResponse({ error: 'Timeout handler unavailable' }, { status: 501 });
      }
      if (error.message === 'Canonical finalization result required') {
        emitHttpCallbackUpdateReceived('canonical_result_missing', 'passed', payload);
        return jsonResponse({ error: 'Canonical finalization result required' }, { status: 500 });
      }
    }
    emitHttpCallbackUpdateReceived('application_failed', 'passed', payload);
    throw error;
  }

  emitHttpCallbackUpdateReceived('applied', 'passed', payload);
  return respondWithSchema(
    FinalizeCallbackResponseSchema,
    {
      sessionId: result.sessionId,
      state: result.state,
    },
    { status: 200 },
  );
}
