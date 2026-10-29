import { describe, expect, it } from 'vitest';
import { jsonResponse, errorResponse } from './response';
import { ErrorCode, getErrorMessage } from '@stark-ballot/api-contract/errors/apiErrors';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getObjectProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';

describe('jsonResponse', () => {
  it('returns JSON with default status and content type', async () => {
    const response = jsonResponse({ data: { ok: true } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const payload = await readJsonRecord(response, 'json response');
    const data = getObjectProperty(payload, 'data');
    expect(data?.['ok']).toBe(true);
  });

  it('respects custom status and headers', async () => {
    const response = jsonResponse({ data: { status: 'created' } }, { status: 201, headers: { 'X-Test': 'ok' } });

    expect(response.status).toBe(201);
    expect(response.headers.get('X-Test')).toBe('ok');

    const payload = await readJsonRecord(response, 'json response');
    expect(getStringProperty(getObjectProperty(payload, 'data'), 'status')).toBe('created');
  });
});

describe('errorResponse', () => {
  it('wraps an error in the canonical envelope with the trusted request ID', async () => {
    const response = runWithLogContext({ requestId: 'trusted-response-request-id' }, () =>
      errorResponse(ErrorCode.INVALID_REQUEST),
    );

    expect(response.status).toBe(400);

    const payload = await readJsonRecord(response, 'error response');
    expect(StandardErrorResponseSchema.parse(payload)).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: getErrorMessage(ErrorCode.INVALID_REQUEST),
      },
      meta: {
        requestId: 'trusted-response-request-id',
      },
    });
    expect(payload).not.toHaveProperty('statusCode');
  });

  it('drops retired artifact-state and generation details', async () => {
    const response = runWithLogContext({ requestId: 'trusted-details-request-id' }, () =>
      errorResponse(ErrorCode.INVALID_FINALIZATION_ARTIFACT, {
        // @ts-expect-error Retired untrusted details must remain outside the closed public input type.
        artifactState: 'corrupt_or_unreadable',
        persistedContractGeneration: 'private-generation',
      }),
    );

    const payload = await readJsonRecord(response, 'error response');
    expect(getObjectProperty(getObjectProperty(payload, 'error'), 'details')).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('private-generation');
  });

  it('returns finalize ImageID mismatches as a standard error envelope', async () => {
    const response = runWithLogContext({ requestId: 'trusted-image-request-id' }, () =>
      errorResponse(ErrorCode.INVALID_IMAGE_ID, {
        details: 'Finalization receipt ImageID did not match the expected ImageID',
      }),
    );

    expect(response.status).toBe(400);
    const payload = await readJsonRecord(response, 'error response');
    expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
    expect(getStringProperty(getObjectProperty(payload, 'error'), 'code')).toBe('INVALID_IMAGE_ID');
    expect(getObjectProperty(payload, 'meta')).toEqual({ requestId: 'trusted-image-request-id' });
    expect(JSON.stringify(payload)).not.toContain('Finalization receipt ImageID did not match');
  });
});
