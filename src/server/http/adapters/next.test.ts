import { describe, expect, it, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { toApiContext } from './next';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';

describe('toApiContext', () => {
  const originalTrustedProxy = process.env.TRUSTED_PROXY;

  afterEach(() => {
    if (originalTrustedProxy === undefined) {
      delete process.env.TRUSTED_PROXY;
    } else {
      process.env.TRUSTED_PROXY = originalTrustedProxy;
    }
  });

  it('maps request, store, params, and client IP', async () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    const store = createMockVoteStore();
    const request = new NextRequest('http://localhost/api/test', {
      headers: {
        'cf-connecting-ip': '203.0.113.20',
      },
    });

    const context = await toApiContext({
      request,
      store,
      params: Promise.resolve({ voteId: 'vote-123' }),
    });

    expect(context.request).toBe(request);
    expect(context.store).toBe(store);
    expect(context.params).toEqual({ voteId: 'vote-123' });
    expect(context.clientIp).toBe('203.0.113.20');
  });
});
