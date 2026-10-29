import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas';

/** AWS-only paired probes. Access-log correlation must establish integration
 * absence/presence; HTTP 400 alone is deliberately not an acceptance result. */
export async function probeGatewayValidation(baseUrl: string, operatorHeaders: Record<string, string>) {
  const votePath = '/api/sessions/gateway-probe/votes';
  const records: Array<{ probe: string; requestId: string; status: number; expectedIntegration: boolean }> = [];
  const validVote = JSON.stringify({ commitment: 'a'.repeat(64), rand: 'b'.repeat(64), vote: 'A' });
  const probes = [
    { name: 'body-json', path: votePath, body: '{}', media: 'application/json', rejected: true },
    { name: 'body-charset', path: votePath, body: '{}', media: 'application/json; charset=utf-8', rejected: true },
    { name: 'body-default-model', path: votePath, body: '{}', media: 'text/plain', rejected: true },
    { name: 'body-syntax', path: votePath, body: '{', media: 'application/json', rejected: true },
    { name: 'body-empty', path: votePath, body: '', media: 'application/json', rejected: true },
    {
      name: 'shadow-verification',
      path: '/api/sessions/gateway-probe/finalizations/current/verification',
      body: '{"extra":true}',
      media: 'application/json',
      rejected: true,
    },
    {
      name: 'valid-body-invalid-capability',
      path: votePath,
      body: validVote,
      media: 'application/json',
      rejected: false,
    },
  ];
  for (const probe of probes) {
    const response = await fetch(new URL(probe.path, baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...operatorHeaders,
        Origin: new URL(baseUrl).origin,
        'Content-Type': probe.media,
        'X-Session-Capability': 'invalid-probe-capability',
        'X-Request-Id': 'untrusted-probe-id',
      },
      body: probe.body,
    });
    const parsed = StandardErrorResponseSchema.safeParse(await response.json());
    if (
      !parsed.success ||
      parsed.data.meta.requestId !== response.headers.get('x-request-id') ||
      parsed.data.meta.requestId === 'untrusted-probe-id'
    ) {
      throw new Error(`Gateway probe ${probe.name}: invalid error/correlation envelope`);
    }
    if (
      probe.rejected
        ? response.status !== 400 || parsed.data.error.code !== 'INVALID_REQUEST'
        : response.status !== 401 || parsed.data.error.code !== 'SESSION_CAPABILITY_INVALID'
    ) {
      throw new Error(`Gateway probe ${probe.name}: unexpected rejection order/status`);
    }
    if (probe.rejected && response.headers.get('access-control-allow-origin') !== new URL(baseUrl).origin) {
      throw new Error(`Gateway probe ${probe.name}: missing public body-rejection CORS`);
    }
    records.push({
      probe: probe.name,
      requestId: parsed.data.meta.requestId,
      status: response.status,
      expectedIntegration: !probe.rejected,
    });
  }
  return records;
}
