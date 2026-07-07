import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';

export { isSafeVerifierSegment };

export function buildVerifierPath(sessionId: string, executionId: string, ...segments: string[]): string {
  const relative = ['api', 'verification', 'bundles', sessionId, executionId, ...segments].filter(Boolean).join('/');
  return `/${relative}`;
}
