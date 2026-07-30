import { createHash } from 'node:crypto';
import { isPublicDefaultLogSalt, PUBLIC_DEFAULT_LOG_SALT } from '@stark-ballot/validation/log-hash-salt';

const HASH_LENGTH = 12;

type LogHashDomain = 'ip' | 'key' | 'sid';

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveLogSalt(configuredSalt?: string): string {
  return readNonEmpty(configuredSalt) ?? readNonEmpty(process.env['LOG_IP_HASH_SALT']) ?? PUBLIC_DEFAULT_LOG_SALT;
}

export { isPublicDefaultLogSalt };

function normalizeHashValue(domain: LogHashDomain, value: string): string {
  const trimmed = value.trim();
  return domain === 'key' ? trimmed : trimmed.toLowerCase();
}

function hashValueForLogging(domain: LogHashDomain, prefix: string, value: string, configuredSalt?: string): string {
  const normalized = normalizeHashValue(domain, value);
  if (!normalized) {
    return `${prefix}_unknown`;
  }
  const salt = resolveLogSalt(configuredSalt);
  const digest = createHash('sha256')
    .update(salt)
    .update('|')
    .update(domain)
    .update('|')
    .update(normalized)
    .digest('hex');
  return `${prefix}_${digest.slice(0, HASH_LENGTH)}`;
}

export function hashIpForLogging(ip: string, configuredSalt?: string): string {
  return hashValueForLogging('ip', 'ip', ip, configuredSalt);
}

export function hashKeyPrefixForLogging(prefix: string, configuredSalt?: string): string {
  return hashValueForLogging('key', 'key', prefix, configuredSalt);
}

export function hashSessionIdForLogging(sessionId: string, configuredSalt?: string): string {
  return hashValueForLogging('sid', 'sid', sessionId, configuredSalt);
}
