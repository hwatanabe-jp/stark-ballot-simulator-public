import {
  createMockVoteStore as createApplicationMockVoteStore,
  type MockVoteStore as ApplicationMockVoteStore,
} from '@stark-ballot/application/finalize/test-support/mockVoteStore';
import type {
  FinalizationFailedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type {
  AwsFinalizationDeliveryMetadataStore,
  AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type {
  AwsFinalizationRuntimeMetadata,
  AwsFinalizationRuntimeMetadataStore,
  AwsFinalizationRuntimeTransitionStore,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';

export type MockVoteStore = ApplicationMockVoteStore &
  AwsFinalizationRuntimeTransitionStore &
  AwsFinalizationRuntimeMetadataStore &
  AwsFinalizationDeliveryMetadataStore;

function buildScopedKey(sessionId: string, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

/**
 * Extends the application-owned lifecycle mock with API/AWS adapter ports.
 *
 * Keeping this extension under the API test tree prevents lower-level test
 * support from depending upward on application and AWS adapter packages.
 */
export function createMockVoteStore(overrides: Partial<MockVoteStore> = {}): MockVoteStore {
  const applicationStore = createApplicationMockVoteStore(overrides);
  const runtimeMetadataRecords = new Map<string, AwsFinalizationRuntimeMetadata>();
  const deliveryMetadataRecords = new Map<string, AwsVerificationDeliveryMetadataInput>();

  const baseStore: MockVoteStore = {
    ...applicationStore,
    markAwsFinalizationRunning: async (sessionId, payload) => {
      const { stepFunctionsArn, ...payloadWithoutRuntimeMetadata } = payload;
      const semanticPayload: FinalizationRunningPayload = {
        ...payloadWithoutRuntimeMetadata,
      };
      const record = await store.markFinalizationRunning(sessionId, semanticPayload);
      if (record.finalizationId === payload.finalizationId && record.state.status === 'running' && stepFunctionsArn) {
        runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
      }
      return record.state;
    },
    markAwsFinalizationSucceeded: async (sessionId, payload) => {
      const { stepFunctionsArn, bundleMetadata, ...payloadWithoutRuntimeMetadata } = payload;
      const semanticPayload: FinalizationSucceededPayload = {
        ...payloadWithoutRuntimeMetadata,
      };
      const record = await store.markFinalizationSucceeded(sessionId, semanticPayload);
      if (record.finalizationId === payload.finalizationId && record.state.status === 'succeeded') {
        runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), {
          ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
          ...(bundleMetadata ? { bundleMetadata: { ...bundleMetadata } } : {}),
        });
        if (bundleMetadata) {
          deliveryMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), {
            ...(bundleMetadata.s3BundleKey ? { s3BundleKey: bundleMetadata.s3BundleKey } : {}),
            ...(bundleMetadata.s3UploadedAtMs === undefined ? {} : { s3UploadedAtMs: bundleMetadata.s3UploadedAtMs }),
          });
        }
      }
      return record.state;
    },
    markAwsFinalizationFailed: async (sessionId, payload) => {
      const { stepFunctionsArn, ...payloadWithoutRuntimeMetadata } = payload;
      const semanticPayload: FinalizationFailedPayload = {
        ...payloadWithoutRuntimeMetadata,
      };
      const record = await store.markFinalizationFailed(sessionId, semanticPayload);
      if (record.finalizationId === payload.finalizationId && record.state.status === 'failed' && stepFunctionsArn) {
        runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
      }
      return record.state;
    },
    markAwsFinalizationTimedOut: async (sessionId, payload) => {
      const { stepFunctionsArn, ...payloadWithoutRuntimeMetadata } = payload;
      const semanticPayload: FinalizationTimedOutPayload = {
        ...payloadWithoutRuntimeMetadata,
      };
      const record = await store.markFinalizationTimedOut(sessionId, semanticPayload);
      if (record.finalizationId === payload.finalizationId && record.state.status === 'timeout' && stepFunctionsArn) {
        runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
      }
      return record.state;
    },
    getAwsFinalizationRuntimeMetadata: (sessionId, finalizationId) => {
      const metadata = runtimeMetadataRecords.get(buildScopedKey(sessionId, finalizationId));
      return Promise.resolve(
        metadata
          ? {
              ...metadata,
              ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
            }
          : undefined,
      );
    },
    recordAwsProofBundlePublication: (sessionId, finalizationId, metadata) => {
      deliveryMetadataRecords.set(buildScopedKey(sessionId, finalizationId), { ...metadata });
      return Promise.resolve();
    },
    recordAwsVerificationDeliveryMetadata: (sessionId, finalizationId, metadata) => {
      deliveryMetadataRecords.set(buildScopedKey(sessionId, finalizationId), { ...metadata });
      return Promise.resolve();
    },
    getAwsVerificationDeliveryMetadata: (sessionId, finalizationId) =>
      Promise.resolve(deliveryMetadataRecords.get(buildScopedKey(sessionId, finalizationId))),
  };

  const store: MockVoteStore = {
    ...baseStore,
    ...overrides,
  };
  return store;
}
