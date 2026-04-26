import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import type { SessionData } from '@/types/server';

vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('Hono API route', () => {
  const createBaseSession = (overrides: Partial<SessionData> = {}): SessionData => {
    const now = Date.now();
    return {
      sessionId: 'session-123',
      contractGeneration: resolveCurrentContractGeneration(),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      logId: '0x' + '2'.repeat(64),
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      ...overrides,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.HONO_API_ENABLED;
    delete process.env.HONO_API_MODE;
  });

  afterEach(() => {
    delete process.env.HONO_API_ENABLED;
    delete process.env.HONO_API_MODE;
  });

  it('returns 404 for POST when in readonly mode', async () => {
    process.env.HONO_API_ENABLED = 'true';
    process.env.HONO_API_MODE = 'readonly';

    const { POST } = await import('./route');

    const response = await POST(new NextRequest('http://localhost/api/hono/session', { method: 'POST' }));
    expect(response.status).toBe(404);
  });

  it('allows POST when HONO_API_MODE is full', async () => {
    process.env.HONO_API_ENABLED = 'true';
    process.env.HONO_API_MODE = 'full';

    const store = createMockVoteStore({
      createSession: () => Promise.resolve(createBaseSession()),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const { POST } = await import('./route');

    const response = await POST(new NextRequest('http://localhost/api/hono/session', { method: 'POST' }));
    expect(response.status).toBe(200);
  });
});
