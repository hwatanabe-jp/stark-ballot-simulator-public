import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';

export async function readApiJson(response: Pick<Response, 'json'>): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function readStandardApiErrorCode(payload: unknown): string | undefined {
  const parsed = StandardErrorResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.code : undefined;
}

export function readStandardApiErrorMessage(payload: unknown): string | undefined {
  const parsed = StandardErrorResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.message : undefined;
}
