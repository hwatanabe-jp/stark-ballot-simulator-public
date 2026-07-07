import {
  clearPublicRuntimeEnvForTests,
  readPublicRuntimeEnv,
  readPublicRuntimeFlag,
  setPublicRuntimeEnvForTests,
  type BrowserPublicEnvKey,
  type PublicRuntimeEnvKey,
} from './publicRuntimeConfig';

type BrowserEnvKey = PublicRuntimeEnvKey;

export function setBrowserPublicEnvForTests(key: BrowserEnvKey, value: string): void {
  setPublicRuntimeEnvForTests(key, value);
}

export function clearBrowserPublicEnvForTests(): void {
  clearPublicRuntimeEnvForTests();
}

export function readBrowserPublicEnv(key: BrowserPublicEnvKey): string | undefined {
  return readPublicRuntimeEnv(key);
}

export function readBrowserPublicFlag(key: BrowserPublicEnvKey): boolean {
  return readPublicRuntimeFlag(key);
}
