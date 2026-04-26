import { getApiBaseUrl } from '@/lib/api/apiBaseUrl';
import { apiFetch } from '@/lib/api/apiFetch';
import {
  SessionStatusResponseSchema,
  type SessionStatusResponse as SessionStatusPayload,
} from '@/lib/validation/apiSchemas';
import { getStringProperty } from '@/lib/utils/guards';

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
    const issueMessage = firstIssue.message;
    throw new Error(`Invalid finalization status payload: ${issueMessage}`);
  }

  const data = parsed.data;

  return {
    sessionId: data.sessionId,
    finalizationState: data.finalizationState,
    artifactState: data.artifactState,
    queue: data.queue ?? null,
    finalizationResult: data.finalizationResult,
    stepFunctions: data.stepFunctions ?? null,
  };
}

interface FetchStatusOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  authHeaders?: Record<string, string>;
}

export async function fetchFinalizationStatus(
  sessionId: string,
  options: FetchStatusOptions = {},
): Promise<FinalizationStatusResponse> {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const { baseUrl, signal, authHeaders } = options;
  const requestUrl = resolveStatusUrl(sessionId, baseUrl);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(authHeaders ?? {}),
  };

  const response = await apiFetch(requestUrl, {
    method: 'GET',
    headers,
    signal,
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

function resolveStatusUrl(sessionId: string, baseUrl?: string): string {
  const relativePath = `/api/sessions/${sessionId}/status`;

  const resolvedBaseUrl = baseUrl ?? getApiBaseUrl();
  if (resolvedBaseUrl) {
    return new URL(relativePath, resolvedBaseUrl).toString();
  }

  if (typeof window !== 'undefined' && typeof window.location.origin === 'string') {
    return relativePath;
  }

  throw new Error('baseUrl is required when running outside the browser environment');
}
