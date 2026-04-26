import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createNextApiHandler } from './nextApiHandler';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { handleApiError } from '@/lib/errors/errorHandler';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';

vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

vi.mock('@/lib/errors/errorHandler', () => ({
  handleApiError: vi.fn(),
}));

describe('createNextApiHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes request and store to the handler', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const handler = vi.fn(() => NextResponse.json({ ok: true }));
    const wrapped = createNextApiHandler(handler);

    const request = new NextRequest('http://localhost/api/test');
    const response = await wrapped(request);

    expect(handler).toHaveBeenCalledWith({ request, store, params: undefined });
    expect(response).toBeInstanceOf(Response);
  });

  it('passes route params to the handler when provided', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const handler = vi.fn(() => NextResponse.json({ ok: true }));
    const wrapped = createNextApiHandler<{ sessionId: string }>(handler);

    const request = new NextRequest('http://localhost/api/sessions/test/status');
    const response = await wrapped(request, { params: { sessionId: 'test' } });

    expect(handler).toHaveBeenCalledWith({ request, store, params: { sessionId: 'test' } });
    expect(response).toBeInstanceOf(Response);
  });

  it('returns handleApiError output when handler throws', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const error = new Error('boom');
    const fallback = NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
    vi.mocked(handleApiError).mockReturnValue(fallback);

    const handler = vi.fn(() => {
      throw error;
    });
    const wrapped = createNextApiHandler(handler);

    const response = await wrapped(new NextRequest('http://localhost/api/test'));

    expect(handleApiError).toHaveBeenCalledWith(error);
    expect(response).toBe(fallback);
  });
});
