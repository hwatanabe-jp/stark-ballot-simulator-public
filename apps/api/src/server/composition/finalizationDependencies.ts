import { finalizeSessionUsecase } from '@stark-ballot/application/finalize/usecases/finalize-session';
import { createFinalizationQueue, type FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import { persistAsyncProverInputToS3 } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { publishProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/publishProverWorkMessage';
import { loadPublicImageIdMapping } from '@stark-ballot/node-adapters/image-id-mapping';
import { getDefaultExecutor } from '@stark-ballot/node-adapters/zkvm/executor-factory';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ApiContextStore } from '../api/context';
import {
  enforceFinalizeCancelRateLimit,
  enforceFinalizeRateLimit,
  recordFinalizeRateLimit,
} from '../api/middleware/rateLimit';
import {
  createMockVerificationReport,
  persistProofVerificationBundle,
} from '../api/adapters/proofBundleLocalArtifacts';
import { createApiProofBundleService } from '../api/adapters/proofBundleService';
import { publishVerificationBundleArtifacts } from '../api/adapters/verificationBundleS3Upload';
import { describeFinalizationExecution, stopFinalizationExecution } from '../api/adapters/finalizationStepFunctions';

export type { StepFunctionsExecutionDetails } from '../api/adapters/finalizationStepFunctions';

type BoundFinalizeRateLimit = (
  clientIp?: Parameters<typeof enforceFinalizeRateLimit>[1],
  options?: Parameters<typeof enforceFinalizeRateLimit>[2],
) => ReturnType<typeof enforceFinalizeRateLimit>;

type BoundFinalizeCancelRateLimit = (
  clientIp?: Parameters<typeof enforceFinalizeCancelRateLimit>[1],
  limiter?: Parameters<typeof enforceFinalizeCancelRateLimit>[2],
) => ReturnType<typeof enforceFinalizeCancelRateLimit>;

type BoundPersistAsyncProverInput = (
  options: Omit<Parameters<typeof persistAsyncProverInputToS3>[0], 'profile'>,
) => ReturnType<typeof persistAsyncProverInputToS3>;

type BoundDescribeFinalizationExecution = (
  executionArn: Parameters<typeof describeFinalizationExecution>[1],
) => ReturnType<typeof describeFinalizationExecution>;

type BoundStopFinalizationExecution = (
  executionArn: Parameters<typeof stopFinalizationExecution>[1],
  reason: Parameters<typeof stopFinalizationExecution>[2],
) => ReturnType<typeof stopFinalizationExecution>;

export interface FinalizationDependencies {
  finalizeSession: typeof finalizeSessionUsecase;
  resolveExpectedImageId: () => Promise<string>;
  getExecutor: () => ReturnType<typeof getDefaultExecutor>;
  finalizationQueue: FinalizationQueue;
  persistAsyncProverInput: BoundPersistAsyncProverInput;
  createProofBundleService: (store: ApiContextStore) => ReturnType<typeof createApiProofBundleService>;
  enforceFinalizeRateLimit: BoundFinalizeRateLimit;
  enforceFinalizeCancelRateLimit: BoundFinalizeCancelRateLimit;
  recordFinalizeRateLimit: typeof recordFinalizeRateLimit;
  describeFinalizationExecution: BoundDescribeFinalizationExecution;
  stopFinalizationExecution: BoundStopFinalizationExecution;
}

export type FinalizationDependencyOverrides = Partial<FinalizationDependencies>;

function createProofBundleService(
  store: ApiContextStore,
  profile: ResolvedRuntimeProfile,
): ReturnType<typeof createApiProofBundleService> {
  return createApiProofBundleService(
    {
      ...omitUndefinedProperties({ verifierWorkDir: process.env['VERIFIER_WORK_DIR'] }),
    },
    {
      persistBundle: persistProofVerificationBundle,
      invokeVerifier: invokeVerifierService,
      publishBundleArtifacts: (input) => publishVerificationBundleArtifacts({ profile, ...input }),
      createMockVerificationReport,
      recordBundlePublication: ({ sessionId, finalizationId, ...metadata }) =>
        store.recordAwsProofBundlePublication(sessionId, finalizationId, metadata),
    },
  );
}

async function resolveCurrentExpectedImageId(profile: ResolvedRuntimeProfile): Promise<string> {
  return resolveExpectedImageId(CURRENT_METHOD_VERSION, {
    ...omitUndefinedProperties({
      explicitImageId:
        profile.external.kind === 'aws' ? profile.external.expectedImageId : process.env['EXPECTED_IMAGE_ID'],
    }),
    ...omitUndefinedProperties({
      variant: process.env['EXPECTED_IMAGE_ID_VARIANT'],
    }),
    loadImageIdMapping: loadPublicImageIdMapping,
  });
}

export function createFinalizationDependencies(
  profile: ResolvedRuntimeProfile,
  overrides: FinalizationDependencyOverrides = {},
): FinalizationDependencies {
  const defaultFinalizationDependencies: FinalizationDependencies = {
    finalizeSession: finalizeSessionUsecase,
    resolveExpectedImageId: () => resolveCurrentExpectedImageId(profile),
    getExecutor: () => getDefaultExecutor(profile.proof),
    finalizationQueue: createFinalizationQueue((message) => publishProverWorkMessage(profile, message)),
    persistAsyncProverInput: (options) => persistAsyncProverInputToS3({ profile, ...options }),
    createProofBundleService: (store) => createProofBundleService(store, profile),
    enforceFinalizeRateLimit: (clientIp, options) => enforceFinalizeRateLimit(profile, clientIp, options),
    enforceFinalizeCancelRateLimit: (clientIp, limiter) => enforceFinalizeCancelRateLimit(profile, clientIp, limiter),
    recordFinalizeRateLimit,
    describeFinalizationExecution: (executionArn) => describeFinalizationExecution(profile, executionArn),
    stopFinalizationExecution: (executionArn, reason) => stopFinalizationExecution(profile, executionArn, reason),
  };
  return {
    ...defaultFinalizationDependencies,
    ...overrides,
  };
}
