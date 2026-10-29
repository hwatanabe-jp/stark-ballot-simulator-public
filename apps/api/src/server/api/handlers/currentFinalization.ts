import { deriveFinalizationProgress } from '@stark-ballot/application/finalize/finalization-progress';
import { currentFinalizationRoute } from '@stark-ballot/api-contract/routes';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import type { ApiHandlerArguments, RouteBoundResponse, SessionAdmittedContext } from '../context';
import { respondWithRoute } from '../utils/responseSchema';
import { buildFinalizationQueueInfo } from '../utils/finalizationQueueInfo';
import { projectFinalizationResourceForPublicResponse } from '../utils/finalizationStateProjection';
import { projectFinalizationResultForPublicResponse } from '../utils/finalizationResultProjection';

/**
 * Return the current finalization resource for a session.
 */
export async function getCurrentFinalizationHandler({
  context,
}: ApiHandlerArguments<typeof currentFinalizationRoute, SessionAdmittedContext>): Promise<
  RouteBoundResponse<typeof currentFinalizationRoute>
> {
  const { sessionId, session, store, runtimeProfile } = context;
  const asyncEnabled = runtimeProfile.finalization.mode === 'async';
  const targetAsyncExternal = asyncEnabled && runtimeProfile.external.kind === 'aws' ? runtimeProfile.external : null;

  if (!session.finalization) {
    return respondWithRoute(
      currentFinalizationRoute,
      { status: 200, content: 'json', body: { data: null } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const finalizationState = session.finalization.state;

  const queueUrl = targetAsyncExternal?.asyncRuntime.proverWorkQueueUrl;
  const shouldIncludeQueue =
    asyncEnabled &&
    Boolean(queueUrl) &&
    (finalizationState.status === 'pending' || finalizationState.status === 'running');
  const queue =
    shouldIncludeQueue && (finalizationState.status === 'pending' || finalizationState.status === 'running')
      ? await buildFinalizationQueueInfo({
          ...omitUndefinedProperties({ queueUrl }),
          state: finalizationState,
        })
      : null;
  const progress = deriveFinalizationProgress({
    state: finalizationState,
    ...omitUndefinedProperties({ estimatedDurationMs: queue?.estimatedDurationMs }),
  });

  let result;
  if (finalizationState.status === 'succeeded') {
    if (!session.finalization.finalizationResult) {
      throw new Error('Succeeded finalization is missing canonical result authority');
    }
    const [verificationRecord, deliveryMetadata, persistedBitmapData] = await Promise.all([
      store.getVerificationResultRecord(sessionId, finalizationState.finalizationId),
      store.getAwsVerificationDeliveryMetadata(sessionId, finalizationState.finalizationId),
      store.getBitmapData(sessionId, finalizationState.finalizationId),
    ]);
    const bitmapData = admitPersistedFinalizationBitmapData(session.finalization, persistedBitmapData);
    result = projectFinalizationResultForPublicResponse(session.finalization.finalizationResult, undefined, {
      ...omitUndefinedProperties({ verificationResult: verificationRecord?.verificationResult }),
      ...omitUndefinedProperties({ deliveryMetadata }),
      ...omitUndefinedProperties({ bitmapData: bitmapData ?? undefined }),
    });
  }

  const resource = projectFinalizationResourceForPublicResponse({
    state: finalizationState,
    runtimeDiagnostics: {
      asyncMode: asyncEnabled ? 'enabled' : 'disabled',
      ...omitUndefinedProperties({ queue, progress: progress ?? undefined }),
    },
    ...omitUndefinedProperties({ result }),
  });

  return respondWithRoute(
    currentFinalizationRoute,
    { status: 200, content: 'json', body: { data: resource } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
