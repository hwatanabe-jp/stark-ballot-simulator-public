import { createSessionCapabilityToken } from '@/lib/security/sessionCapabilityToken';

export const TEST_SESSION_CAPABILITY_SECRET = 'test-session-capability-secret-0123456789abcdef';

export function setTestSessionCapabilitySecret(): void {
  process.env.SESSION_CAPABILITY_SECRET = TEST_SESSION_CAPABILITY_SECRET;
}

export function createTestSessionCapabilityToken(
  sessionId: string,
  options: {
    nowMs?: number;
    ttlSeconds?: number;
  } = {},
): string {
  return createSessionCapabilityToken(
    {
      sessionId,
      nowMs: options.nowMs ?? Date.now(),
      ttlSeconds: options.ttlSeconds ?? 600,
    },
    TEST_SESSION_CAPABILITY_SECRET,
  );
}
