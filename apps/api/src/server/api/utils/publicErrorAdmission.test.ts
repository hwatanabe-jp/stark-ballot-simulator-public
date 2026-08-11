import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { logger } from '@stark-ballot/diagnostics/logger';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { errorResponse, jsonResponse } from '../../http/response';
import { admitPublicRouteErrorResponse } from './publicErrorAdmission';

function trustedRequest<T>(callback: () => T): T {
  return runWithLogContext({ requestId: 'trusted-admission-request-id' }, callback);
}

describe('admitPublicRouteErrorResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('admits a canonical error only when its code and status are declared by the route', async () => {
    const response = trustedRequest(() => errorResponse(ErrorCode.SESSION_NOT_FOUND));

    const admitted = await trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.progress, response));

    expect(admitted).toBe(response);
    expect(admitted.status).toBe(404);
  });

  it('fails closed when a public JSON error uses a flat legacy payload', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const response = jsonResponse(
      {
        error: 'SESSION_NOT_FOUND',
        message: 'Session not found',
        statusCode: 404,
      },
      { status: 404 },
    );

    const admitted = await trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.progress, response));

    expect(admitted.status).toBe(500);
    const payload = await readJsonRecord(admitted, 'failed public error admission');
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(payload).toHaveProperty('meta.requestId', 'trusted-admission-request-id');
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy).toHaveBeenCalledWith(
      '[API] Public route error response admission failed',
      expect.objectContaining({
        routeId: API_ROUTES.progress.routeId,
        reason: 'invalid-standard-error-envelope',
      }),
    );
  });

  it('fails closed when a canonical code is returned with an undeclared status', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const response = trustedRequest(() =>
      errorResponse(new ApiError(ErrorCode.SESSION_NOT_FOUND, 409, 'Session not found')),
    );

    const admitted = await trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.progress, response));

    expect(admitted.status).toBe(500);
    expect(getApiErrorCode(await readJsonRecord(admitted, 'undeclared public error status'))).toBe('INTERNAL_ERROR');
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy).toHaveBeenCalledWith('[API] Public route error response admission failed', {
      routeId: API_ROUTES.progress.routeId,
      status: 409,
      reason: 'undeclared-code-status',
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it('admits declared upstream Turnstile response statuses', async () => {
    const response = trustedRequest(() =>
      errorResponse(new ApiError(ErrorCode.CAPTCHA_FAILED, 502, 'Turnstile upstream rejected the request')),
    );

    const admitted = await trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.createSession, response));

    expect(admitted).toBe(response);
    expect(admitted.status).toBe(502);
  });

  it('keeps the internal callback outside public inventory and ignores successful and 304 responses', async () => {
    const success = jsonResponse({ protectedReport: true });
    const notModified = new Response(null, { status: 304 });

    expect('finalizationCallback' in API_ROUTES).toBe(false);
    await expect(
      trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.finalizationArtifactReport, success)),
    ).resolves.toBe(success);
    await expect(
      trustedRequest(() => admitPublicRouteErrorResponse(API_ROUTES.currentFinalizationBitmapProof, notModified)),
    ).resolves.toBe(notModified);
  });
});
