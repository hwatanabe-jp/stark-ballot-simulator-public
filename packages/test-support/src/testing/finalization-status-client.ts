import {
  CurrentFinalizationResponseSchema,
  type FinalizationResource,
} from '@stark-ballot/api-contract/schemas/finalizations';
import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export class CurrentFinalizationError extends Error {
  public readonly status: number;
  public readonly responseBody?: unknown;

  constructor(message: string, status: number, responseBody?: unknown) {
    super(message);
    this.name = 'CurrentFinalizationError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

function parseCurrentFinalizationResponse(input: unknown): FinalizationResource | null {
  const parsed = CurrentFinalizationResponseSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new Error(`Invalid current finalization payload: ${firstIssue?.message ?? 'schema validation failed'}`);
  }
  return parsed.data.data;
}

interface FetchCurrentFinalizationOptions {
  baseUrl: string;
  signal?: AbortSignal;
  authHeaders?: Record<string, string>;
}

export async function fetchCurrentFinalization(
  sessionId: string,
  options: FetchCurrentFinalizationOptions,
): Promise<FinalizationResource | null> {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const path = buildApiRouteUrl(API_ROUTES.currentFinalization, {
    params: { sessionId },
  });
  const requestUrl = new URL(path, options.baseUrl).toString();
  const response = await fetch(requestUrl, {
    method: API_ROUTES.currentFinalization.method,
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
        throw new Error('Failed to parse current finalization response JSON');
      }
    }
  }

  if (!response.ok) {
    throw new CurrentFinalizationError(
      `Current finalization request failed with ${response.status}`,
      response.status,
      parsedBody,
    );
  }

  return parseCurrentFinalizationResponse(parsedBody);
}
