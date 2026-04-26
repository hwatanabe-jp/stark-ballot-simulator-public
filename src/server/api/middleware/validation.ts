import type { ZodType, ZodTypeDef } from 'zod';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse } from '@/server/http/response';
import {
  FinalizeRequestSchema,
  SessionCreateRequestSchema,
  VoteRequestSchema,
  VerificationRunRequestSchema,
  type FinalizeRequest,
  type SessionCreateRequest,
  type VerificationRunRequest,
  type VoteRequest,
} from '@/lib/validation/apiSchemas';

const DEFAULT_API_REQUEST_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Parsed JSON request payload with raw input.
 */
export interface ParsedBody<T> {
  data: T;
  raw: unknown;
}

function resolveApiRequestBodyLimitBytes(): number {
  const raw = process.env.API_REQUEST_BODY_LIMIT_BYTES?.trim();
  if (!raw) {
    return DEFAULT_API_REQUEST_BODY_LIMIT_BYTES;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_API_REQUEST_BODY_LIMIT_BYTES;
  }

  return Math.floor(parsed);
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function payloadTooLargeResponse(limitBytes: number, receivedBytes?: number): Response {
  return errorResponse(ErrorCode.PAYLOAD_TOO_LARGE, {
    limitBytes,
    ...(receivedBytes === undefined ? {} : { receivedBytes }),
  });
}

async function readRequestTextWithBodyLimit(request: Request): Promise<string | Response> {
  const limitBytes = resolveApiRequestBodyLimitBytes();
  const contentLength = parseContentLength(request.headers);
  if (contentLength !== null && contentLength > limitBytes) {
    return payloadTooLargeResponse(limitBytes, contentLength);
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let bodyText = '';

  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation errors because we already have a definitive response.
        }
        return payloadTooLargeResponse(limitBytes, totalBytes);
      }

      bodyText += decoder.decode(chunk, { stream: true });
      result = await reader.read();
    }
    bodyText += decoder.decode();
  } catch (error) {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      message: 'Invalid request payload',
      cause: error instanceof Error ? error.message : 'Unknown body parse error',
    });
  }

  return bodyText;
}

/**
 * Parse and validate a JSON request body using a Zod schema.
 */
export async function parseJsonBody<TOutput, TInput>(
  request: Request,
  schema: ZodType<TOutput, ZodTypeDef, TInput>,
): Promise<ParsedBody<TOutput> | Response> {
  let raw: unknown;
  const bodyText = await readRequestTextWithBodyLimit(request);
  if (bodyText instanceof Response) {
    return bodyText;
  }
  try {
    raw = JSON.parse(bodyText) as unknown;
  } catch (error) {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      message: 'Invalid JSON payload',
      cause: error instanceof Error ? error.message : 'Unknown JSON parse error',
    });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
  }

  return { data: parsed.data, raw };
}

/**
 * Parse and validate the /api/vote payload.
 */
export async function parseVoteRequest(request: Request): Promise<ParsedBody<VoteRequest> | Response> {
  return parseJsonBody(request, VoteRequestSchema);
}

/**
 * Parse and validate the /api/session payload (body is optional).
 */
export async function parseSessionCreateRequest(
  request: Request,
): Promise<ParsedBody<SessionCreateRequest> | Response> {
  const bodyText = await readRequestTextWithBodyLimit(request);
  if (bodyText instanceof Response) {
    return bodyText;
  }

  let raw: unknown = {};
  if (bodyText.trim().length > 0) {
    try {
      raw = JSON.parse(bodyText) as unknown;
    } catch (error) {
      return errorResponse(ErrorCode.INVALID_REQUEST, {
        message: 'Invalid JSON payload',
        cause: error instanceof Error ? error.message : 'Unknown JSON parse error',
      });
    }
  }

  const parsed = SessionCreateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
  }

  return { data: parsed.data, raw };
}

/**
 * Parse and validate the /api/finalize payload.
 */
export async function parseFinalizeRequest(request: Request): Promise<ParsedBody<FinalizeRequest> | Response> {
  const result = await parseJsonBody(request, FinalizeRequestSchema);
  if (result instanceof Response) {
    return result;
  }
  return { data: result.data, raw: result.raw };
}

/**
 * Parse and validate the /api/verification/run payload.
 */
export async function parseVerificationRunRequest(
  request: Request,
): Promise<ParsedBody<VerificationRunRequest> | Response> {
  const result = await parseJsonBody(request, VerificationRunRequestSchema);
  if (result instanceof Response) {
    return result;
  }

  return {
    data: result.data,
    raw: result.raw,
  };
}
