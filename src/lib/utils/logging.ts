import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_LOG_SALT = 'stark-ballot-log-salt';
const HASH_LENGTH = 12;

export function resolveLogSalt(): string {
  const explicit = process.env.LOG_IP_HASH_SALT?.trim();
  if (explicit) {
    return explicit;
  }
  const debugSecret = process.env.DEBUG_LOG_SECRET?.trim();
  if (debugSecret) {
    return debugSecret;
  }
  return DEFAULT_LOG_SALT;
}

function hashValueForLogging(prefix: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return `${prefix}_unknown`;
  }
  const salt = resolveLogSalt();
  const digest = createHash('sha256').update(salt).update('|').update(normalized).digest('hex');
  return `${prefix}_${digest.slice(0, HASH_LENGTH)}`;
}

export function hashIpForLogging(ip: string): string {
  return hashValueForLogging('ip', ip);
}

export function hashKeyPrefixForLogging(prefix: string): string {
  return hashValueForLogging('key', prefix);
}

export function resolveRequestId(headers: Headers): string {
  const direct = headers.get('x-request-id') ?? headers.get('x-amzn-requestid');
  if (direct && direct.trim().length > 0) {
    return direct.trim();
  }
  const traceId = headers.get('x-amzn-trace-id');
  if (traceId) {
    const match = traceId.match(/Root=([^;]+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return randomUUID();
}
