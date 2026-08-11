import { randomUUID } from 'node:crypto';
import { getLogContext } from '@stark-ballot/diagnostics/requestLogContext';

/**
 * Resolve the server-owned request ID for a public JSON response.
 *
 * Mounted Hono requests always run inside the request log context. The UUID
 * fallback keeps direct handler/helper tests and non-Hono adapters well-formed
 * without ever accepting a client-supplied request ID.
 */
export function resolvePublicRequestId(): string {
  const requestId = getLogContext()?.requestId?.trim();
  return requestId || randomUUID();
}
