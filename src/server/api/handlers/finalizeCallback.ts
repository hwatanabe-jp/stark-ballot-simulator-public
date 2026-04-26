import { createHmac, timingSafeEqual } from 'crypto';
import { isUnresolvedAmplifySecret } from '@/lib/env/amplifySecrets';
import type { FinalizationResultAuthority, FinalizationState } from '@/types/server';
import { parseFinalizationResultAuthority } from '@/lib/finalize/finalization-storage';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import type { ApiContext } from '@/server/api/context';
import { jsonResponse } from '@/server/http/response';
import { hydrateFinalizationResultFromJournal } from '@/lib/finalize/finalization-result';
import { isCurrentArtifactBoundaryError } from '@/lib/contract';

type CallbackStatus = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

interface FinalizeCallbackPayload {
  sessionId: string;
  executionId: string;
  contractGeneration: string;
  status: CallbackStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  timeoutAt?: number;
  bundleMetadata?: Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'];
  error?: Extract<FinalizationState, { status: 'failed' }>['error'];
  finalizationResult?: FinalizationResultAuthority;
  stepFunctionsArn?: string;
}

const DEFAULT_MAX_CALLBACK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_FINALIZE_CALLBACK_BODY_LIMIT_BYTES = 8 * 1024;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseBundleMetadata(
  value: unknown,
): Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const s3BundleKey = getStringProperty(value, 's3BundleKey');
  const s3UploadedAt = getStringProperty(value, 's3UploadedAt');

  return {
    ...(s3BundleKey ? { s3BundleKey } : {}),
    ...(s3UploadedAt ? { s3UploadedAt } : {}),
  };
}

function parseFinalizationError(value: unknown): Extract<FinalizationState, { status: 'failed' }>['error'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = getStringProperty(value, 'code');
  const message = getStringProperty(value, 'message');
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return {
    code,
    message,
    ...(hasOwn(value, 'details') ? { details: value.details } : {}),
  };
}

function parseFinalizeCallbackPayload(value: unknown): FinalizeCallbackPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = getStringProperty(value, 'sessionId');
  const executionId = getStringProperty(value, 'executionId');
  const contractGeneration = getStringProperty(value, 'contractGeneration');
  const status = getStringProperty(value, 'status');
  const queuedAt = getNumberProperty(value, 'queuedAt');
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof executionId !== 'string' ||
    executionId.length === 0 ||
    typeof contractGeneration !== 'string' ||
    contractGeneration.length === 0 ||
    (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'TIMED_OUT') ||
    !isNonNegativeInteger(queuedAt)
  ) {
    return undefined;
  }

  const startedAt = getNumberProperty(value, 'startedAt');
  const completedAt = getNumberProperty(value, 'completedAt');
  const failedAt = getNumberProperty(value, 'failedAt');
  const timeoutAt = getNumberProperty(value, 'timeoutAt');
  if (
    (hasOwn(value, 'startedAt') && !isNonNegativeInteger(startedAt)) ||
    (hasOwn(value, 'completedAt') && !isNonNegativeInteger(completedAt)) ||
    (hasOwn(value, 'failedAt') && !isNonNegativeInteger(failedAt)) ||
    (hasOwn(value, 'timeoutAt') && !isNonNegativeInteger(timeoutAt))
  ) {
    return undefined;
  }

  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  if (hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string') {
    return undefined;
  }

  const parsed: FinalizeCallbackPayload = {
    sessionId,
    executionId,
    contractGeneration,
    status,
    queuedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(timeoutAt !== undefined ? { timeoutAt } : {}),
    ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
  };

  const bundleMetadata = parseBundleMetadata(getRecordProperty(value, 'bundleMetadata'));
  if (bundleMetadata && Object.keys(bundleMetadata).length > 0) {
    parsed.bundleMetadata = bundleMetadata;
  }

  const error = parseFinalizationError(value.error);
  if (error) {
    parsed.error = error;
  }

  const finalizationResult = parseFinalizationResultAuthority(value.finalizationResult);
  if (finalizationResult) {
    parsed.finalizationResult = finalizationResult;
  }

  return parsed;
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
  const secret = process.env.FINALIZE_CALLBACK_SECRET?.trim();
  if (!secret || isUnresolvedAmplifySecret(secret)) {
    return jsonResponse({ error: 'Callback secret not configured' }, { status: 500 });
  }

  const timestampHeader = request.headers.get('x-finalize-callback-timestamp');
  const signatureHeader = request.headers.get('x-finalize-callback-signature');

  if (!timestampHeader || !signatureHeader) {
    return jsonResponse({ error: 'Missing signature headers' }, { status: 401 });
  }

  const bodyLimitBytes = resolveFinalizeCallbackBodyLimitBytes(process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES);
  if (bodyLimitBytes === null) {
    return jsonResponse({ error: 'Invalid callback body limit configuration' }, { status: 500 });
  }

  const rawBodyResult = await readCallbackBodyWithLimit(request, bodyLimitBytes);
  if (rawBodyResult instanceof Response) {
    return rawBodyResult;
  }
  const rawBody = rawBodyResult;

  const timestamp = Date.parse(timestampHeader);
  if (Number.isNaN(timestamp)) {
    return jsonResponse({ error: 'Invalid signature timestamp' }, { status: 401 });
  }

  const maxSkewMs = resolveFinalizeCallbackMaxSkewMs(process.env.FINALIZE_CALLBACK_MAX_SKEW_MS);
  if (maxSkewMs === null) {
    return jsonResponse({ error: 'Invalid callback skew configuration' }, { status: 500 });
  }
  if (Math.abs(Date.now() - timestamp) > maxSkewMs) {
    return jsonResponse({ error: 'Signature timestamp out of range' }, { status: 401 });
  }

  const expectedSignature = createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');

  const providedSignature = signatureHeader.trim().toLowerCase();
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(providedSignature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return jsonResponse({ error: 'Invalid callback signature' }, { status: 401 });
  }

  let payload: FinalizeCallbackPayload;
  try {
    const parsed = parseFinalizeCallbackPayload(JSON.parse(rawBody) as unknown);
    if (!parsed) {
      return jsonResponse({ error: 'Invalid callback payload' }, { status: 400 });
    }
    payload = parsed;
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  let state: FinalizationState;

  try {
    switch (payload.status) {
      case 'SUCCEEDED': {
        if (typeof store.markFinalizationSucceeded !== 'function') {
          return jsonResponse({ error: 'Success handler unavailable' }, { status: 501 });
        }

        const session = await store.getSession(payload.sessionId);
        const scenarioContext = session?.finalizationScenarioContext;
        const hydratedResult = hydrateFinalizationResultFromJournal(payload.finalizationResult, scenarioContext);

        if (!hydratedResult?.journal) {
          if (typeof store.markFinalizationFailed !== 'function') {
            return jsonResponse({ error: 'Canonical finalization result required' }, { status: 500 });
          }

          state = await store.markFinalizationFailed(payload.sessionId, {
            executionId: payload.executionId,
            queuedAt: payload.queuedAt,
            contractGeneration: payload.contractGeneration,
            startedAt: payload.startedAt ?? payload.queuedAt,
            failedAt: Date.now(),
            error: {
              code: 'FINALIZATION_RESULT_INVALID',
              message: 'Canonical finalization result is missing proof-bound journal data',
            },
            stepFunctionsArn: payload.stepFunctionsArn,
          });
          break;
        }

        state = await store.markFinalizationSucceeded(payload.sessionId, {
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          contractGeneration: payload.contractGeneration,
          startedAt: payload.startedAt ?? payload.queuedAt,
          completedAt: payload.completedAt ?? Date.now(),
          bundleMetadata: payload.bundleMetadata,
          stepFunctionsArn: payload.stepFunctionsArn,
          finalizationResult: hydratedResult,
        });
        break;
      }

      case 'FAILED': {
        if (typeof store.markFinalizationFailed !== 'function') {
          return jsonResponse({ error: 'Failure handler unavailable' }, { status: 501 });
        }

        state = await store.markFinalizationFailed(payload.sessionId, {
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          contractGeneration: payload.contractGeneration,
          startedAt: payload.startedAt,
          failedAt: payload.failedAt ?? Date.now(),
          error: payload.error ?? {
            code: 'UNKNOWN',
            message: 'Finalization failed',
          },
          stepFunctionsArn: payload.stepFunctionsArn,
        });
        break;
      }

      case 'TIMED_OUT': {
        if (typeof store.markFinalizationTimedOut !== 'function') {
          return jsonResponse({ error: 'Timeout handler unavailable' }, { status: 501 });
        }

        state = await store.markFinalizationTimedOut(payload.sessionId, {
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          contractGeneration: payload.contractGeneration,
          startedAt: payload.startedAt,
          timeoutAt: payload.timeoutAt ?? Date.now(),
          stepFunctionsArn: payload.stepFunctionsArn,
        });
        break;
      }

      default:
        return jsonResponse({ error: 'Unsupported status' }, { status: 400 });
    }
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      return jsonResponse(
        {
          error: error.code,
          artifactState: error.artifactState,
          details: error.details,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  return jsonResponse(
    {
      sessionId: payload.sessionId,
      state,
    },
    { status: 200 },
  );
}
