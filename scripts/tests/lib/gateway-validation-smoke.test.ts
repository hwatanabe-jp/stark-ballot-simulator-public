import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeGatewayValidation } from './gateway-validation-smoke';

describe('Gateway paired validation probes', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('retains only safe IDs and the expected integration outcome for log correlation', async () => {
    let index = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        index += 1;
        return Response.json(
          {
            error: { code: index === 7 ? 'SESSION_CAPABILITY_INVALID' : 'INVALID_REQUEST', message: 'Rejected' },
            meta: { requestId: `gateway-${index}` },
          },
          {
            status: index === 7 ? 401 : 400,
            headers: { 'x-request-id': `gateway-${index}`, 'access-control-allow-origin': 'https://develop.example' },
          },
        );
      }),
    );
    const records = await probeGatewayValidation('https://develop.example', { Cookie: 'private-cookie' });
    expect(records).toHaveLength(7);
    expect(records.at(-1)?.expectedIntegration).toBe(true);
    expect(JSON.stringify(records)).not.toContain('private-cookie');
  });
  it('does not accept a Hono authentication rejection as evidence of Gateway validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'SESSION_CAPABILITY_INVALID', message: 'Rejected' }, meta: { requestId: 'gateway' } },
          { status: 401, headers: { 'x-request-id': 'gateway' } },
        ),
      ),
    );
    await expect(probeGatewayValidation('https://develop.example', {})).rejects.toThrow('rejection order');
  });
});
