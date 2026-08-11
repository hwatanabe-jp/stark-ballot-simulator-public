/**
 * Singleton store instance shared across all API routes
 */

import { MockSessionStore } from './mockSessionStore';
import { FileMockSessionStore } from './fileMockSessionStore';
import { DynamoSessionStore } from './dynamoSessionStore';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type {
  AwsFinalizationRuntimeMetadataStore,
  AwsFinalizationRuntimeTransitionStore,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { logger } from '@stark-ballot/diagnostics/logger';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { getSharedDynamoDocumentClient } from '@stark-ballot/aws-adapters/aws/dynamodbConfig';

export type ApiSessionStore = VoteStore &
  FinalizationStore &
  VerificationResultStore &
  AwsFinalizationDeliveryMetadataStore &
  AwsFinalizationRuntimeMetadataStore &
  AwsFinalizationRuntimeTransitionStore;

// Use global to persist across hot reloads in development
declare global {
  var __globalStoreInstance: ApiSessionStore | undefined;
}

export function getGlobalStore(profile: ResolvedRuntimeProfile): ApiSessionStore {
  if (!global.__globalStoreInstance) {
    validateEnv(profile);
    switch (profile.sessionStore.kind) {
      case 'file':
        logger.info('[Store] Creating new FileMockSessionStore (singleton, file-persisted)');
        global.__globalStoreInstance = new FileMockSessionStore();
        break;
      case 'memory':
        logger.info('[Store] Creating new MockSessionStore (singleton, in-memory)');
        global.__globalStoreInstance = new MockSessionStore();
        break;
      case 'dynamo':
        try {
          if (profile.external.kind !== 'aws') {
            throw new Error('The DynamoDB session store requires a target AWS runtime profile.');
          }
          logger.info('[Store] Creating new DynamoSessionStore (singleton)');
          global.__globalStoreInstance = new DynamoSessionStore({
            documentClient: getSharedDynamoDocumentClient(profile),
            sessionsTableName: profile.external.dynamo.sessionsTable,
            votesTableName: profile.external.dynamo.votesTable,
          });
        } catch (error) {
          throw new Error('Failed to initialize the target DynamoSessionStore selected by the runtime profile.', {
            cause: error,
          });
        }
        break;
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
