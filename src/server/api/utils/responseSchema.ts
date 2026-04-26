import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { logger } from '@/lib/utils/logger';

type SchemaValidator = {
  safeParse: (value: unknown) => { success: true; data: unknown } | { success: false; error: unknown };
};

export function respondWithSchema(schema: SchemaValidator, payload: unknown, init?: ResponseInit): Response {
  const result = schema.safeParse(payload);
  if (!result.success) {
    logger.error('[API] Response schema validation failed', result.error);
    return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Response schema validation failed' });
  }
  return jsonResponse(result.data, init);
}
