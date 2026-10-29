import { handle } from '@hono/aws-lambda';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHonoApp } from '@stark-ballot/api/server';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import {
  type ResolvedRuntimeProfile,
  resolveRuntimeProfile,
  validateRuntimeProfileSelection,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { logger } from '@stark-ballot/diagnostics/logger';
import { bootstrapLambdaRuntime } from '../runtimeBootstrap.js';

type InvocationAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'event_shape_invalid' | 'request_id_missing' };

function isRestRequestLine(event: Record<string, unknown>): boolean {
  return (
    typeof event['httpMethod'] === 'string' &&
    /^[A-Z]+$/.test(event['httpMethod']) &&
    typeof event['path'] === 'string' &&
    event['path'].startsWith('/') &&
    typeof event['resource'] === 'string'
  );
}

function isRestRequestContext(context: Record<string, unknown>): boolean {
  return (
    typeof context['domainName'] === 'string' &&
    context['domainName'].length > 0 &&
    context['stage'] === 'live' &&
    Boolean(context['identity']) &&
    typeof context['identity'] === 'object'
  );
}

function isRestRequestBody(event: Record<string, unknown>): boolean {
  return typeof event['isBase64Encoded'] === 'boolean' && (event['body'] === null || typeof event['body'] === 'string');
}

function isRestValueMap(key: string, values: unknown): boolean {
  if (values === null || values === undefined) return true;
  if (typeof values !== 'object' || Array.isArray(values)) return false;
  return Object.values(values).every((value: unknown) =>
    key.startsWith('multiValue')
      ? Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
      : typeof value === 'string',
  );
}

function admitRestInvocation(value: unknown): InvocationAdmission {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  const event = value as Record<string, unknown>;
  if (event['version'] !== undefined || 'rawPath' in event) {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  const requestContext = event['requestContext'];
  if (!requestContext || typeof requestContext !== 'object') {
    return { ok: false, reason: 'request_id_missing' };
  }
  const context = requestContext as Record<string, unknown>;
  const requestId = context['extendedRequestId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, reason: 'request_id_missing' };
  }
  return admitRestTransport(event, context);
}

function admitRestTransport(event: Record<string, unknown>, context: Record<string, unknown>): InvocationAdmission {
  if (!isRestRequestLine(event) || !isRestRequestContext(context) || !isRestRequestBody(event)) {
    return { ok: false, reason: 'event_shape_invalid' };
  }
  for (const key of ['headers', 'queryStringParameters', 'multiValueHeaders', 'multiValueQueryStringParameters']) {
    if (!isRestValueMap(key, event[key])) return { ok: false, reason: 'event_shape_invalid' };
  }
  return { ok: true };
}

type HonoLambdaHandler = ReturnType<typeof handle>;
type StreamingHandler = (
  event: Parameters<HonoLambdaHandler>[0],
  stream: Writable,
  context: Parameters<HonoLambdaHandler>[1],
) => Promise<void>;

// Supplied by the managed Node.js Lambda runtime. Keep the Hono REST adapter's
// admission and multi-value headers; only the response transport changes.
declare const awslambda: {
  streamifyResponse(handler: StreamingHandler): StreamingHandler;
  HttpResponseStream: {
    from(
      stream: Writable,
      metadata: Omit<Awaited<ReturnType<HonoLambdaHandler>>, 'body' | 'isBase64Encoded'>,
    ): Writable;
  };
};
let runtimeProfile: ReturnType<typeof resolveRuntimeProfile> | undefined;
let honoHandler: HonoLambdaHandler | undefined;

function validatePublicApiRuntime(profile: ResolvedRuntimeProfile): void {
  if (profile.target.kind !== 'aws' || profile.external.kind !== 'aws') {
    throw new RuntimeConfigValidationError(
      ['RUNTIME_PROFILE'],
      undefined,
      'A target AWS runtime profile is required for public API Lambda execution',
    );
  }
}

const handleInvocation: HonoLambdaHandler = async (...args) => {
  const env = process.env;
  const resolvedRuntimeProfile = runtimeProfile ?? resolveRuntimeProfile(env);
  runtimeProfile = resolvedRuntimeProfile;
  await bootstrapLambdaRuntime({
    serviceName: 'public-api',
    runtimeProfile: resolvedRuntimeProfile,
    resolveRuntimeReferences: async (invalidNameCollector) =>
      await ensureAwsRuntimeConfigReferencesLoaded('public_api', {
        profile: resolvedRuntimeProfile,
        invalidNameCollector,
        env,
      }),
    validationSteps: [
      {
        validate: () => validateRuntimeProfileSelection(resolvedRuntimeProfile, env),
      },
      {
        validate: () => validatePublicApiRuntime(resolvedRuntimeProfile),
      },
      {
        validate: () => validateTargetObservabilityEnv(resolvedRuntimeProfile, env),
      },
      {
        validate: () => validateEnv(resolvedRuntimeProfile, env),
      },
    ],
    env,
  });

  const admission = admitRestInvocation(args[0]);
  if (!admission.ok) {
    logger.error('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_rest',
      reason: admission.reason,
    });
    throw new Error('Invalid API Gateway REST invocation');
  }

  honoHandler ??= handle(createHonoApp({ basePath: '/api', mode: 'lambda', runtimeProfile: resolvedRuntimeProfile }));
  return await honoHandler(...args);
};

export const handler = awslambda.streamifyResponse(async (event, stream, context) => {
  const { body, isBase64Encoded, ...metadata } = await handleInvocation(event, context);
  const response = awslambda.HttpResponseStream.from(stream, metadata);
  await pipeline([Buffer.from(body, isBase64Encoded ? 'base64' : 'utf8')], response);
});
