export const PUBLIC_DEFAULT_LOG_SALT = 'stark-ballot-log-salt';

export function isPublicDefaultLogSalt(value: string | undefined): boolean {
  return value?.trim() === PUBLIC_DEFAULT_LOG_SALT;
}
