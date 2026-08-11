import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ApiRouteContract } from '@stark-ballot/api-contract/routes';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { logger } from '@stark-ballot/diagnostics/logger';
import { errorResponse } from '../../http/response';

type PublicErrorRoute = Pick<ApiRouteContract, 'publicErrorShape' | 'publicErrors' | 'routeId'>;

function admissionFailure(
  route: PublicErrorRoute,
  response: Response,
  reason: 'invalid-standard-error-envelope' | 'non-json-error-response' | 'undeclared-code-status',
  code?: string,
): Response {
  logger.error('[API] Public route error response admission failed', {
    routeId: route.routeId,
    status: response.status,
    reason,
    ...(code ? { code } : {}),
  });
  return errorResponse(ErrorCode.INTERNAL_ERROR);
}

function isDeclaredErrorResponse(route: PublicErrorRoute, code: string, status: number): boolean {
  return route.publicErrors.responses.some((declaration) => {
    return (
      declaration.envelope === 'standard-error-envelope' &&
      declaration.code === code &&
      declaration.contentType === 'application/json' &&
      (declaration.status === status || declaration.status === 'upstream-response-status')
    );
  });
}

/**
 * Admit a mounted public JSON error through the route's declared code/status
 * allowlist. Successes, conditional responses, artifacts, and the internal
 * callback protocol retain their dedicated response boundaries.
 */
export async function admitPublicRouteErrorResponse(route: PublicErrorRoute, response: Response): Promise<Response> {
  if (response.status < 400 || response.status === 304 || route.publicErrorShape !== 'standard-error-envelope') {
    return response;
  }

  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return admissionFailure(route, response, 'non-json-error-response');
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return admissionFailure(route, response, 'invalid-standard-error-envelope');
  }

  const parsed = StandardErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return admissionFailure(route, response, 'invalid-standard-error-envelope');
  }

  const code = parsed.data.error.code;
  if (!isDeclaredErrorResponse(route, code, response.status)) {
    return admissionFailure(route, response, 'undeclared-code-status', code);
  }

  return response;
}
