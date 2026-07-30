import { handle } from 'hono/aws-lambda';
import { createHonoApp } from '@stark-ballot/api/server';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { logger } from '@stark-ballot/diagnostics/logger';
import { bootstrapLambdaRuntime } from '../runtimeBootstrap.js';

type InvocationAdmission =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'event_shape_invalid' | 'request_id_missing' };

function admitApiGatewayV2Invocation(value: unknown): InvocationAdmission {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  const event = value as Record<string, unknown>;
  if (event['version'] !== '2.0') {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  const requestContext = event['requestContext'];
  if (!requestContext || typeof requestContext !== 'object') {
    return { ok: false, reason: 'request_id_missing' };
  }
  const requestId = (requestContext as Record<string, unknown>)['requestId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, reason: 'request_id_missing' };
  }
  const http = (requestContext as Record<string, unknown>)['http'];
  if (
    typeof event['rawPath'] !== 'string' ||
    event['rawPath'].length === 0 ||
    typeof event['rawQueryString'] !== 'string' ||
    !http ||
    typeof http !== 'object'
  ) {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  const httpRecord = http as Record<string, unknown>;
  if (
    typeof httpRecord['method'] !== 'string' ||
    httpRecord['method'].length === 0 ||
    typeof httpRecord['path'] !== 'string' ||
    httpRecord['path'].length === 0
  ) {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  return { ok: true };
}

const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
const honoHandler = handle(app);

export const handler: typeof honoHandler = async (...args) => {
  await bootstrapLambdaRuntime({
    serviceName: 'public-api',
    resolveRuntimeReferences: async (invalidNameCollector) =>
      await ensureAwsRuntimeConfigReferencesLoaded('public_api', { invalidNameCollector }),
    validationSteps: [
      {
        validate: validateTargetObservabilityEnv,
      },
      {
        validate: validateEnv,
      },
    ],
  });

  const admission = admitApiGatewayV2Invocation(args[0]);
  if (!admission.ok) {
    logger.error('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_v2',
      reason: admission.reason,
    });
    throw new Error('Invalid API Gateway v2 invocation');
  }

  return await honoHandler(...args);
};
