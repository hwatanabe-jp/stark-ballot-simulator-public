/**
 * Singleton store instance shared across all API routes
 */

import { MockSessionStore } from './mockSessionStore';
import { FileMockSessionStore } from './fileMockSessionStore';
import { DynamoSessionStore } from './dynamoSessionStore';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { logger } from '@stark-ballot/diagnostics/logger';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';

export type ApiSessionStore = VoteStore &
  FinalizationStore &
  FinalizationResultStore &
  AwsFinalizationDeliveryMetadataStore &
  AwsFinalizationRuntimeTransitionStore;

// Use global to persist across hot reloads in development
declare global {
  var __globalStoreInstance: ApiSessionStore | undefined;
}

export function getGlobalStore(): ApiSessionStore {
  if (!global.__globalStoreInstance) {
    validateEnv();
    if (process.env['USE_MOCK_STORE'] === 'true') {
      // Use file-based persistence in production mode for E2E tests
      if (process.env['NODE_ENV'] === 'production' && process.env['PERSIST_MOCK_STORE'] === '1') {
        logger.info('[Store] Creating new FileMockSessionStore (singleton, file-persisted)');
        global.__globalStoreInstance = new FileMockSessionStore();
      } else {
        logger.info('[Store] Creating new MockSessionStore (singleton, in-memory)');
        global.__globalStoreInstance = new MockSessionStore();
      }
    } else {
      try {
        logger.info('[Store] Creating new DynamoSessionStore (singleton)');
        global.__globalStoreInstance = new DynamoSessionStore();
      } catch (error) {
        throw new Error(
          'Failed to initialize DynamoSessionStore. Set USE_MOCK_STORE=true to use a mock store explicitly.',
          { cause: error },
        );
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
