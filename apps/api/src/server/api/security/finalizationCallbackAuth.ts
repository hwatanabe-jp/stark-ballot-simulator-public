import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';

const DEFAULT_MAX_CALLBACK_SKEW_MS = 5 * 60 * 1000;

export type FinalizationCallbackAuthFailureReason =
  | 'secret_unavailable'
  | 'signature_headers_missing'
  | 'timestamp_invalid'
  | 'skew_config_invalid'
  | 'timestamp_out_of_range'
  | 'signature_invalid';

export type FinalizationCallbackAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason: FinalizationCallbackAuthFailureReason;
      status: 401 | 500;
      message: string;
      authResult: 'failed' | 'not_checked';
    };

export type FinalizationCallbackAuthPreflightResult =
  | {
      ok: true;
      credentials: {
        secret: string;
        timestampHeader: string;
        signatureHeader: string;
      };
    }
  | Exclude<FinalizationCallbackAuthResult, { ok: true }>;

function resolveFinalizeCallbackMaxSkewMs(rawValue: string | undefined): number | null {
  if (!rawValue || rawValue.trim().length === 0) {
    return DEFAULT_MAX_CALLBACK_SKEW_MS;
  }
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function preflightFinalizationCallbackAuth(input: {
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret?: string;
}): FinalizationCallbackAuthPreflightResult {
  const secret = input.secret?.trim();
  if (!secret || isUnresolvedRuntimeSecretPlaceholder(secret)) {
    return {
      ok: false,
      reason: 'secret_unavailable',
      status: 500,
      message: 'Callback secret not configured',
      authResult: 'not_checked',
    };
  }

  if (!input.timestampHeader || !input.signatureHeader) {
    return {
      ok: false,
      reason: 'signature_headers_missing',
      status: 401,
      message: 'Missing signature headers',
      authResult: 'failed',
    };
  }

  return {
    ok: true,
    credentials: {
      secret,
      timestampHeader: input.timestampHeader,
      signatureHeader: input.signatureHeader,
    },
  };
}

export function authenticatePreparedFinalizationCallback(input: {
  rawBody: Uint8Array;
  credentials: Extract<FinalizationCallbackAuthPreflightResult, { ok: true }>['credentials'];
  now?: number;
  maxSkewMs?: string;
}): FinalizationCallbackAuthResult {
  const timestamp = Date.parse(input.credentials.timestampHeader);
  if (Number.isNaN(timestamp)) {
    return {
      ok: false,
      reason: 'timestamp_invalid',
      status: 401,
      message: 'Invalid signature timestamp',
      authResult: 'failed',
    };
  }

  const maxSkewMs = resolveFinalizeCallbackMaxSkewMs(input.maxSkewMs);
  if (maxSkewMs === null) {
    return {
      ok: false,
      reason: 'skew_config_invalid',
      status: 500,
      message: 'Invalid callback skew configuration',
      authResult: 'not_checked',
    };
  }
  if (Math.abs((input.now ?? Date.now()) - timestamp) > maxSkewMs) {
    return {
      ok: false,
      reason: 'timestamp_out_of_range',
      status: 401,
      message: 'Signature timestamp out of range',
      authResult: 'failed',
    };
  }

  const expectedSignature = createHmac('sha256', input.credentials.secret)
    .update(input.credentials.timestampHeader)
    .update('.')
    .update(input.rawBody)
    .digest('hex');
  const providedSignature = input.credentials.signatureHeader.trim().toLowerCase();
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(providedSignature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return {
      ok: false,
      reason: 'signature_invalid',
      status: 401,
      message: 'Invalid callback signature',
      authResult: 'failed',
    };
  }

  return { ok: true };
}

export function authenticateFinalizationCallback(input: {
  rawBody: Uint8Array;
  timestampHeader: string | null;
  signatureHeader: string | null;
  now?: number;
  secret?: string;
  maxSkewMs?: string;
}): FinalizationCallbackAuthResult {
  const preflight = preflightFinalizationCallbackAuth(input);
  if (!preflight.ok) {
    return preflight;
  }
  return authenticatePreparedFinalizationCallback({
    rawBody: input.rawBody,
    credentials: preflight.credentials,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxSkewMs === undefined ? {} : { maxSkewMs: input.maxSkewMs }),
  });
}
