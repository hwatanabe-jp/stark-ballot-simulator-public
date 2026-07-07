import {
  SessionStatusResponseSchema,
  type SessionStatusResponse as SessionStatusPayload,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function getStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

export type QueueInfo = NonNullable<NonNullable<SessionStatusPayload['queue']>>;
export type FinalizationStatusState = SessionStatusPayload['finalizationState'];
export type FinalizationStatusFinalizationResult = SessionStatusPayload['finalizationResult'];
type StepFunctionsDetails = NonNullable<SessionStatusPayload['stepFunctions']>;

export type FinalizationStatusResponse = {
  sessionId: string;
  finalizationState: FinalizationStatusState;
  artifactState?: SessionStatusPayload['artifactState'];
  queue: QueueInfo | null;
  finalizationResult: FinalizationStatusFinalizationResult;
  stepFunctions: StepFunctionsDetails | null;
};

export class FinalizationStatusError extends Error {
  public readonly status: number;
  public readonly responseBody?: unknown;

  constructor(message: string, status: number, responseBody?: unknown) {
    super(message);
    this.name = 'FinalizationStatusError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export function resolveFinalizationStatusErrorCode(error: unknown): string | null {
  if (!(error instanceof FinalizationStatusError)) {
    return null;
  }

  return getStringProperty(error.responseBody, 'error') ?? null;
}

export function parseFinalizationStatusResponse(input: unknown): FinalizationStatusResponse {
  const parsed = SessionStatusResponseSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new Error(`Invalid finalization status payload: ${firstIssue?.message ?? 'schema validation failed'}`);
  }

  const data = parsed.data;
  return {
    sessionId: data.sessionId,
    finalizationState: data.finalizationState,
    ...omitUndefinedProperties({ artifactState: data.artifactState }),
    queue: data.queue ?? null,
    finalizationResult: data.finalizationResult,
    stepFunctions: data.stepFunctions ?? null,
  };
}

interface FetchStatusOptions {
  baseUrl: string;
  signal?: AbortSignal;
  authHeaders?: Record<string, string>;
}

export async function fetchFinalizationStatus(
  sessionId: string,
  options: FetchStatusOptions,
): Promise<FinalizationStatusResponse> {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const requestUrl = new URL(`/api/sessions/${sessionId}/status`, options.baseUrl).toString();
  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.authHeaders ?? {}),
    },
    ...omitUndefinedProperties({ signal: options.signal }),
  });

  let parsedBody: unknown = null;
  const rawBody = await response.text();
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      if (response.ok) {
        throw new Error('Failed to parse finalization status response JSON');
      }
    }
  }

  if (!response.ok) {
    throw new FinalizationStatusError(`Status request failed with ${response.status}`, response.status, parsedBody);
  }

  return parseFinalizationStatusResponse(parsedBody);
}
