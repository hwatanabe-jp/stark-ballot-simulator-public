export type Language = 'ja' | 'en';

export const LANGUAGE_STORAGE_KEY = 'stark-ballot-lang';
export const LANGUAGE_COOKIE_NAME = 'stark-ballot-lang';

export function normalizeLanguage(value: string | null | undefined): Language | null {
  if (!value) {
    return null;
  }
  if (value === 'ja' || value === 'en') {
    return value;
  }
  const lower = value.toLowerCase();
  if (lower.startsWith('ja')) {
    return 'ja';
  }
  if (lower.startsWith('en')) {
    return 'en';
  }
  return null;
}

export function parseAcceptLanguage(value: string | null | undefined): Language | null {
  if (!value) {
    return null;
  }
  const primary = value.split(',')[0]?.trim();
  return normalizeLanguage(primary);
}

export function resolveInitialLanguage({
  cookie,
  storage,
  acceptLanguage,
}: {
  cookie?: string | null;
  storage?: string | null;
  acceptLanguage?: string | null;
}): Language {
  // Priority: cookie > storage > Accept-Language header > default 'en'
  // Non-Japanese/English browsers fall back to English as international default
  return normalizeLanguage(cookie) ?? normalizeLanguage(storage) ?? parseAcceptLanguage(acceptLanguage) ?? 'en';
}

export function buildLanguageCookie(value: Language): string {
  return `${LANGUAGE_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
