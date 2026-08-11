import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type {
  FinalizationResource,
  FinalizationResult,
  FinalizationRuntimeDiagnostics,
} from '@stark-ballot/api-contract/schemas/finalizations';
import type { AwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export function projectFinalizationResourceForPublicResponse(params: {
  state: AwsFinalizationRuntimeState | FinalizationState;
  runtimeDiagnostics: FinalizationRuntimeDiagnostics;
  result?: FinalizationResult;
}): FinalizationResource {
  const { state, runtimeDiagnostics, result } = params;
  const common = {
    finalizationId: state.finalizationId,
    queuedAtMs: state.queuedAtMs,
    runtimeDiagnostics,
  };

  switch (state.status) {
    case 'pending':
      return {
        ...common,
        status: 'pending',
      };
    case 'running':
      return {
        ...common,
        status: 'running',
        startedAtMs: state.startedAtMs,
      };
    case 'succeeded':
      if (!result) {
        throw new Error('Succeeded finalization requires a canonical public result');
      }
      return {
        ...common,
        status: 'succeeded',
        startedAtMs: state.startedAtMs,
        completedAtMs: state.completedAtMs,
        result,
      };
    case 'failed':
      return {
        ...common,
        status: 'failed',
        ...omitUndefinedProperties({ startedAtMs: state.startedAtMs }),
        failedAtMs: state.failedAtMs,
        error: {
          code: state.error.code,
          message: state.error.message,
        },
      };
    case 'timeout':
      return {
        ...common,
        status: 'timeout',
        ...omitUndefinedProperties({ startedAtMs: state.startedAtMs }),
        timeoutAtMs: state.timeoutAtMs,
      };
  }
}
