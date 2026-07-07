import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { AwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';

export function projectFinalizationStateForPublicResponse(
  state: AwsFinalizationRuntimeState | FinalizationState | null,
): FinalizationState | null {
  if (!state) {
    return null;
  }

  const publicState = { ...state };
  delete (publicState as Partial<AwsFinalizationRuntimeState>).bundleMetadata;
  delete (publicState as Partial<AwsFinalizationRuntimeState>).stepFunctionsArn;
  if (publicState.status === 'failed') {
    publicState.error = {
      code: publicState.error.code,
      message: publicState.error.message,
    };
  }
  return publicState;
}
