import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import { resolveRuntimeConfigReference } from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
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

  let hostname: string;
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

function getAllowedHostnames(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): Set<string> {
  const configured =
    profile.external.kind === 'aws'
      ? profile.external.turnstileAllowedHostnames
      : (env['TURNSTILE_ALLOWED_HOSTNAMES']?.split(',') ?? []);
  const values = configured.map((entry) => normalizeHostname(entry)).filter((entry): entry is string => Boolean(entry));

  return new Set(values);
}

function assertExpectedActionMatches(actual: string | undefined, expected: string): void {
  const normalizedExpected = expected.trim();
  if (!normalizedExpected) {
    return;
  }
  const normalizedActual = actual?.trim();
  if (!normalizedActual || normalizedActual !== normalizedExpected) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile action mismatch');
  }
}

function assertHostnameAllowed(hostname: string | undefined, allowedHostnames: Set<string>): void {
  if (allowedHostnames.size === 0) {
    return;
  }
  const normalizedHostname = hostname ? normalizeHostname(hostname) : null;
  if (!normalizedHostname || !allowedHostnames.has(normalizedHostname)) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile hostname mismatch');
  }
}

function shouldBypassTurnstile(profile: ResolvedRuntimeProfile): boolean {
  return profile.turnstile.mode === 'bypass' && profile.turnstile.bypassEligible;
}

const TRUSTED_PROXY_ALIASES = new Map<string, TrustedProxyMode>([
  ['api-gateway', 'api-gateway'],
  ['apigateway', 'api-gateway'],
  ['apigw', 'api-gateway'],
  ['aws', 'api-gateway'],
  ['true', 'api-gateway'],
  ['1', 'api-gateway'],
  ['yes', 'api-gateway'],
  ['on', 'api-gateway'],
  ['cloudflare', 'cloudflare'],
  ['cf', 'cloudflare'],
  ['both', 'both'],
  ['all', 'both'],
  ['any', 'both'],
  ['none', 'none'],
  ['false', 'none'],
  ['0', 'none'],
  ['off', 'none'],
]);

function parseTrustedProxyMode(raw: string | undefined): TrustedProxyMode {
  return TRUSTED_PROXY_ALIASES.get(raw?.trim().toLowerCase() ?? '') ?? 'none';
}

function resolveTrustedProxyMode(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): TrustedProxyMode {
  return parseTrustedProxyMode(profile.external.kind === 'aws' ? profile.external.trustedProxy : env['TRUSTED_PROXY']);
}

function getTurnstileSecret(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): string {
  const secret = env['TURNSTILE_SECRET_KEY']?.trim();
  if (profile.external.kind === 'aws') {
    if (secret) {
      throw new ApiError(ErrorCode.INTERNAL_ERROR, 500, 'Turnstile secret key must use its target runtime reference');
    }
    try {
      return resolveRuntimeConfigReference({
        name: 'TURNSTILE_SECRET_KEY',
        reference: profile.external.secretReferences.turnstileSecretKey,
      });
    } catch {
      throw new ApiError(ErrorCode.INTERNAL_ERROR, 500, 'Turnstile secret key is not configured');
    }
  }
  if (secret && !isUnresolvedRuntimeSecretPlaceholder(secret)) {
    return secret;
  }

  const secretRef = env['TURNSTILE_SECRET_KEY_REF']?.trim();
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

export async function validateTurnstileToken(
  profile: ResolvedRuntimeProfile,
  options: ValidateTurnstileOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (shouldBypassTurnstile(profile)) {
    return;
  }

  const secret = getTurnstileSecret(profile, env);
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
  } catch {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification failed');
  }

  if (!response.ok) {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, response.status, 'Turnstile verification failed');
  }

  let rawResult: unknown;
  try {
    rawResult = await response.json();
  } catch {
    throw new ApiError(ErrorCode.CAPTCHA_FAILED, 403, 'Turnstile verification returned malformed response');
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

  const allowedHostnames = getAllowedHostnames(profile, env);
  if (allowedHostnames.size > 0) {
    assertHostnameAllowed(result.hostname, allowedHostnames);
  }
}

export function extractTurnstileToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const token = (payload as Record<string, unknown>)['turnstileToken'];
  return typeof token === 'string' && token.trim().length > 0 ? token : undefined;
}

function normalizeBracketedAddress(value: string): string | null {
  const bracketEnd = value.indexOf(']');
  if (bracketEnd <= 1) return null;
  const ipv6 = value.slice(1, bracketEnd);
  return isIP(ipv6) === 6 ? ipv6 : null;
}

function normalizeIpCandidate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/^"+|"+$/g, '');
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  if (trimmed.startsWith('[')) return normalizeBracketedAddress(trimmed);

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
export function getRequestIp(
  profile: ResolvedRuntimeProfile,
  headers: Headers,
  fallbackIp?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trustedProxyMode = resolveTrustedProxyMode(profile, env);
  const normalizedFallback = normalizeIpCandidate(fallbackIp);

  if (trustedProxyMode === 'cloudflare') {
    // This mode requires the authenticated Cloudflare -> CloudFront origin path.
    // A missing or malformed header must not collapse callers onto a proxy IP.
    const clientIp = headers.get('cf-connecting-ip');
    return clientIp && isIP(clientIp) > 0 ? clientIp : undefined;
  }

  if (trustedProxyMode === 'both') {
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
