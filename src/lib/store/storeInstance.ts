/**
 * Singleton store instance shared across all API routes
 */

import { MockSessionStore } from './mockSessionStore';
import { FileMockSessionStore } from './fileMockSessionStore';
import { AmplifySessionStore } from './amplifySessionStore';
import type { VoteStore } from '@/types/voteStore';
import { logger } from '@/lib/utils/logger';
import { validateEnv } from '@/lib/env/validate';

// Use global to persist across hot reloads in development
declare global {
  var __globalStoreInstance: VoteStore | undefined;
}

export function getGlobalStore(): VoteStore {
  if (!global.__globalStoreInstance) {
    validateEnv();
    if (process.env.USE_MOCK_STORE === 'true') {
      // Use file-based persistence in production mode for E2E tests
      if (process.env.NODE_ENV === 'production' && process.env.PERSIST_MOCK_STORE === '1') {
        logger.info('[Store] Creating new FileMockSessionStore (singleton, file-persisted)');
        global.__globalStoreInstance = new FileMockSessionStore();
      } else {
        logger.info('[Store] Creating new MockSessionStore (singleton, in-memory)');
        global.__globalStoreInstance = new MockSessionStore();
      }
    } else {
      try {
        const useAmplify = process.env.USE_AMPLIFY_DATA !== 'false';
        if (useAmplify) {
          logger.info('[Store] Creating new AmplifySessionStore (singleton)');
          global.__globalStoreInstance = new AmplifySessionStore();
        } else {
          logger.info('[Store] USE_AMPLIFY_DATA explicitly false; using MockSessionStore');
          global.__globalStoreInstance = new MockSessionStore();
        }
      } catch (error) {
        logger.warn('[Store] Failed to initialize AmplifySessionStore, falling back to MockSessionStore:', error);
        global.__globalStoreInstance = new MockSessionStore();
      }
    }
  } else {
    logger.info('[Store] Reusing existing store instance');
  }
  return global.__globalStoreInstance;
}

// Reset the store (useful for testing)
export function resetGlobalStore(): void {
  global.__globalStoreInstance = undefined;
}
