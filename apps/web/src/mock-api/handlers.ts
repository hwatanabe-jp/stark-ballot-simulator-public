import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import { getMockState, resetMockState, updateMockState } from './state';
import {
  buildSessionResponse,
  buildVoteResponse,
  buildProgressResponse,
  buildFinalizationResponse,
  buildCurrentFinalizationResponse,
  buildVerificationResourceResponse,
  buildVerificationRunResponse,
  buildFinalizationResult,
  buildFinalizationCancelResponse,
  buildBulletinResponse,
  buildBulletinProofResponse,
  buildConsistencyProofResponse,
  buildFinalizationResource,
  buildMockBitmapEvidence,
  MOCK_FINALIZATION_ID,
} from './fixtures';
import type { ScenarioId } from './types';
import {
  CurrentFinalizationResponseSchema,
  FinalizationCancelRequestSchema,
  FinalizationCreateRequestSchema,
  FinalizationResponseSchema,
} from '@stark-ballot/api-contract/schemas/finalizations';
import { ProgressResponseSchema } from '@stark-ballot/api-contract/schemas/progress';
import { SessionCreateRequestSchema, SessionResponseSchema } from '@stark-ballot/api-contract/schemas/sessions';
import {
  VERIFICATION_OBSERVATION_CAST_CHECK_IDS,
  VerificationObservationRequestSchema,
  VerificationObservationResponseSchema,
  VerificationResourceResponseSchema,
  VerificationRunRequestSchema,
  VerificationRunResponseSchema,
} from '@stark-ballot/api-contract/schemas/verification';
import { VoteRequestSchema, VoteResponseSchema } from '@stark-ballot/api-contract/schemas/votes';
import {
  BulletinProofResponseSchema,
  BulletinResponseSchema,
  ConsistencyProofResponseSchema,
  SthResponseSchema,
} from '@stark-ballot/api-contract/schemas/bulletin';
import { BitmapProofResponseSchema, InputCommitmentResponseSchema } from '@stark-ballot/api-contract/schemas/artifacts';
import { createApiErrorResult, ErrorCode, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import type { PublicErrorDetail } from '@stark-ballot/api-contract/schemas/errors';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/api-contract/schemas/primitives';
import type { Schema } from '@stark-ballot/validation/schema';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isRecord } from '@stark-ballot/validation/unknown-value-guards';
import type { MockRouteRequest } from './router';
import { generateBitmapMerkleProof } from '@stark-ballot/verification/merkle/bitmap-merkle-tree';

const MOCK_FINALIZATION_DURATION_MS = 20000;
const MOCK_BUNDLE_CONTENT = 'mock-verification-bundle';
const MOCK_BUNDLE_ETAG = '"mock-verification-bundle"';

const withRequestId = (payload: unknown, requestId: string): unknown => {
  if (!isRecord(payload) || !isRecord(payload['meta'])) {
    return payload;
  }
  return {
    ...payload,
    meta: {
      ...payload['meta'],
      requestId,
    },
  };
};

const toResponse = (payload: unknown, requestId: string, status: number = 200): Response => {
  return new Response(JSON.stringify(withRequestId(payload, requestId)), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
    },
  });
};

const successPayload = (data: Record<string, unknown>, requestId: string): Record<string, unknown> => ({
  data,
  meta: { requestId },
});

const errorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: PublicErrorDetail,
): Response =>
  toResponse(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      meta: { requestId },
    },
    requestId,
    status,
  );

const resolveMockReport = (state: ReturnType<typeof getMockState>, now: number): Record<string, unknown> => {
  const verification = buildVerificationResourceResponse(state, now);
  const data = verification['data'];
  const verifierResult = isRecord(data) ? data['verifierResult'] : undefined;
  const report = isRecord(verifierResult) ? verifierResult['report'] : undefined;
  return isRecord(report) ? report : { status: 'not_run' };
};

const buildMockBundleResponse = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestId: string,
): Response => {
  const rangeHeader = getHeaderValue(input, init, 'Range');
  if (!rangeHeader) {
    return new Response(MOCK_BUNDLE_CONTENT, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        ETag: MOCK_BUNDLE_ETAG,
        'X-Request-ID': requestId,
      },
    });
  }

  const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
  const start = match?.[1] ? Number(match[1]) : Number.NaN;
  const requestedEnd = match?.[2] ? Number(match[2]) : Number.NaN;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= MOCK_BUNDLE_CONTENT.length
  ) {
    return errorResponse(requestId, 416, 'INVALID_RANGE', 'Requested bundle range is invalid');
  }

  const end = Math.min(requestedEnd, MOCK_BUNDLE_CONTENT.length - 1);
  return new Response(MOCK_BUNDLE_CONTENT.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Range': `bytes ${start}-${end}/${MOCK_BUNDLE_CONTENT.length}`,
      'Accept-Ranges': 'bytes',
      ETag: MOCK_BUNDLE_ETAG,
      'X-Stark-Bundle-Range-Chunk-Size': '4',
      'X-Request-ID': requestId,
    },
  });
};

type MockBodyParseResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      response: Response;
    };

const invalidRequestResponse = (requestId: string, details?: ErrorDetails): Response => {
  const result = createApiErrorResult(ErrorCode.INVALID_REQUEST, requestId, details);
  return toResponse(result.payload, requestId, result.status);
};

const parseJsonBody = <T>(
  init: RequestInit | undefined,
  schema: Schema<T>,
  requestId: string,
  options: { allowEmpty?: boolean } = {},
): MockBodyParseResult<T> => {
  let raw: unknown;
  if (!init?.body) {
    if (!options.allowEmpty) {
      return {
        success: false,
        response: invalidRequestResponse(requestId, { message: 'Invalid JSON payload' }),
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
          response: invalidRequestResponse(requestId, {
            message: 'Invalid JSON payload',
            details: error instanceof Error ? error.message : 'Unknown JSON parse error',
          }),
        };
      }
    }
  } else {
    return {
      success: false,
      response: invalidRequestResponse(requestId, { message: 'Invalid JSON payload' }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      response: invalidRequestResponse(requestId, { issues: parsed.error.flatten() }),
    };
  }

  return { success: true, data: parsed.data };
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

const getHeaderValue = (input: RequestInfo | URL, init: RequestInit | undefined, headerName: string): string | null => {
  const initHeaders = init?.headers ? new Headers(init.headers) : null;
  const fromInit = initHeaders?.get(headerName) ?? null;
  if (fromInit !== null) {
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
  requestId: string,
): Response | null => {
  const capabilityToken = getHeaderValue(input, init, SESSION_CAPABILITY_HEADER);
  if (!capabilityToken) {
    return errorResponse(requestId, 401, 'SESSION_CAPABILITY_REQUIRED', 'Session capability token is required');
  }

  const state = getMockState();
  if (expectedSessionId !== state.sessionId) {
    return errorResponse(requestId, 404, 'SESSION_NOT_FOUND', 'Session not found');
  }

  if (capabilityToken !== state.capabilityToken) {
    return errorResponse(requestId, 401, 'SESSION_CAPABILITY_INVALID', 'Invalid session capability token');
  }

  return null;
};

const authorizeSessionResourceRoute = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  params: Readonly<Record<string, unknown>>,
  requestId: string,
): { sessionId: string } | Response => {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
  if (!sessionId) {
    return invalidRequestResponse(requestId);
  }
  const authorizationError = authorizeSensitiveRoute(input, init, sessionId, requestId);
  return authorizationError ?? { sessionId };
};

export const handleMockRoute = (request: MockRouteRequest): Response => {
  const { input, init, requestId, routeId, query, params } = request;
  const now = request.now;

  if (routeId === 'session.post') {
    const parsed = parseJsonBody(init, SessionCreateRequestSchema, requestId, { allowEmpty: true });
    if (!parsed.success) {
      return parsed.response;
    }

    const state = resetMockState();
    const payload = buildSessionResponse(state);
    validateMockPayload(SessionResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'vote.post') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VoteRequestSchema, requestId);
    if (!parsed.success) {
      return parsed.response;
    }
    const body = parsed.data;
    const previous = getMockState();
    if (previous.voteTimestamp !== undefined) {
      if (
        previous.voteChoice !== body.vote ||
        normalizeHexString(previous.random ?? '') !== normalizeHexString(body.rand) ||
        normalizeHexString(previous.commitment ?? '') !== normalizeHexString(body.commitment)
      ) {
        const error = createApiErrorResult(ErrorCode.ALREADY_VOTED, requestId);
        return toResponse(error.payload, requestId, error.status);
      }
      const payload = buildVoteResponse(previous);
      validateMockPayload(VoteResponseSchema, payload, routeId);
      return toResponse(payload, requestId);
    }

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
    validateMockPayload(VoteResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'progress.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = updateMockState((current) => {
      if (!current.botVotingStartedAt) {
        current.botVotingStartedAt = now;
      }
    });
    const payload = buildProgressResponse(state, now);
    validateMockPayload(ProgressResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.post') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, FinalizationCreateRequestSchema, requestId);
    if (!parsed.success) {
      return parsed.response;
    }
    const scenarioId: ScenarioId = parsed.data.scenarioId;
    const state = updateMockState((current) => {
      current.scenarioId = scenarioId;
      current.finalizationId = MOCK_FINALIZATION_ID;
      delete current.finalizationFailedAtMs;
      delete current.finalizationError;
      if (!current.finalizationQueuedAtMs) {
        current.finalizationQueuedAtMs = now;
        current.finalizationStartedAtMs = now + 2000;
        current.finalizationCompletedAtMs = current.finalizationStartedAtMs + MOCK_FINALIZATION_DURATION_MS;
      }
    });
    const payload = buildFinalizationResponse(state, now);
    validateMockPayload(FinalizationResponseSchema, payload, routeId);
    return toResponse(payload, requestId, 202);
  }

  if (routeId === 'sessions.finalizations.cancel.post') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, FinalizationCancelRequestSchema, requestId);
    if (!parsed.success) {
      return parsed.response;
    }
    const { reason } = parsed.data;
    const finalizationId = typeof params['finalizationId'] === 'string' ? params['finalizationId'] : undefined;
    if (!finalizationId) {
      return invalidRequestResponse(requestId);
    }

    const state = getMockState();
    if (state.finalizationId !== finalizationId) {
      return errorResponse(
        requestId,
        409,
        'FINALIZATION_NOT_CANCELLABLE',
        'Finalization cannot be cancelled in its current state',
      );
    }
    const queuedAtMs = state.finalizationQueuedAtMs ?? now;
    const startedAtMs = state.finalizationStartedAtMs ?? queuedAtMs + 2000;
    const completedAtMs = state.finalizationCompletedAtMs ?? startedAtMs + MOCK_FINALIZATION_DURATION_MS;
    const status =
      typeof state.finalizationFailedAtMs === 'number'
        ? 'failed'
        : now < startedAtMs
          ? 'pending'
          : now < completedAtMs
            ? 'running'
            : 'succeeded';

    if (status !== 'pending' && status !== 'running') {
      return errorResponse(
        requestId,
        409,
        'FINALIZATION_NOT_CANCELLABLE',
        'Finalization cannot be cancelled in its current state',
      );
    }

    const updated = updateMockState((current) => {
      current.finalizationFailedAtMs = now;
      current.finalizationError = {
        code: 'USER_CANCELLED',
        message: reason?.trim().length ? reason.trim() : 'Cancelled by user request',
      };
    });

    const payload = buildFinalizationCancelResponse(updated, omitUndefinedProperties({ finalizationId, reason, now }));
    validateMockPayload(FinalizationResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.current.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = getMockState();
    const payload = buildCurrentFinalizationResponse(state, now);
    validateMockPayload(CurrentFinalizationResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (
    routeId === 'sessions.finalizations.artifacts.bundle.get' ||
    routeId === 'sessions.finalizations.artifacts.report.get'
  ) {
    const sessionIdFromPath = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
    const finalizationId = typeof params['finalizationId'] === 'string' ? params['finalizationId'] : undefined;
    if (!sessionIdFromPath) {
      return errorResponse(requestId, 400, 'INVALID_BUNDLE_REFERENCE', 'Session ID is required');
    }
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }
    if (finalizationId !== MOCK_FINALIZATION_ID) {
      const code = routeId === 'sessions.finalizations.artifacts.bundle.get' ? 'BUNDLE_NOT_FOUND' : 'REPORT_NOT_FOUND';
      return errorResponse(requestId, 404, code, 'Verification artifact not found');
    }
    if (routeId === 'sessions.finalizations.artifacts.bundle.get') {
      return buildMockBundleResponse(input, init, requestId);
    }
    return toResponse(resolveMockReport(getMockState(), now), requestId);
  }

  if (routeId === 'sessions.bulletin.sth.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }
    const state = getMockState();
    const finalization = buildFinalizationResult(state);
    const payload = successPayload(
      {
        sth: {
          sthDigest: finalization['sthDigest'],
          bulletinRoot: finalization['bulletinRoot'],
          treeSize: finalization['treeSize'],
          timestamp: now,
          logId: state.logId,
        },
      },
      requestId,
    );
    validateMockPayload(SthResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.current.bitmapProof.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }
    const state = getMockState();
    const voteIndex = params['voteIndex'];
    const kind = params['kind'];
    if (typeof voteIndex !== 'number' || (kind !== 'included' && kind !== 'seen')) {
      return invalidRequestResponse(requestId);
    }
    const finalizationResource = buildFinalizationResource(state, now);
    if (finalizationResource?.['status'] !== 'succeeded') {
      return errorResponse(
        requestId,
        400,
        'INVALID_BITMAP_PROOF_REQUEST',
        'Bitmap proof is unavailable until finalization has completed',
      );
    }
    if (state.bulletinIndex === undefined) {
      return errorResponse(requestId, 400, 'USER_NOT_VOTED', 'User has not voted');
    }
    if (voteIndex !== state.bulletinIndex) {
      return errorResponse(
        requestId,
        400,
        'INVALID_BITMAP_PROOF_REQUEST',
        'Bitmap proof requests are limited to the session user vote',
      );
    }
    const finalizationResult = finalizationResource['result'];
    const authority = isRecord(finalizationResult) ? finalizationResult['authority'] : undefined;
    const journal = isRecord(authority) ? authority['journal'] : undefined;
    const treeSize = isRecord(journal) ? journal['treeSize'] : undefined;
    const expectedRoot = isRecord(journal)
      ? kind === 'seen'
        ? journal['seenBitmapRoot']
        : journal['includedBitmapRoot']
      : undefined;
    if (typeof treeSize !== 'number' || typeof expectedRoot !== 'string') {
      return errorResponse(requestId, 400, 'INVALID_BITMAP_PROOF_REQUEST', 'Bitmap evidence is unavailable');
    }
    const bitmapEvidence = buildMockBitmapEvidence(state, treeSize);
    const bitmap = kind === 'seen' ? bitmapEvidence.seenBitmap : bitmapEvidence.includedBitmap;
    const evidenceRoot = kind === 'seen' ? bitmapEvidence.seenBitmapRoot : bitmapEvidence.includedBitmapRoot;
    if (bitmap.length !== treeSize || evidenceRoot !== expectedRoot) {
      return errorResponse(requestId, 400, 'INVALID_BITMAP_PROOF_REQUEST', 'Bitmap root mismatch');
    }
    const proof = generateBitmapMerkleProof(bitmap, voteIndex);
    const payload = successPayload(
      {
        leafChunk: proof.leafChunk,
        auditPath: proof.auditPath,
      },
      requestId,
    );
    validateMockPayload(BitmapProofResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.current.inputCommitment.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }
    const payload = successPayload(
      {
        inputCommitment: buildFinalizationResult(getMockState())['inputCommitment'],
      },
      requestId,
    );
    validateMockPayload(InputCommitmentResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.verification.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const state = getMockState();
    const finalizationId = typeof params['finalizationId'] === 'string' ? params['finalizationId'] : undefined;
    if (!finalizationId) {
      return invalidRequestResponse(requestId);
    }
    const finalizationIsComplete =
      typeof state.finalizationCompletedAtMs === 'number' &&
      now >= state.finalizationCompletedAtMs &&
      typeof state.finalizationFailedAtMs !== 'number';
    if (!state.finalizationId || !finalizationIsComplete) {
      return errorResponse(requestId, 400, 'SESSION_NOT_FINALIZED', 'Session is not finalized');
    }
    if (state.finalizationId !== finalizationId) {
      const payload = successPayload(
        {
          availability: 'unavailable',
          finalizationId,
          reason: 'finalization_not_current',
          message: 'Requested finalization is not the current finalized authority',
        },
        requestId,
      );
      validateMockPayload(VerificationResourceResponseSchema, payload, routeId);
      return toResponse(payload, requestId);
    }
    const includeJournal = query['include'] === 'journal';
    const payload = buildVerificationResourceResponse(state, now, { includeJournal });
    validateMockPayload(VerificationResourceResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.verification.post') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VerificationRunRequestSchema, requestId);
    if (!parsed.success) {
      return parsed.response;
    }

    const finalizationId = typeof params['finalizationId'] === 'string' ? params['finalizationId'] : undefined;
    if (!finalizationId) {
      return invalidRequestResponse(requestId);
    }
    const state = getMockState();
    const finalizationIsComplete =
      typeof state.finalizationCompletedAtMs === 'number' &&
      now >= state.finalizationCompletedAtMs &&
      typeof state.finalizationFailedAtMs !== 'number';
    if (!state.finalizationId || !finalizationIsComplete) {
      return errorResponse(requestId, 400, 'SESSION_NOT_FINALIZED', 'Session is not finalized');
    }
    if (state.finalizationId !== finalizationId) {
      return errorResponse(
        requestId,
        500,
        'INVALID_FINALIZATION_ARTIFACT',
        'Requested finalization is not the current finalized authority',
      );
    }

    const currentStatus = state.verificationStatus ?? 'not_run';
    const verificationStatus = currentStatus === 'not_run' ? 'dev_mode' : currentStatus;
    if (currentStatus === 'not_run') {
      updateMockState((current) => {
        // The browser fixture resolves synchronously and never provides production proof.
        current.verificationStatus = 'dev_mode';
        current.verificationReport = {
          status: 'dev_mode',
        };
      });
    }
    const payload = buildVerificationRunResponse(finalizationId, verificationStatus);
    validateMockPayload(VerificationRunResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.finalizations.verification.observations.post') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const parsed = parseJsonBody(init, VerificationObservationRequestSchema, requestId);
    if (!parsed.success) {
      return parsed.response;
    }

    const finalizationId = typeof params['finalizationId'] === 'string' ? params['finalizationId'] : undefined;
    if (!finalizationId) {
      return invalidRequestResponse(requestId);
    }
    const state = getMockState();
    const verificationStatus = state.verificationStatus ?? 'success';
    const finalizationIsComplete =
      typeof state.finalizationCompletedAtMs === 'number' &&
      now >= state.finalizationCompletedAtMs &&
      typeof state.finalizationFailedAtMs !== 'number';
    if (
      !finalizationIsComplete ||
      (verificationStatus !== 'success' && verificationStatus !== 'failed' && verificationStatus !== 'dev_mode') ||
      finalizationId !== state.finalizationId
    ) {
      return errorResponse(
        requestId,
        409,
        'VERIFICATION_OBSERVATION_CONFLICT',
        'Finalization does not match the current session',
      );
    }
    const fingerprint = JSON.stringify([
      finalizationId,
      ...VERIFICATION_OBSERVATION_CAST_CHECK_IDS.map((id) => parsed.data.castChecks[id]),
    ]);
    const existing = state.verificationObservation;
    if (existing && (existing.finalizationId !== finalizationId || existing.fingerprint !== fingerprint)) {
      return errorResponse(
        requestId,
        409,
        'VERIFICATION_OBSERVATION_CONFLICT',
        'A different verification observation is already recorded',
      );
    }

    const status = existing ? 'idempotent' : 'recorded';
    if (!existing) {
      updateMockState((current) => {
        current.verificationObservation = {
          finalizationId,
          fingerprint,
        };
      });
    }
    const payload = successPayload({ status }, requestId);
    validateMockPayload(VerificationObservationResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.bulletin.consistencyProof.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const fromTreeSize = query['fromTreeSize'];
    const toTreeSize = query['toTreeSize'];
    if (typeof fromTreeSize !== 'number' || typeof toTreeSize !== 'number') {
      return invalidRequestResponse(requestId);
    }
    if (fromTreeSize > toTreeSize) {
      return errorResponse(requestId, 400, 'INVALID_SIZE', 'fromTreeSize cannot be greater than toTreeSize');
    }

    const state = getMockState();
    const bulletinPayload = buildBulletinResponse(state, { now });
    const bulletinData = isRecord(bulletinPayload['data']) ? bulletinPayload['data'] : {};
    const treeSize = bulletinData['treeSize'] as number;
    if (toTreeSize > treeSize) {
      return errorResponse(
        requestId,
        400,
        'INVALID_SIZE',
        `toTreeSize (${toTreeSize}) exceeds tree size (${treeSize})`,
      );
    }

    const payload = buildConsistencyProofResponse(state, { fromTreeSize, toTreeSize, now });
    validateMockPayload(ConsistencyProofResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  if (routeId === 'sessions.votes.inclusionProof.get') {
    const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
    if (authResult instanceof Response) {
      return authResult;
    }

    const voteId = typeof params['voteId'] === 'string' ? params['voteId'] : '';
    const state = getMockState();
    const payload = buildBulletinProofResponse(state, voteId, { now });
    if (!payload) {
      return errorResponse(requestId, 404, 'VOTE_NOT_FOUND', 'Vote proof not found');
    }
    validateMockPayload(BulletinProofResponseSchema, payload, routeId);
    return toResponse(payload, requestId);
  }

  const bulletinRouteId: 'sessions.bulletin.get' = routeId;
  const authResult = authorizeSessionResourceRoute(input, init, params, requestId);
  if (authResult instanceof Response) {
    return authResult;
  }

  const offset = typeof query['offset'] === 'number' ? query['offset'] : undefined;
  const limit = typeof query['limit'] === 'number' ? query['limit'] : undefined;

  const state = getMockState();
  const payload = buildBulletinResponse(
    state,
    omitUndefinedProperties({ offset: offset ?? undefined, limit: limit ?? undefined, now }),
  );
  validateMockPayload(BulletinResponseSchema, payload, bulletinRouteId);
  return toResponse(payload, requestId);
};
