import { readBrowserPublicEnv } from '@stark-ballot/runtime-config/env/browserPublic';
import {
  DEFAULT_CONTRACT_GENERATION,
  normalizeContractGeneration,
} from '@stark-ballot/web/session/contractGenerationConstants';

/**
 * Resolve the browser-public contract generation for this deployed frontend.
 *
 * The server authority remains CONTRACT_GENERATION. Deployment must project the
 * matching value into VITE_CONTRACT_GENERATION when it differs from the shared
 * repository default.
 */
export function resolveBrowserCurrentContractGeneration(): string {
  return normalizeContractGeneration(readBrowserPublicEnv('VITE_CONTRACT_GENERATION')) ?? DEFAULT_CONTRACT_GENERATION;
}

export function isBrowserCurrentContractGeneration(value: string | null | undefined): boolean {
  return value === resolveBrowserCurrentContractGeneration();
}
