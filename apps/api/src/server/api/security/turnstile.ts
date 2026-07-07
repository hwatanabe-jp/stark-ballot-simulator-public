import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import { resolveRuntimeConfigReference } from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import { resolveRuntimeEnvMode } from '@stark-ballot/runtime-config/env/runtimeMode';
import { isTruthyFlag } from '@stark-ballot/runtime-config/env/flags';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isIP } from 'node:net';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
type TrustedProxyMode = 'none' | 'api-gateway' | 'cloudflare' | 'both';

export interface ValidateTurnstileOptions {
  token: unknown;
  remoteIp?: string | null;
  expectedAction?: string;
}

interface TurnstileSiteVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
  action?: string;
  cdata?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseTurnstileSiteVerifyResponse(value: unknown): TurnstileSiteVerifyResponse | null {
  if (!isRecord(value) || typeof value['success'] !== 'boolean') {
    return null;
  }
  const rawErrorCodes = value['error-codes'];
  const errorCodes =
    Array.isArray(rawErrorCodes) && rawErrorCodes.every((entry) => typeof entry === 'string')
      ? rawErrorCodes
      : undefined;

  return omitUndefinedProperties({
    success: value['success'],
    challenge_ts: readOptionalString(value, 'challenge_ts'),
    hostname: readOptionalString(value, 'hostname'),
    ...(errorCodes ? { 'error-codes': errorCodes } : {}),
    action: readOptionalString(value, 'action'),
    cdata: readOptionalString(value, 'cdata'),
  });
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let hostname = trimmed;
  try {
    if (trimmed.includes('://')) {
      hostname = new URL(trimmed).hostname;
    } else {
      hostname = trimmed.split('/')[0] ?? '';
      hostname = hostname.split(':')[0] ?? '';
    }
  } catch {
    return null;
  }

  const normalized = hostname.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getAllowedHostnames(): Set<string> {
  const raw = process.env['TURNSTILE_ALLOWED_HOSTNAMES'];
  if (!raw) {
    return new Set();
  }

  const values = raw
    .split(',')
    .map((entry) => normalizeHostname(entry))
    .filter((entry): entry is string => Boolean(entry));

  return new Set(values);
}

function assertExpectedActionMatches(actual: string | undefined, expected: string): void {
  const normalizedExpected = expected.trim();
  if (!normalizedExpected) {
    return;
  }
  const normalizedActual = actual?.trim();
  if (!normalizedActual || normalizedActual !== normalizedExpected) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile action mismatch', {
      expectedAction: normalizedExpected,
      action: normalizedActual ?? null,
    });
  }
}

function assertHostnameAllowed(hostname: string | undefined, allowedHostnames: Set<string>): void {
  if (allowedHostnames.size === 0) {
    return;
  }
  const normalizedHostname = hostname ? normalizeHostname(hostname) : null;
  if (!normalizedHostname || !allowedHostnames.has(normalizedHostname)) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile hostname mismatch', {
      hostname: normalizedHostname,
      allowedHostnames: Array.from(allowedHostnames),
    });
  }
}

function shouldBypassTurnstile(): boolean {
  if (!isTruthyFlag(process.env['TURNSTILE_BYPASS'])) {
    return false;
  }
  return resolveRuntimeEnvMode() === 'non-production';
}

function resolveTrustedProxyMode(): TrustedProxyMode {
  const raw = process.env['TRUSTED_PROXY'];
  if (raw && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    switch (normalized) {
      case 'api-gateway':
      case 'apigateway':
      case 'apigw':
      case 'aws':
      case 'true':
      case '1':
      case 'yes':
      case 'on':
        return 'api-gateway';
      case 'cloudflare':
      case 'cf':
        return 'cloudflare';
      case 'both':
      case 'all':
      case 'any':
        return 'both';
      case 'none':
      case 'false':
      case '0':
      case 'off':
        return 'none';
      default:
        return 'none';
    }
  }

  const isAwsRuntime =
    Boolean(process.env['AWS_EXECUTION_ENV']) ||
    Boolean(process.env['AWS_LAMBDA_FUNCTION_NAME']) ||
    Boolean(process.env['AWS_REGION']);
  return isAwsRuntime ? 'api-gateway' : 'none';
}

function getTurnstileSecret(): string {
  const secret = process.env['TURNSTILE_SECRET_KEY']?.trim();
  if (secret && !isUnresolvedRuntimeSecretPlaceholder(secret)) {
    return secret;
  }

  const secretRef = process.env['TURNSTILE_SECRET_KEY_REF']?.trim();
  if (secretRef) {
    return resolveRuntimeConfigReference({
      name: 'TURNSTILE_SECRET_KEY',
      reference: secretRef,
    });
  }

  throw new ApiError(ErrorCode.INTERNAL_ERROR, 500, 'Turnstile secret key is not configured');
}

function assertTokenPresent(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile token is required');
  }
}

export async function validateTurnstileToken(options: ValidateTurnstileOptions): Promise<void> {
  if (shouldBypassTurnstile()) {
    return;
  }

  const secret = getTurnstileSecret();
  assertTokenPresent(options.token);

  const payload = new URLSearchParams();
  payload.append('secret', secret);
  payload.append('response', options.token);
  if (options.remoteIp) {
    payload.append('remoteip', options.remoteIp);
  }

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload,
      cache: 'no-store',
    });
  } catch (error) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification failed', { cause: error });
  }

  if (!response.ok) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, response.status, 'Turnstile verification failed');
  }

  let rawResult: unknown;
  try {
    rawResult = await response.json();
  } catch (error) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification returned malformed response', {
      cause: error,
    });
  }

  const result = parseTurnstileSiteVerifyResponse(rawResult);
  if (!result) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification returned malformed response');
  }
  if (!result.success) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification failed', {
      errorCodes: result['error-codes'] || [],
    });
  }

  if (options.expectedAction) {
    assertExpectedActionMatches(result.action, options.expectedAction);
  }

  const allowedHostnames = getAllowedHostnames();
  if (allowedHostnames.size > 0) {
    assertHostnameAllowed(result.hostname, allowedHostnames);
  }
}

export function extractTurnstileToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const asRecord = payload as Record<string, unknown> & {
    turnstileToken?: unknown;
    cfTurnstileResponse?: unknown;
    'cf-turnstile-response'?: unknown;
  };
  const candidates = [asRecord.turnstileToken, asRecord['cf-turnstile-response'], asRecord.cfTurnstileResponse];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeIpCandidate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/^"+|"+$/g, '');
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  if (trimmed.startsWith('[')) {
    const bracketEnd = trimmed.indexOf(']');
    if (bracketEnd > 1) {
      const ipv6 = trimmed.slice(1, bracketEnd);
      return isIP(ipv6) === 6 ? ipv6 : null;
    }
    return null;
  }

  if (isIP(trimmed) > 0) {
    return trimmed;
  }

  const maybeIpv4WithPort = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (maybeIpv4WithPort) {
    const ip = maybeIpv4WithPort[1];
    return ip && isIP(ip) === 4 ? ip : null;
  }

  return null;
}

/**
 * Resolve client IP from request headers with optional fallback value.
 */
export function getRequestIp(headers: Headers, fallbackIp?: string | null): string | undefined {
  const trustedProxyMode = resolveTrustedProxyMode();
  const normalizedFallback = normalizeIpCandidate(fallbackIp);

  if (trustedProxyMode === 'cloudflare' || trustedProxyMode === 'both') {
    const cfConnectingIp = normalizeIpCandidate(headers.get('cf-connecting-ip'));
    if (cfConnectingIp) {
      return cfConnectingIp;
    }
  }

  if (trustedProxyMode === 'api-gateway') {
    return normalizedFallback ?? undefined;
  }

  if (normalizedFallback) {
    return normalizedFallback;
  }

  return undefined;
}
