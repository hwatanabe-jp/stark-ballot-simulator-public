import { describe, expect, it } from 'vitest';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { resolvePublicRequestId } from './publicRequestId';

describe('resolvePublicRequestId', () => {
  it('uses the trusted request logging context', () => {
    expect(runWithLogContext({ requestId: 'trusted-request-id' }, () => resolvePublicRequestId())).toBe(
      'trusted-request-id',
    );
  });

  it('generates a request ID when invoked outside a mounted request', () => {
    expect(resolvePublicRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
