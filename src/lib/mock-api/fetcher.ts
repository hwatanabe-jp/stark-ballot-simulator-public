import { getMockState, resetMockState, updateMockState } from './state';
import {
  buildSessionResponse,
  buildVoteResponse,
  buildProgressResponse,
  buildFinalizeAcceptedResponse,
  buildFinalizationStatusResponse,
  buildVerifyResponse,
  buildBotDataResponse,
  buildVerificationRunResponse,
  buildFinalizationResult,
  buildFinalizeCancelResponse,
  buildBulletinResponse,
  buildBulletinProofResponse,
  buildConsistencyProofResponse,
} from './fixtures';
import type { ScenarioId } from './types';
import type { VoteChoice } from '@/lib/session/types';
import {
  BotDataResponseSchema,
  FinalizeAcceptedResponseSchema,
  FinalizeSyncResponseSchema,
  FinalizeRequestSchema,
  ProgressResponseSchema,
  SessionResponseSchema,
  SessionStatusResponseSchema,
  VerificationRunResponseSchema,
  VerifyResponseSchema,
  VoteResponseSchema,
  FinalizeCancelResponseSchema,
  BulletinResponseSchema,
  BulletinProofResponseSchema,
  ConsistencyProofResponseSchema,
} from '@/lib/validation/apiSchemas';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';

export const MOCK_API_STORAGE_KEY = 'stark-ballot-mock-api';
const MOCK_API_ENV_ENABLED = process.env.NEXT_PUBLIC_USE_MOCK_API === 'true';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MOCK_FINALIZATION_DURATION_MS = 20000;

const parseBody = (init?: RequestInit): Record<string, unknown> => {
  if (!init?.body) {
    return {};
  }
  if (typeof init.body === 'string') {
    try {
      return JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
};

const toResponse = (payload: unknown, status: number = 200): Response => {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
};

const errorResponse = (status: number, error: string, message: string): Response =>
  toResponse({ error, message }, status);

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
 * @deprecated Use apiFetch from '@/lib/api/apiFetch' instead.
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
    const state = resetMockState();
    const payload = buildSessionResponse(state);
    validateMockPayload(SessionResponseSchema, payload, '/api/session');
    return toResponse(payload);
  }

  if (url.pathname === '/api/vote' && method === 'POST') {
    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const body = parseBody(init);
    const state = updateMockState((current) => {
      if (typeof body.vote === 'string') {
        current.voteChoice = body.vote as VoteChoice;
      }
      if (typeof body.rand === 'string') {
        current.random = body.rand;
      }
      if (typeof body.commitment === 'string') {
        current.commitment = body.commitment;
      }
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
    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const body = parseBody(init);
    const parsed = FinalizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return toResponse({ error: 'INVALID_SCENARIO', message: 'scenarioId must be one of S0..S5' }, 400);
    }
    const scenarioId: ScenarioId = parsed.data.scenarioId;
    const state = updateMockState((current) => {
      current.scenarioId = scenarioId;
      current.finalizationFailedAt = undefined;
      current.finalizationError = undefined;
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
    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const body = parseBody(init);
    const executionId = typeof body.executionId === 'string' ? body.executionId : null;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    if (!executionId) {
      return toResponse({ error: 'INVALID_EXECUTION_ID', message: 'executionId is required' }, 400);
    }

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

    const payload = buildFinalizeCancelResponse(updated, { executionId, reason, now });
    validateMockPayload(FinalizeCancelResponseSchema, payload, '/api/finalize/cancel');
    return toResponse(payload);
  }

  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/status') && method === 'GET') {
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
    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
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

  if (url.pathname.startsWith('/api/botdata/') && method === 'GET') {
    const authResult = authorizeSensitiveHeaderRoute(input, init);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = getMockState();
    const idText = url.pathname.split('/').pop();
    const botId = idText ? Number(idText) : NaN;
    if (!Number.isFinite(botId)) {
      return toResponse({ error: 'BOT_DATA_NOT_FOUND', message: 'Invalid bot id' }, 404);
    }
    const payload = buildBotDataResponse(state, botId);
    if (!payload) {
      return toResponse({ error: 'BOT_DATA_NOT_FOUND', message: 'Bot data not found' }, 404);
    }
    validateMockPayload(BotDataResponseSchema, payload, '/api/botdata/:id');
    return toResponse(payload);
  }

  if (url.pathname === '/api/bulletin/consistency-proof' && method === 'GET') {
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
      oldSize <= 0 ||
      newSize <= 0
    ) {
      return toResponse({ error: 'INVALID_SIZE', message: 'oldSize and newSize must be positive integers' }, 400);
    }
    if (oldSize > newSize) {
      return toResponse({ error: 'INVALID_SIZE', message: 'oldSize cannot be greater than newSize' }, 400);
    }

    const state = getMockState();
    const treeSize = buildBulletinResponse(state, { now }).treeSize as number;
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
    const payload = buildBulletinResponse(state, { offset: offset ?? undefined, limit: limit ?? undefined, now });
    validateMockPayload(BulletinResponseSchema, payload, '/api/bulletin');
    return toResponse(payload);
  }

  if (url.pathname === '/api/sessions/mock/finalize' && method === 'POST') {
    const state = getMockState();
    const payload = buildFinalizationResult(state);
    validateMockPayload(FinalizeSyncResponseSchema, { data: payload }, '/api/sessions/mock/finalize');
    return toResponse({ data: payload });
  }

  return toResponse({ error: 'MOCK_NOT_FOUND', message: 'Mock endpoint not implemented' }, 404);
};
