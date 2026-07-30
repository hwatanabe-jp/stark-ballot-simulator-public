import { getMockState, resetMockState, updateMockState } from './state';
import {
  buildSessionResponse,
  buildVoteResponse,
  buildProgressResponse,
  buildFinalizeAcceptedResponse,
  buildFinalizationStatusResponse,
  buildVerifyResponse,
  buildVerificationRunResponse,
  buildFinalizationResult,
  buildFinalizeCancelResponse,
  buildBulletinResponse,
  buildBulletinProofResponse,
  buildConsistencyProofResponse,
  MOCK_VERIFICATION_EXECUTION_ID,
} from './fixtures';
import type { ScenarioId } from './types';
import {
  FinalizeAcceptedResponseSchema,
  FinalizeSyncResponseSchema,
  FinalizeRequestSchema,
  FinalizeCancelRequestSchema,
  ProgressResponseSchema,
  SessionCreateRequestSchema,
  SessionResponseSchema,
  SessionStatusResponseSchema,
  VerificationRunRequestSchema,
  VerificationRunResponseSchema,
  VerificationObservationRequestSchema,
  VerificationObservationResponseSchema,
  VERIFICATION_OBSERVATION_CAST_CHECK_IDS,
  VerifyResponseSchema,
  VoteRequestSchema,
  VoteResponseSchema,
  FinalizeCancelResponseSchema,
  BulletinResponseSchema,
  BulletinProofResponseSchema,
  ConsistencyProofResponseSchema,
  VerifyQuerySchema,
  BulletinQuerySchema,
  ConsistencyProofQuerySchema,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import { ErrorCode, getErrorMessage, type ErrorDetails } from '@stark-ballot/web/api/apiErrors';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/web/session/capability';
import { readBrowserPublicFlag } from '@stark-ballot/runtime-config/env/browserPublic';
import { MOCK_API_STORAGE_KEY } from '@stark-ballot/web/mock-api/config';
import type { Schema } from '@stark-ballot/validation/schema';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const MOCK_API_ENV_ENABLED = readBrowserPublicFlag('VITE_USE_MOCK_API');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MOCK_FINALIZATION_DURATION_MS = 20000;

const toResponse = (payload: unknown, status: number = 200): Response => {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
};

const errorResponse = (status: number, error: string, message: string): Response =>
  toResponse({ error, message, statusCode: status }, status);

type MockBodyParseResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      response: Response;
    };

const invalidRequestResponse = (details?: ErrorDetails): Response => {
  return toResponse(
    {
      error: ErrorCode.INVALID_REQUEST,
      message: details?.message ?? getErrorMessage(ErrorCode.INVALID_REQUEST),
      statusCode: 400,
      ...(details?.details ? { details: details.details } : {}),
      ...(details?.issues ? { issues: details.issues } : {}),
    },
    400,
  );
};

const parseJsonBody = <T>(
  init: RequestInit | undefined,
  schema: Schema<T>,
  options: { allowEmpty?: boolean } = {},
): MockBodyParseResult<T> => {
  let raw: unknown;
  if (!init?.body) {
    if (!options.allowEmpty) {
      return {
        success: false,
        response: invalidRequestResponse({ message: 'Invalid JSON payload' }),
      };
    }
    raw = {};
  } else if (typeof init.body === 'string') {
    if (init.body.trim().length === 0 && options.allowEmpty) {
      raw = {};
    } else {
      try {
        raw = JSON.parse(init.body) as unknown;
      } catch (error) {
        return {
          success: false,
          response: invalidRequestResponse({
            message: 'Invalid JSON payload',
            details: error instanceof Error ? error.message : 'Unknown JSON parse error',
          }),
        };
      }
    }
  } else {
    return {
      success: false,
      response: invalidRequestResponse({ message: 'Invalid JSON payload' }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      response: invalidRequestResponse({ issues: parsed.error.flatten() }),
    };
  }

  return { success: true, data: parsed.data };
};

const collectQueryParams = (url: URL): Record<string, unknown> => {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(params, key)) {
      params[key] = value;
      continue;
    }

    const existing = params[key];
    if (Array.isArray(existing)) {
      params[key] = [...existing, value];
    } else if (existing !== undefined) {
      params[key] = [existing, value];
    } else {
      params[key] = value;
    }
  }
  return params;
};

const validateQueryParams = (url: URL, schema: Schema<unknown>): Response | null => {
  const parsed = schema.safeParse(collectQueryParams(url));
  if (parsed.success) {
    return null;
  }

  return invalidRequestResponse({ issues: parsed.error.flatten() });
};

const validateNoQueryParams = (url: URL): Response | null => {
  const queryParams = collectQueryParams(url);
  const keys = Object.keys(queryParams);
  if (keys.length === 0) {
    return null;
  }

  return invalidRequestResponse({
    issues: {
      formErrors: ['Unexpected query parameter'],
      fieldErrors: Object.fromEntries(keys.map((key) => [key, ['Unexpected query parameter']])),
    },
  });
};

const validateMockPayload = (
  schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } },
  payload: unknown,
  label: string,
): void => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`[mock-api] Invalid payload for ${label}`);
  }
};

const resolveUrl = (input: RequestInfo | URL): URL => {
  if (typeof input === 'string') {
    return new URL(input, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
};

const getHeaderValue = (input: RequestInfo | URL, init: RequestInit | undefined, headerName: string): string | null => {
  const initHeaders = init?.headers ? new Headers(init.headers) : null;
  const fromInit = initHeaders?.get(headerName);
  if (fromInit) {
    return fromInit;
  }

  if (typeof input === 'string' || input instanceof URL) {
    return null;
  }

  return input.headers.get(headerName);
};

const authorizeSensitiveRoute = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  expectedSessionId: string,
): Response | null => {
  const capabilityToken = getHeaderValue(input, init, SESSION_CAPABILITY_HEADER);
  if (!capabilityToken) {
    return errorResponse(401, 'SESSION_CAPABILITY_REQUIRED', 'Session capability token is required');
  }

  const state = getMockState();
  if (expectedSessionId !== state.sessionId) {
    return errorResponse(404, 'SESSION_NOT_FOUND', 'Session not found');
  }

  if (capabilityToken !== state.capabilityToken) {
    return errorResponse(401, 'SESSION_CAPABILITY_INVALID', 'Invalid session capability token');
  }

  return null;
};

const authorizeSensitiveHeaderRoute = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { sessionId: string } | Response => {
  const sessionId = getHeaderValue(input, init, SESSION_ID_HEADER);
  if (!sessionId) {
    return errorResponse(400, 'SESSION_ID_REQUIRED', 'Session ID is required');
  }

  const authorizationError = authorizeSensitiveRoute(input, init, sessionId);
  if (authorizationError) {
    return authorizationError;
  }

  return { sessionId };
};

export const isMockApiEnabled = (): boolean => {
  if (!MOCK_API_ENV_ENABLED) {
    return false;
  }
  if (typeof window === 'undefined') {
    return true;
  }
  const stored = window.localStorage.getItem(MOCK_API_STORAGE_KEY);
  if (stored === 'true') {
    return true;
  }
  if (stored === 'false') {
    return false;
  }
  return true;
};

/**
 * @deprecated Use apiFetch from '@stark-ballot/web/api/apiFetch' instead.
 */
export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isMockApiEnabled()) {
    return fetch(input, init);
  }
  return mockApiFetch(input, init);
};

export const mockApiFetch = (input: RequestInfo | URL, init?: RequestInit): Response => {
  const url = resolveUrl(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const now = Date.now();

  if (url.pathname === '/api/session' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const parsed = parseJsonBody(init, SessionCreateRequestSchema, { allowEmpty: true });
    if (!parsed.success) {
      return parsed.response;
    }

    const state = resetMockState();
    const payload = buildSessionResponse(state);
    validateMockPayload(SessionResponseSchema, payload, '/api/session');
    return toResponse(payload);
  }

  if (url.pathname === '/api/vote' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VoteRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }
    const body = parsed.data;
    const state = updateMockState((current) => {
      current.voteChoice = body.vote;
      current.random = body.rand;
      current.commitment = body.commitment;
      if (!current.voteId) {
        current.voteId = '00000000-0000-4000-8000-000000000001';
      }
      if (typeof current.bulletinIndex !== 'number') {
        current.bulletinIndex = 0;
      }
      current.voteTimestamp = now;
    });
    const payload = buildVoteResponse(state);
    validateMockPayload(VoteResponseSchema, payload, '/api/vote');
    return toResponse(payload);
  }

  if (url.pathname === '/api/progress' && method === 'GET') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = updateMockState((current) => {
      if (!current.botVotingStartedAt) {
        current.botVotingStartedAt = now;
      }
    });
    const payload = buildProgressResponse(state, now);
    validateMockPayload(ProgressResponseSchema, payload, '/api/progress');
    return toResponse(payload);
  }

  if (url.pathname === '/api/finalize' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, FinalizeRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }
    const scenarioId: ScenarioId = parsed.data.scenarioId;
    const state = updateMockState((current) => {
      current.scenarioId = scenarioId;
      delete current.finalizationFailedAt;
      delete current.finalizationError;
      if (!current.finalizationQueuedAt) {
        current.finalizationQueuedAt = now;
        current.finalizationStartedAt = now + 2000;
        current.finalizationCompletedAt = current.finalizationStartedAt + MOCK_FINALIZATION_DURATION_MS;
      }
    });
    const payload = buildFinalizeAcceptedResponse(
      state,
      state.finalizationQueuedAt ?? now,
      MOCK_FINALIZATION_DURATION_MS,
    );
    validateMockPayload(FinalizeAcceptedResponseSchema, payload, '/api/finalize');
    return toResponse(payload, 202);
  }

  if (url.pathname === '/api/finalize/cancel' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, FinalizeCancelRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }
    const { executionId, reason } = parsed.data;

    const state = getMockState();
    const queuedAt = state.finalizationQueuedAt ?? now;
    const startedAt = state.finalizationStartedAt ?? queuedAt + 2000;
    const completedAt = state.finalizationCompletedAt ?? startedAt + MOCK_FINALIZATION_DURATION_MS;
    const status =
      typeof state.finalizationFailedAt === 'number'
        ? 'failed'
        : now < startedAt
          ? 'pending'
          : now < completedAt
            ? 'running'
            : 'succeeded';

    if (status !== 'pending' && status !== 'running') {
      return toResponse(
        { error: 'FINALIZATION_NOT_CANCELLABLE', message: 'Finalization cannot be cancelled in its current state' },
        409,
      );
    }

    const updated = updateMockState((current) => {
      current.finalizationFailedAt = now;
      current.finalizationError = {
        code: 'USER_CANCELLED',
        message: reason?.trim().length ? reason.trim() : 'Cancelled by user request',
      };
    });

    const payload = buildFinalizeCancelResponse(updated, omitUndefinedProperties({ executionId, reason, now }));
    validateMockPayload(FinalizeCancelResponseSchema, payload, '/api/finalize/cancel');
    return toResponse(payload);
  }

  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/status') && method === 'GET') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const statusMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/status$/);
    const sessionIdFromPath = statusMatch?.[1];
    if (!sessionIdFromPath) {
      return errorResponse(400, 'SESSION_ID_REQUIRED', 'Session ID is required');
    }

    const authorizationError = authorizeSensitiveRoute(input, init, sessionIdFromPath);
    if (authorizationError) {
      return authorizationError;
    }

    const state = getMockState();
    const payload = buildFinalizationStatusResponse(state, now);
    validateMockPayload(SessionStatusResponseSchema, payload, '/api/sessions/:id/status');
    return toResponse(payload);
  }

  if (url.pathname === '/api/verify' && method === 'GET') {
    const queryError = validateQueryParams(url, VerifyQuerySchema);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = getMockState();
    const includeJournal = url.searchParams.get('includeJournal') === '1';
    const payload = buildVerifyResponse(state, now, { includeJournal });
    validateMockPayload(VerifyResponseSchema, payload, '/api/verify');
    return toResponse(payload);
  }

  if (url.pathname === '/api/verification/run' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VerificationRunRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }

    updateMockState((current) => {
      current.verificationStatus = 'running';
      current.verificationReport = {
        status: 'running',
        duration_ms: 3800,
        errors: [],
      };
    });
    const payload = buildVerificationRunResponse();
    validateMockPayload(VerificationRunResponseSchema, payload, '/api/verification/run');
    return toResponse(payload);
  }

  if (url.pathname === '/api/verification/observation' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VerificationObservationRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }

    const state = getMockState();
    const verificationStatus = state.verificationStatus ?? 'success';
    const finalizationIsComplete =
      typeof state.finalizationCompletedAt === 'number' &&
      now >= state.finalizationCompletedAt &&
      typeof state.finalizationFailedAt !== 'number';
    if (
      !finalizationIsComplete ||
      (verificationStatus !== 'success' && verificationStatus !== 'failed' && verificationStatus !== 'dev_mode') ||
      parsed.data.verificationExecutionId !== MOCK_VERIFICATION_EXECUTION_ID
    ) {
      return errorResponse(
        409,
        'VERIFICATION_OBSERVATION_CONFLICT',
        'Verification execution does not match the current session',
      );
    }
    const fingerprint = JSON.stringify([
      parsed.data.verificationExecutionId,
      ...VERIFICATION_OBSERVATION_CAST_CHECK_IDS.map((id) => parsed.data.castChecks[id]),
    ]);
    const existing = state.verificationObservation;
    if (
      existing &&
      (existing.executionId !== parsed.data.verificationExecutionId || existing.fingerprint !== fingerprint)
    ) {
      return errorResponse(
        409,
        'VERIFICATION_OBSERVATION_CONFLICT',
        'A different verification observation is already recorded',
      );
    }

    const status = existing ? 'idempotent' : 'recorded';
    if (!existing) {
      updateMockState((current) => {
        current.verificationObservation = {
          executionId: parsed.data.verificationExecutionId,
          fingerprint,
        };
      });
    }
    const payload = { data: { status } };
    validateMockPayload(VerificationObservationResponseSchema, payload, '/api/verification/observation');
    return toResponse(payload);
  }

  if (url.pathname.startsWith('/api/botdata/') && method === 'GET') {
    return errorResponse(410, 'ROUTE_RETIRED', 'This API route is not available in the target public runtime.');
  }

  if (url.pathname === '/api/bulletin/consistency-proof' && method === 'GET') {
    const queryError = validateQueryParams(url, ConsistencyProofQuerySchema);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const oldSizeParam = url.searchParams.get('oldSize');
    const newSizeParam = url.searchParams.get('newSize');
    const oldSize = oldSizeParam ? Number(oldSizeParam) : NaN;
    const newSize = newSizeParam ? Number(newSizeParam) : NaN;
    if (
      !Number.isFinite(oldSize) ||
      !Number.isFinite(newSize) ||
      !Number.isInteger(oldSize) ||
      !Number.isInteger(newSize) ||
      oldSize < 0 ||
      newSize < 0
    ) {
      return toResponse({ error: 'INVALID_SIZE', message: 'oldSize and newSize must be non-negative integers' }, 400);
    }
    if (oldSize > newSize) {
      return toResponse({ error: 'INVALID_SIZE', message: 'oldSize cannot be greater than newSize' }, 400);
    }

    const state = getMockState();
    const treeSize = buildBulletinResponse(state, { now })['treeSize'] as number;
    if (newSize > treeSize) {
      return toResponse(
        { error: 'INVALID_SIZE', message: `newSize (${newSize}) exceeds tree size (${treeSize})` },
        400,
      );
    }

    const payload = buildConsistencyProofResponse(state, { oldSize, newSize, now });
    validateMockPayload(ConsistencyProofResponseSchema, payload, '/api/bulletin/consistency-proof');
    return toResponse(payload);
  }

  if (url.pathname.startsWith('/api/bulletin/') && url.pathname.endsWith('/proof') && method === 'GET') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const trimmed = url.pathname.replace('/api/bulletin/', '').replace('/proof', '');
    const voteId = trimmed.replace(/^\/+|\/+$/g, '');
    const state = getMockState();
    const payload = buildBulletinProofResponse(state, voteId, { now });
    if (!payload) {
      return toResponse({ error: 'VOTE_NOT_FOUND', message: 'Vote proof not found' }, 404);
    }
    validateMockPayload(BulletinProofResponseSchema, payload, '/api/bulletin/:voteId/proof');
    return toResponse(payload);
  }

  if (url.pathname === '/api/bulletin' && method === 'GET') {
    const queryError = validateQueryParams(url, BulletinQuerySchema);
    if (queryError) {
      return queryError;
    }

    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const offsetParam = url.searchParams.get('offset');
    const limitParam = url.searchParams.get('limit');
    const offset = offsetParam !== null ? Number(offsetParam) : undefined;
    const limit = limitParam !== null ? Number(limitParam) : undefined;

    if (offsetParam !== null && (!Number.isFinite(offset) || !Number.isInteger(offset ?? 0) || (offset ?? 0) < 0)) {
      return toResponse({ error: 'INVALID_OFFSET', message: 'offset must be a non-negative integer' }, 400);
    }
    if (limitParam !== null && (!Number.isFinite(limit) || !Number.isInteger(limit ?? 0) || (limit ?? 0) <= 0)) {
      return toResponse({ error: 'INVALID_LIMIT', message: 'limit must be a positive integer' }, 400);
    }

    const state = getMockState();
    const payload = buildBulletinResponse(
      state,
      omitUndefinedProperties({ offset: offset ?? undefined, limit: limit ?? undefined, now }),
    );
    validateMockPayload(BulletinResponseSchema, payload, '/api/bulletin');
    return toResponse(payload);
  }

  if (url.pathname === '/api/sessions/mock/finalize' && method === 'POST') {
    const queryError = validateNoQueryParams(url);
    if (queryError) {
      return queryError;
    }

    const state = getMockState();
    const payload = buildFinalizationResult(state);
    validateMockPayload(FinalizeSyncResponseSchema, { data: payload }, '/api/sessions/mock/finalize');
    return toResponse({ data: payload });
  }

  return toResponse({ error: 'MOCK_NOT_FOUND', message: 'Mock endpoint not implemented' }, 404);
};

export const handleLocalApiRequest = mockApiFetch;
