import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import type { Schema } from '@stark-ballot/validation/schema';

export type StandardApiErrorPayload = ReturnType<typeof StandardErrorResponseSchema.parse>;

export async function readApiJson(response: Pick<Response, 'json'>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function admitApiResponse<T>(schema: Schema<T>, payload: unknown, label: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new Error(`Invalid ${label} payload: ${firstIssue?.message ?? 'schema validation failed'}`);
  }
  return parsed.data;
}

export async function readStandardApiError(response: Pick<Response, 'json'>): Promise<unknown> {
  const payload = await readApiJson(response);
  const parsed = StandardErrorResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : payload;
}

export function readStandardApiErrorCode(payload: unknown): string | undefined {
  const parsed = StandardErrorResponseSchema.safeParse(payload);
  return parsed.success && typeof parsed.data['error'] === 'string' ? parsed.data['error'] : undefined;
}

export function readStandardApiErrorMessage(payload: unknown): string | undefined {
  const parsed = StandardErrorResponseSchema.safeParse(payload);
  return parsed.success && typeof parsed.data['message'] === 'string' ? parsed.data['message'] : undefined;
}
