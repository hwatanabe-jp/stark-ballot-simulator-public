export const SAFE_VERIFIER_SEGMENT_PATTERN = /^[A-Za-z0-9-]+$/;

export function isSafeVerifierSegment(value: string): boolean {
  return SAFE_VERIFIER_SEGMENT_PATTERN.test(value);
}

/**
 * Build a relative path for verification bundle assets.
 */
export function buildVerifierPath(sessionId: string, executionId: string, ...segments: string[]): string {
  const relative = ['api', 'verification', 'bundles', sessionId, executionId, ...segments].filter(Boolean).join('/');
  return `/${relative}`;
}

/**
 * Build a public URL for verification bundle assets.
 */
export function buildVerifierUrl(
  baseUrl: string,
  sessionId: string,
  executionId: string,
  ...segments: string[]
): string {
  return new URL(buildVerifierPath(sessionId, executionId, ...segments), baseUrl).toString();
}

/**
 * Build a relative path for session status polling.
 */
export function buildStatusPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/status`;
}

/**
 * Build a public URL for session status polling.
 */
export function buildStatusUrl(baseUrl: string, sessionId: string): string {
  return new URL(buildStatusPath(sessionId), baseUrl).toString();
}
