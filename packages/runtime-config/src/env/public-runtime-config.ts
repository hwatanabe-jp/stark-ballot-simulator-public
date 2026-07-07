export const BROWSER_PUBLIC_ENV_KEYS = [
  'VITE_API_BASE_URL',
  'VITE_APP_ENV',
  'VITE_CONTRACT_GENERATION',
  'VITE_SESSION_CREATE_TURNSTILE_REQUIRED',
  'VITE_STH_MIN_MATCHES',
  'VITE_STH_SOURCES',
  'VITE_TURNSTILE_BYPASS',
  'VITE_TURNSTILE_SITE_KEY',
  'VITE_USE_MOCK_API',
] as const;

export type BrowserPublicEnvKey = (typeof BROWSER_PUBLIC_ENV_KEYS)[number];

export type PublicRuntimeEnvKey = BrowserPublicEnvKey;

type ImportMetaPublicEnv = Partial<Record<PublicRuntimeEnvKey | 'MODE', string | undefined>>;

const testEnvOverrides = new Map<PublicRuntimeEnvKey, string>();

function readImportMetaEnv(): ImportMetaPublicEnv | undefined {
  return (import.meta as Omit<ImportMeta, 'env'> & { env?: ImportMetaPublicEnv }).env;
}

function assertPublicRuntimeEnvTestMode(): void {
  if (readImportMetaEnv()?.MODE !== 'test') {
    throw new Error('Public runtime env test overrides are only available in test mode');
  }
}

function readPublicRuntimeEnvKey(key: PublicRuntimeEnvKey): string | undefined {
  const importMetaEnv = readImportMetaEnv();
  if (importMetaEnv?.MODE === 'test' && testEnvOverrides.has(key)) {
    return testEnvOverrides.get(key);
  }

  return importMetaEnv?.[key];
}

export function setPublicRuntimeEnvForTests(key: PublicRuntimeEnvKey, value: string): void {
  assertPublicRuntimeEnvTestMode();
  testEnvOverrides.set(key, value);
}

export function clearPublicRuntimeEnvForTests(): void {
  assertPublicRuntimeEnvTestMode();
  testEnvOverrides.clear();
}

export function readPublicRuntimeEnv(key: BrowserPublicEnvKey): string | undefined {
  return readPublicRuntimeEnvKey(key);
}

export function readPublicRuntimeFlag(key: BrowserPublicEnvKey): boolean {
  const value = readPublicRuntimeEnv(key);
  return value === '1' || value === 'true';
}
