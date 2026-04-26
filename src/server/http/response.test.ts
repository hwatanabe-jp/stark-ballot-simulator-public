import { describe, expect, it } from 'vitest';
import { jsonResponse, errorResponse } from './response';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@/lib/utils/guards';

describe('jsonResponse', () => {
  it('returns JSON with default status and content type', async () => {
    const response = jsonResponse({ data: { ok: true } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const payload = await readJsonRecord(response, 'json response');
    const data = getRecordProperty(payload, 'data');
    expect(data?.ok).toBe(true);
  });

  it('respects custom status and headers', async () => {
    const response = jsonResponse({ data: { status: 'created' } }, { status: 201, headers: { 'X-Test': 'ok' } });

    expect(response.status).toBe(201);
    expect(response.headers.get('X-Test')).toBe('ok');

    const payload = await readJsonRecord(response, 'json response');
    expect(getStringProperty(getRecordProperty(payload, 'data'), 'status')).toBe('created');
  });
});

describe('errorResponse', () => {
  it('wraps ApiError payload with status code', async () => {
    const response = errorResponse(ErrorCode.INVALID_REQUEST);

    expect(response.status).toBe(400);

    const payload = await readJsonRecord(response, 'error response');
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    expect(getNumberProperty(payload, 'statusCode')).toBe(400);
  });

  it('includes error details when provided', async () => {
    const response = errorResponse(ErrorCode.SESSION_EXPIRED, { sessionId: 'sess-123' });

    const payload = await readJsonRecord(response, 'error response');
    expect(getStringProperty(payload, 'sessionId')).toBe('sess-123');
  });
});
