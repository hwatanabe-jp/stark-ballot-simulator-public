import { describe, expect, it } from 'vitest';
import { ErrorCode, createApiErrorResult } from '../errors/apiErrors';
import { API_ROUTES, TARGET_API_ROUTE_CONTRACTS, matchApiRoute } from '../routes';
import {
  ProgressResponseSchema,
  SessionCreateRequestSchema,
  PathSessionCapabilityHeadersSchema,
  SessionResponseSchema,
  StandardErrorResponseSchema,
  VerificationResourceResponseSchema,
  VoteRequestSchema,
  VoteResponseSchema,
  apiResponseSchema,
  publicObject,
} from './index';
import { getSchemaDescriptor, s } from '@stark-ballot/validation/schema';

const REQUEST_ID = 'trusted-request-id';
const META = { requestId: REQUEST_ID };
const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;

describe('public JSON and voting resource contract', () => {
  it('requires the strict success envelope', () => {
    const schema = apiResponseSchema(publicObject({ value: s.string() }));

    expect(schema.safeParse({ data: { value: 'ok' }, meta: META }).success).toBe(true);
    expect(schema.safeParse({ data: { value: 'ok' } }).success).toBe(false);
    expect(schema.safeParse({ data: { value: 'ok' }, meta: META, statusCode: 200 }).success).toBe(false);
    expect(schema.safeParse({ data: { value: 'ok' }, meta: { ...META, source: 'client' } }).success).toBe(false);
  });

  it('wraps every declared public non-artifact JSON success and keeps internal callback/exempt responses outside it', () => {
    const failures: string[] = [];

    for (const route of TARGET_API_ROUTE_CONTRACTS) {
      for (const response of route.responses) {
        if (response.content !== 'json' || !('schema' in response)) {
          continue;
        }
        const descriptor = getSchemaDescriptor(response.schema);
        if (descriptor.kind !== 'ObjectSchema' || Object.keys(descriptor.shape).sort().join(',') !== 'data,meta') {
          failures.push(`${route.routeId}:${response.status}`);
        }
      }
    }

    expect(failures).toEqual([]);
    expect('finalizationCallback' in API_ROUTES).toBe(false);
    expect(API_ROUTES.finalizationArtifactReport.responses[0]).toMatchObject({
      content: 'json',
      exemptReason: 'protected-report-artifact-download',
    });
  });

  it('binds every declared standard-envelope response to a canonical ErrorCode', () => {
    const knownCodes = new Set<string>(Object.values(ErrorCode));
    const missing = TARGET_API_ROUTE_CONTRACTS.flatMap((route) =>
      route.publicErrors.responses.flatMap((response) =>
        !knownCodes.has(response.code) ? [`${route.routeId}:${response.code}`] : [],
      ),
    );

    expect(missing).toEqual([]);
  });

  it.each([
    {
      kind: 'validation',
      issues: { formErrors: ['Invalid request'], fieldErrors: { vote: ['Expected string'] } },
    },
    {
      kind: 'rateLimit',
      retryAfterSeconds: 30,
      nextAvailableAtMs: 1_750_000_000_000,
      remainingExecutions: 0,
    },
    { kind: 'bodyLimit', limitBytes: 1024, receivedBytes: 2048 },
    {
      kind: 'verificationState',
      status: 'failed',
      finalizationId: 'finalization-1',
      errorCodes: ['verification-failed'],
    },
    {
      kind: 'proofRange',
      voteIndex: 1,
      expectedTreeSize: 64,
      actualTreeSize: 63,
    },
  ])('accepts the closed $kind error detail', (details) => {
    expect(
      StandardErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          details,
        },
        meta: META,
      }).success,
    ).toBe(true);
  });

  it('rejects flat, status-bearing, internal, and untagged error payloads', () => {
    const canonical = {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Invalid request',
      },
      meta: META,
    };

    expect(StandardErrorResponseSchema.safeParse(canonical).success).toBe(true);
    expect(
      StandardErrorResponseSchema.safeParse({
        error: 'INVALID_REQUEST',
        message: 'Invalid request',
        statusCode: 400,
        meta: META,
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...canonical,
        statusCode: 400,
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...canonical,
        error: {
          ...canonical.error,
          details: {
            kind: 'artifactState',
            state: 'unsupported_current_artifact',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...canonical,
        error: {
          ...canonical.error,
          details: {
            kind: 'verificationState',
            status: 'failed',
            verificationReport: { status: 'failed' },
            internalDebugContext: 'private',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...canonical,
        error: {
          ...canonical.error,
          details: { retryAfterSeconds: 30 },
        },
      }).success,
    ).toBe(false);
  });

  it('keeps HTTP status outside the canonical error payload and requires a caller request ID', () => {
    const result = createApiErrorResult(ErrorCode.GLOBAL_LIMIT_EXCEEDED, REQUEST_ID, {
      retryAfter: 30,
      nextAvailableAt: '2026-07-30T00:00:00.000Z',
      remainingExecutions: 0,
    });

    expect(result).toEqual({
      status: 503,
      payload: {
        error: {
          code: ErrorCode.GLOBAL_LIMIT_EXCEEDED,
          message: 'システムが混雑しています。しばらくしてからお試しください',
          details: {
            kind: 'rateLimit',
            retryAfterSeconds: 30,
            nextAvailableAtMs: Date.parse('2026-07-30T00:00:00.000Z'),
            remainingExecutions: 0,
          },
        },
        meta: META,
      },
    });
    expect(result.payload).not.toHaveProperty('statusCode');
    expect(() => createApiErrorResult(ErrorCode.INVALID_REQUEST, '')).toThrow(/requestId/u);
  });

  it('accepts an explicitly tagged detail through the internal error helper', () => {
    const result = createApiErrorResult(ErrorCode.PAYLOAD_TOO_LARGE, REQUEST_ID, {
      details: {
        kind: 'bodyLimit',
        limitBytes: 1024,
        receivedBytes: 2048,
      },
    });

    expect(result.payload.error.details).toEqual({
      kind: 'bodyLimit',
      limitBytes: 1024,
      receivedBytes: 2048,
    });
  });

  it('drops the private verifier report from admitted error detail fields', () => {
    const result = createApiErrorResult(ErrorCode.VERIFICATION_FAILED, REQUEST_ID, {
      status: 'failed',
      finalizationId: 'finalization-1',
      errorCodes: ['verification-failed'],
      verificationReport: { status: 'failed', errors: ['private path'] },
    });

    expect(result.payload.error.details).toEqual({
      kind: 'verificationState',
      status: 'failed',
      finalizationId: 'finalization-1',
      errorCodes: ['verification-failed'],
    });
  });

  it('exposes session creation, vote submission, and progress polling only on resource paths', () => {
    expect(API_ROUTES.createSession.path).toBe('/sessions');
    expect(API_ROUTES.submitVote.path).toBe('/sessions/:sessionId/votes');
    expect(API_ROUTES.progress.path).toBe('/sessions/:sessionId/progress');
    expect(API_ROUTES.submitVote).toMatchObject({
      authScope: 'path-session-capability',
      capabilityScope: 'path',
    });
    expect(API_ROUTES.progress).toMatchObject({
      authScope: 'path-session-capability',
      capabilityScope: 'path',
    });
    expect(matchApiRoute('POST', '/api/session')).toBeNull();
    expect(matchApiRoute('POST', '/api/vote')).toBeNull();
    expect(matchApiRoute('GET', '/api/progress')).toBeNull();
  });

  it('accepts only the path-scoped capability credential', () => {
    expect(
      PathSessionCapabilityHeadersSchema.safeParse({
        'X-Session-Capability': 'capability-token',
      }).success,
    ).toBe(true);
    expect(
      PathSessionCapabilityHeadersSchema.safeParse({
        'X-Session-Capability': 'capability-token',
        'X-Session-ID': 'legacy-session-id',
      }).success,
    ).toBe(false);
    expect(Object.keys(API_ROUTES.submitVote.request.headers.shape)).toEqual(['X-Session-Capability']);
  });

  it('accepts only canonical Turnstile request fields and metadata', () => {
    expect(SessionCreateRequestSchema.safeParse({ turnstileToken: 'token' }).success).toBe(true);
    expect(SessionCreateRequestSchema.safeParse({ 'cf-turnstile-response': 'token' }).success).toBe(false);
    expect(
      VoteRequestSchema.safeParse({
        commitment: HEX_A,
        vote: 'A',
        rand: HEX_B,
        cfTurnstileResponse: 'token',
      }).success,
    ).toBe(false);

    for (const route of [API_ROUTES.createSession, API_ROUTES.submitVote, API_ROUTES.createFinalization]) {
      expect(route.turnstile.tokenLocations).toEqual(['body.turnstileToken']);
    }
  });

  it('uses semantic and unit-bearing session, vote, and progress fields', () => {
    expect(
      SessionResponseSchema.safeParse({
        data: {
          sessionId: 'session-1',
          electionId: 'election-1',
          electionConfigHash: HEX_A,
          logId: 'log-1',
          capabilityToken: 'capability-token',
        },
        meta: META,
      }).success,
    ).toBe(true);
    expect(
      VoteResponseSchema.safeParse({
        data: {
          voteId: 'vote-1',
          commitment: HEX_A,
          bulletinIndex: 0,
          bulletinRootAtCast: HEX_B,
          castAtMs: 1_750_000_000_000,
        },
        meta: META,
      }).success,
    ).toBe(true);
    expect(
      ProgressResponseSchema.safeParse({
        data: {
          count: 1,
          total: 63,
          completed: false,
          userVoted: true,
          finalized: false,
          distributionKind: 'simulated',
          updatedAtMs: 1_750_000_000_000,
        },
        meta: META,
      }).success,
    ).toBe(true);
    expect(
      ProgressResponseSchema.safeParse({
        data: {
          count: 1,
          total: 63,
          completed: false,
          userVoted: true,
          finalized: false,
          distributionKind: 'observed',
        },
        meta: META,
      }).success,
    ).toBe(false);
  });

  it('models unavailable verification as an explicit success-data discriminator', () => {
    const response = {
      data: {
        availability: 'corrupt',
        finalizationId: 'finalization-1',
        reason: 'invalid_artifact',
        message: 'Verification artifact is invalid',
      },
      meta: META,
    };

    expect(VerificationResourceResponseSchema.safeParse(response).success).toBe(true);
    expect(
      VerificationResourceResponseSchema.safeParse({
        error: 'INVALID_FINALIZATION_ARTIFACT',
        message: response.data.message,
        reason: response.data.reason,
      }).success,
    ).toBe(false);
  });
});
