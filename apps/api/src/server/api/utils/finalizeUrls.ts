/**
 * Build a public URL for session status polling.
 */
export function buildStatusUrl(baseUrl: string, sessionId: string): string {
  return new URL(`/api/sessions/${sessionId}/status`, baseUrl).toString();
}
