import type { SessionIdentity } from '@/lib/session';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { buildVerifierPath, isSafeVerifierSegment } from '@/lib/finalize/finalize-urls';
import { readResponseJsonSafely, resolveVerificationClientApiError } from '@/lib/verification/client-api-errors';
import type { DownloadCandidate } from './verification-data';

interface DownloadOptions {
  authHeaders?: Record<string, string>;
  sessionIdentity?: SessionIdentity | null;
  resolveSessionErrorMessage?: () => string;
}

export async function downloadBundle(candidate: DownloadCandidate, options: DownloadOptions = {}): Promise<void> {
  assertTrustedAuthenticatedDownloadCandidate(candidate);

  const response = await fetch(candidate.url, {
    headers: options.authHeaders ?? {},
  });
  if (!response.ok) {
    const rawBody = await readResponseJsonSafely(response);
    throw resolveVerificationClientApiError({
      rawBody,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      sessionIdentity: options.sessionIdentity,
      resolveSessionErrorMessage: options.resolveSessionErrorMessage,
      fallbackMessage: `HTTP ${response.status}`,
    });
  }

  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = buildBundleFilename();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

function assertTrustedAuthenticatedDownloadCandidate(candidate: DownloadCandidate): void {
  const candidateSource: unknown = candidate.source;
  if (candidateSource !== 'authenticated-endpoint') {
    throw new Error('Invalid bundle download reference');
  }

  if (!isSafeVerifierSegment(candidate.sessionId) || !isSafeVerifierSegment(candidate.executionId)) {
    throw new Error('Invalid bundle download reference');
  }

  const expectedUrl = resolveApiUrl(buildVerifierPath(candidate.sessionId, candidate.executionId));
  if (candidate.url !== expectedUrl) {
    throw new Error('Invalid bundle download reference');
  }
}

function buildBundleFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `stark-ballot-verification-bundle-${timestamp}.zip`;
}
