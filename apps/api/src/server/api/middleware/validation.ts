import type { Schema } from '@stark-ballot/validation/schema';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { readBoundedRequestBody } from '../../http/boundedRequestBody';
import { errorResponse } from '../../http/response';
import { type SessionCreateRequest, SessionCreateRequestSchema } from '@stark-ballot/api-contract/schemas/sessions';

const DEFAULT_API_REQUEST_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Parsed JSON request payload with raw input.
 */
export interface ParsedBody<T> {
  data: T;
  raw: unknown;
}

function resolveApiRequestBodyLimitBytes(): number {
  const raw = process.env['API_REQUEST_BODY_LIMIT_BYTES']?.trim();
  if (!raw) {
    return DEFAULT_API_REQUEST_BODY_LIMIT_BYTES;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_API_REQUEST_BODY_LIMIT_BYTES;
  }

  return Math.floor(parsed);
}

function payloadTooLargeResponse(limitBytes: number, receivedBytes?: number): Response {
  return errorResponse(ErrorCode.PAYLOAD_TOO_LARGE, {
    limitBytes,
    ...(receivedBytes === undefined ? {} : { receivedBytes }),
  });
}

async function decodeRequestBodyWithinLimit(request: Request): Promise<string | Response> {
  const limitBytes = resolveApiRequestBodyLimitBytes();
  const result = await readBoundedRequestBody(request, limitBytes);
  if (!result.ok) {
    if (result.reason === 'too_large') {
      return payloadTooLargeResponse(result.limitBytes, result.receivedBytes);
    }
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      message: 'Invalid request payload',
    });
  }

  return new TextDecoder().decode(result.bytes);
}

/**
 * Parse and validate a JSON request body using a local schema.
 */
export async function parseJsonBody<TOutput>(
  request: Request,
  schema: Schema<TOutput>,
): Promise<ParsedBody<TOutput> | Response> {
  let raw: unknown;
  const bodyText = await decodeRequestBodyWithinLimit(request);
  if (bodyText instanceof Response) {
    return bodyText;
  }
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      message: 'Invalid JSON payload',
    });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
  }

  return { data: parsed.data, raw };
}

/**
 * Parse and validate the POST /api/sessions payload (body is optional).
 */
export async function parseSessionCreateRequest(
  request: Request,
): Promise<ParsedBody<SessionCreateRequest> | Response> {
  const bodyText = await decodeRequestBodyWithinLimit(request);
  if (bodyText instanceof Response) {
    return bodyText;
  }

  let raw: unknown = {};
  if (bodyText.trim().length > 0) {
    try {
      raw = JSON.parse(bodyText) as unknown;
    } catch {
      return errorResponse(ErrorCode.INVALID_REQUEST, {
        message: 'Invalid JSON payload',
      });
    }
  }

  const parsed = SessionCreateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
  }

  return { data: parsed.data, raw };
}
