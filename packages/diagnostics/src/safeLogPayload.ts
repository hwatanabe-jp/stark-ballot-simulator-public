export const SAFE_LOG_FALLBACK_RECORD =
  '{"level":"error","event":"log_sanitization_failed","message":"Log payload discarded"}';

export const MAX_LOG_BYTES = 32 * 1024;

const MAX_ARRAY_ITEMS = 32;
const MAX_DEPTH = 7;
const MAX_TRAVERSAL_ITEMS = 64;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 2_048;
const MAX_ERROR_NAME_LENGTH = 256;
const MAX_ERROR_STACK_LENGTH = 8_192;
const REDACTED = '[REDACTED]';
const OMIT_VALUE = Symbol('omit-log-value');

const EXACT_DENIED_KEYS = new Set([
  'cfconnectingip',
  'cfturnstileresponse',
  'choice',
  'clientaddress',
  'clientip',
  'clientipaddress',
  'clientturnstiletoken',
  'callbackbody',
  'callbackpayload',
  'body',
  'decodedpayload',
  'forwarded',
  'functionerrorpayload',
  'ip',
  'key',
  'originip',
  'originipaddress',
  'payload',
  'rand',
  'rawbody',
  'rawpayload',
  'referer',
  'referrer',
  'remoteip',
  'remoteaddress',
  'remoteipaddress',
  'requestbody',
  'requestpayload',
  'responsebody',
  'responsepayload',
  'session',
  'sessionid',
  'sid',
  'sourceip',
  'sourceaddress',
  'sourceipaddress',
  'serializedbody',
  'serializedpayload',
  'token',
  'turnstileclienttoken',
  'turnstileresponse',
  'turnstiletoken',
  'trueclientip',
  'vote',
  'xforwardedfor',
  'xrealip',
]);
const SUBSTRING_DENIED_KEYS = [
  'authorization',
  'capability',
  'cookie',
  'salt',
  'secret',
  'sessionid',
  'signature',
] as const;
const SESSION_HASH_KEYS = new Set([
  'actualsessionidhash',
  'expectedsessionidhash',
  'keysessionidhash',
  'sessionidhash',
  'valuesessionidhash',
]);
const IP_HASH_KEYS = new Set(['iphash', 'sourceiphash']);
const KEY_HASH_KEYS = new Set([
  'basepathhash',
  'bundlekeyprefix',
  'filepathhash',
  'keyprefix',
  'pathhash',
  'relativepathhash',
  'requestedpathhash',
  'resolvedpathhash',
]);
const PUBLIC_DIGEST_KEYS = new Set(['electionconfighash', 'journalhash', 'publicinputhash', 'receipthash']);
const PRIORITY_OBJECT_KEYS = ['event', 'error', 'message'] as const;
type SafeLogPrimitive = boolean | null | number | string;
export type SafeLogValue = SafeLogPrimitive | SafeLogValue[] | SafeLogObject;
export interface SafeLogObject {
  [key: string]: SafeLogValue;
}

interface SanitizationState {
  traversalItemsRemaining: number;
  seen: WeakSet<object>;
}

export interface LogSanitizer {
  hasCapacity: () => boolean;
  sanitize: (value: unknown, options?: SanitizeLogValueOptions) => SafeLogValue | undefined;
}

export interface SanitizeLogValueOptions {
  includeErrorStack?: boolean;
}

function createSafeLogObject(): SafeLogObject {
  return Object.create(null) as SafeLogObject;
}

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

type DerivedValueKind = 'digest' | 'ip' | 'key' | 'session';

function getDerivedValueKind(normalizedKey: string): DerivedValueKind | undefined {
  if (SESSION_HASH_KEYS.has(normalizedKey)) {
    return 'session';
  }
  if (IP_HASH_KEYS.has(normalizedKey)) {
    return 'ip';
  }
  if (KEY_HASH_KEYS.has(normalizedKey)) {
    return 'key';
  }
  if (PUBLIC_DIGEST_KEYS.has(normalizedKey)) {
    return 'digest';
  }
  return undefined;
}

function isApprovedDerivedValue(kind: DerivedValueKind, value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (kind === 'session') {
    return /^sid_(?:[0-9a-f]{12}|unknown)$/.test(value);
  }
  if (kind === 'ip') {
    return /^ip_(?:[0-9a-f]{12}|unknown)$/.test(value);
  }
  if (kind === 'key') {
    return /^key_(?:[0-9a-f]{12}|unknown)$/.test(value);
  }
  return /^(?:0x)?[0-9a-f]{8,128}(?:\.\.\.)?$/i.test(value);
}

function isDeniedKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (getDerivedValueKind(normalized)) {
    return false;
  }
  if (EXACT_DENIED_KEYS.has(normalized) || SUBSTRING_DENIED_KEYS.some((part) => normalized.includes(part))) {
    return true;
  }
  if (
    normalized.includes('timestamp') &&
    ['callback', 'finalization', 'finalize', 'header', 'writer'].some((part) => normalized.includes(part))
  ) {
    return true;
  }
  return normalized.endsWith('hash') || normalized.endsWith('key') || normalized.endsWith('keyprefix');
}

const SENSITIVE_VALUE_PATTERNS = [
  /s3:\/\/[^\s"'<>]+/i,
  /https?:\/\/(?:[^/?#\s"'<>]+\.)?s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?\/[^\s"'<>]*/i,
  /(?:^|[\s"'(])sessions\/[^\s"'<>/?#]+\/[^\s"'<>]*/i,
  /\/api\/sessions\/[^/?#\s"'<>]+(?:\/[^?#\s"'<>]*)?/i,
  /\/api\/(?:[^/:?#\s"'<>]+\/){3,}[^/:?#\s"'<>]+/i,
  /\b(?:session(?:[\s_-]?id)?|sid)\b[^\r\n]{0,48}\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /[?&](?:X-Amz-(?:Algorithm|Credential|Security-Token|Signature)|AWSAccessKeyId)=/i,
  /\bBearer\s+\S+/i,
  /\bv1\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})?/i,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /(?:^|[^\d])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?=$|[^\d])/i,
  /(?:^|[\s[(])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?=$|[\s\])])/i,
  /(?:^|[\s[(])::(?:ffff:)?[0-9a-f:.]+(?=$|[\s\])])/i,
];

function hasSensitiveValueShape(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function hasCanonicalSessionSegment(segments: readonly string[]): boolean {
  const sessionsIndex = segments.indexOf('sessions');
  if (sessionsIndex >= 0 && segments[sessionsIndex + 1] !== ':sessionId') {
    return false;
  }
  const sessionIdIndex = segments.indexOf(':sessionId');
  if (sessionIdIndex >= 0 && segments[sessionIdIndex - 1] !== 'sessions') {
    return false;
  }
  return true;
}

function hasCanonicalFinalizationSegment(segments: readonly string[]): boolean {
  const finalizationsIndex = segments.indexOf('finalizations');
  if (
    finalizationsIndex >= 0 &&
    segments[finalizationsIndex + 1] !== 'current' &&
    segments[finalizationsIndex + 1] !== ':finalizationId'
  ) {
    return false;
  }
  const finalizationIdIndex = segments.indexOf(':finalizationId');
  if (finalizationIdIndex >= 0 && segments[finalizationIdIndex - 1] !== 'finalizations') {
    return false;
  }
  return true;
}

function isCanonicalHttpRouteTemplate(value: string): boolean {
  if (!value.startsWith('/api/') || value.length > 512 || !value.includes('/:')) {
    return false;
  }
  const segments = value.split('/').slice(1);
  if (
    segments.some((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment),
    )
  ) {
    return false;
  }
  if (!hasCanonicalSessionSegment(segments) || !hasCanonicalFinalizationSegment(segments)) return false;
  return segments.every(
    (segment) => /^[a-z0-9._-]+$/i.test(segment) || /^:[a-z][a-z0-9_]*$/i.test(segment) || segment === '*',
  );
}

export function sanitizeLogString(value: string, maxLength = MAX_STRING_LENGTH): string {
  if (hasSensitiveValueShape(value)) {
    return REDACTED;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}[Truncated]`;
}

function consumeTraversalItem(state: SanitizationState): boolean {
  if (state.traversalItemsRemaining <= 0) {
    return false;
  }
  state.traversalItemsRemaining -= 1;
  return true;
}

function sanitizeError(error: Error, state: SanitizationState, options: SanitizeLogValueOptions): SafeLogObject {
  const payload = createSafeLogObject();
  if (consumeTraversalItem(state)) {
    payload['name'] = sanitizeLogString(error.name || 'Error', MAX_ERROR_NAME_LENGTH);
  }
  if (consumeTraversalItem(state)) {
    payload['message'] = sanitizeLogString(error.message, MAX_STRING_LENGTH);
  }
  if (options.includeErrorStack && error.stack !== undefined && consumeTraversalItem(state)) {
    payload['stack'] = sanitizeLogString(error.stack, MAX_ERROR_STACK_LENGTH);
  }
  return payload;
}

function sanitizeArray(
  value: unknown[],
  state: SanitizationState,
  depth: number,
  options: SanitizeLogValueOptions,
): SafeLogValue[] {
  const output: SafeLogValue[] = [];
  const itemCount = Math.min(value.length, MAX_ARRAY_ITEMS);
  let index = 0;
  for (; index < itemCount; index += 1) {
    if (!consumeTraversalItem(state)) {
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      output.push(null);
      continue;
    }
    if (!('value' in descriptor)) {
      output.push('[Accessor]');
      continue;
    }
    const sanitized = sanitizeValue(descriptor.value, state, depth + 1, options, false);
    if (sanitized !== OMIT_VALUE) {
      output.push(sanitized);
    }
  }
  if (value.length > index) {
    output.push('[Truncated: items]');
  }
  return output;
}

function isSafeRouteTemplateField(key: string, value: unknown): value is string {
  return normalizeKey(key) === 'path' && typeof value === 'string' && isCanonicalHttpRouteTemplate(value);
}

function sanitizeObject(
  value: object,
  state: SanitizationState,
  depth: number,
  options: SanitizeLogValueOptions,
): SafeLogObject {
  const output = createSafeLogObject();
  let truncated = false;
  const processedPriorityKeys = new Set<string>();

  const sanitizeField = (key: string, descriptor: PropertyDescriptor | undefined): void => {
    const safeKey = sanitizeLogString(key, MAX_KEY_LENGTH);
    if (!descriptor) {
      return;
    }
    const derivedValueKind = getDerivedValueKind(normalizeKey(key));
    if (derivedValueKind) {
      output[safeKey] =
        'value' in descriptor && isApprovedDerivedValue(derivedValueKind, descriptor.value)
          ? sanitizeLogString(descriptor.value)
          : REDACTED;
      return;
    }
    if (isDeniedKey(key)) {
      output[safeKey] = REDACTED;
      return;
    }
    if (!('value' in descriptor)) {
      output[safeKey] = '[Accessor]';
      return;
    }
    if (isSafeRouteTemplateField(key, descriptor.value)) {
      output[safeKey] = descriptor.value;
      return;
    }
    const sanitized = sanitizeValue(descriptor.value, state, depth + 1, options, false);
    if (sanitized !== OMIT_VALUE) {
      output[safeKey] = sanitized;
    }
  };

  for (const key of PRIORITY_OBJECT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if (!consumeTraversalItem(state)) {
      truncated = true;
      break;
    }
    processedPriorityKeys.add(key);
    sanitizeField(key, descriptor);
  }

  for (const key in value) {
    if (processedPriorityKeys.has(key)) {
      continue;
    }
    if (!consumeTraversalItem(state)) {
      truncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    sanitizeField(key, descriptor);
  }
  if (truncated) {
    output['_truncated'] = '[Truncated: fields]';
  }
  return output;
}

function sanitizeValue(
  value: unknown,
  state: SanitizationState,
  depth: number,
  options: SanitizeLogValueOptions,
  consumeCurrent = true,
): SafeLogValue | typeof OMIT_VALUE {
  if (consumeCurrent && !consumeTraversalItem(state)) {
    return OMIT_VALUE;
  }
  if (value === null || typeof value !== 'object') return sanitizePrimitive(value);
  return sanitizeObjectGraph(value, state, depth, options);
}

function sanitizePrimitive(value: unknown): SafeLogValue | typeof OMIT_VALUE {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return sanitizeLogString(value);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : '[Non-finite number]';
  }
  if (typeof value === 'bigint') {
    return sanitizeLogString(`${value.toString()}n`);
  }
  if (typeof value === 'symbol') {
    return '[Symbol]';
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  return OMIT_VALUE;
}

function sanitizeObjectGraph(
  value: object,
  state: SanitizationState,
  depth: number,
  options: SanitizeLogValueOptions,
): SafeLogValue {
  if (depth >= MAX_DEPTH) {
    return '[Truncated: depth]';
  }
  if (state.seen.has(value)) {
    return '[Circular]';
  }
  state.seen.add(value);

  if (value instanceof Error) {
    return sanitizeError(value, state, options);
  }
  if (Array.isArray(value)) {
    return sanitizeArray(value, state, depth, options);
  }
  return sanitizeObject(value, state, depth, options);
}

export function createLogSanitizer(): LogSanitizer {
  const state: SanitizationState = {
    traversalItemsRemaining: MAX_TRAVERSAL_ITEMS,
    seen: new WeakSet<object>(),
  };
  return {
    hasCapacity: (): boolean => state.traversalItemsRemaining > 0,
    sanitize: (value: unknown, options: SanitizeLogValueOptions = {}): SafeLogValue | undefined => {
      const sanitized = sanitizeValue(value, state, 0, options);
      return sanitized === OMIT_VALUE ? undefined : sanitized;
    },
  };
}

export function serializeBoundedLogValue(value: SafeLogValue): string {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8') <= MAX_LOG_BYTES ? serialized : SAFE_LOG_FALLBACK_RECORD;
}
