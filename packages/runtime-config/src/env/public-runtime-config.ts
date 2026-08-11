import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';

export const BROWSER_PUBLIC_ENV_KEYS = [
  'VITE_API_BASE_URL',
  'VITE_APP_ENV',
  'VITE_DEPLOYMENT_ID',
  'VITE_RUNTIME_PROFILE',
  'VITE_STH_MIN_MATCHES',
  'VITE_STH_SOURCES',
  'VITE_TURNSTILE_SITE_KEY',
] as const;

export type BrowserPublicEnvKey = (typeof BROWSER_PUBLIC_ENV_KEYS)[number];

export type PublicRuntimeEnvKey = BrowserPublicEnvKey;

export const SUPPORTED_BROWSER_RUNTIME_PROFILES = Object.freeze([
  'local-demo',
  'static-mock-e2e',
  'local-proof-development',
  'local-proof-production',
  'target-aws-async',
] as const);

export type BrowserRuntimeProfileSelector = (typeof SUPPORTED_BROWSER_RUNTIME_PROFILES)[number];
export type BrowserApiMode = 'mock' | 'same-origin';
export type BrowserTargetEnvironment = 'develop' | 'main';

interface BrowserRuntimeProfileBase {
  readonly name: BrowserRuntimeProfileSelector;
  readonly apiMode: BrowserApiMode;
  readonly turnstile: Readonly<{
    bypassEligible: boolean;
    requiredForActions: boolean;
  }>;
}

interface LocalBrowserRuntimeProfile extends BrowserRuntimeProfileBase {
  readonly name: Exclude<BrowserRuntimeProfileSelector, 'target-aws-async'>;
}

interface TargetBrowserRuntimeProfile extends BrowserRuntimeProfileBase {
  readonly name: 'target-aws-async';
  readonly appEnvironment: BrowserTargetEnvironment;
}

export type BrowserRuntimeProfile = LocalBrowserRuntimeProfile | TargetBrowserRuntimeProfile;

type ImportMetaPublicEnv = Partial<Record<PublicRuntimeEnvKey | 'MODE', string | undefined>>;

const testEnvOverrides = new Map<PublicRuntimeEnvKey, string | undefined>();

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

export function setPublicRuntimeEnvForTests(key: PublicRuntimeEnvKey, value: string | undefined): void {
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

function configError(name: BrowserPublicEnvKey, message: string): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError([name], undefined, message);
}

function readTrimmedPublicRuntimeEnv(key: BrowserPublicEnvKey): string | undefined {
  const value = readPublicRuntimeEnv(key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isBrowserRuntimeProfileSelector(value: string): value is BrowserRuntimeProfileSelector {
  return SUPPORTED_BROWSER_RUNTIME_PROFILES.some((profile) => profile === value);
}

function freezeProjection<T extends BrowserRuntimeProfile>(profile: T): T {
  Object.freeze(profile.turnstile);
  return Object.freeze(profile);
}

export function resolveBrowserRuntimeProfile(): BrowserRuntimeProfile {
  const selector = readTrimmedPublicRuntimeEnv('VITE_RUNTIME_PROFILE');
  if (!selector || !isBrowserRuntimeProfileSelector(selector)) {
    throw configError('VITE_RUNTIME_PROFILE', 'VITE_RUNTIME_PROFILE must select a supported semantic runtime profile.');
  }

  if (selector === 'target-aws-async') {
    const appEnvironment = readTrimmedPublicRuntimeEnv('VITE_APP_ENV');
    if (appEnvironment !== 'develop' && appEnvironment !== 'main') {
      throw configError('VITE_APP_ENV', 'VITE_APP_ENV must be develop or main for target-aws-async.');
    }
    return freezeProjection({
      name: selector,
      appEnvironment,
      apiMode: 'same-origin',
      turnstile: {
        bypassEligible: false,
        requiredForActions: appEnvironment === 'main',
      },
    });
  }

  return freezeProjection({
    name: selector,
    apiMode: selector === 'local-demo' ? 'mock' : 'same-origin',
    turnstile: {
      bypassEligible: true,
      requiredForActions: false,
    },
  });
}
