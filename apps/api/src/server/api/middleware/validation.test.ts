import { afterEach, describe, expect, it } from 'vitest';
import { FinalizationCreateRequestSchema } from '@stark-ballot/api-contract/schemas/finalizations';
import { VerificationObservationRequestSchema } from '@stark-ballot/api-contract/schemas/verification';
import { VoteRequestSchema } from '@stark-ballot/api-contract/schemas/votes';
import { parseJsonBody, parseSessionCreateRequest } from './validation';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';

const originalBodyLimit = process.env['API_REQUEST_BODY_LIMIT_BYTES'];

afterEach(() => {
  if (originalBodyLimit === undefined) {
    delete process.env['API_REQUEST_BODY_LIMIT_BYTES'];
  } else {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = originalBodyLimit;
  }
});

describe('parseJsonBody with VoteRequestSchema', () => {
  it('returns parsed data for a valid payload', async () => {
    // Given
    const payload = {
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
    };
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // When
    const result = await parseJsonBody(request, VoteRequestSchema);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data.vote).toBe('A');
      expect(result.raw).toEqual(payload);
    }
  });

  it('returns INVALID_REQUEST when validation fails', async () => {
    // Given
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ vote: 'X' }),
    });

    // When
    const result = await parseJsonBody(request, VoteRequestSchema);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote validation error');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });

  it('returns INVALID_REQUEST for invalid commitment format', async () => {
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commitment: '0x123',
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
      }),
    });

    const result = await parseJsonBody(request, VoteRequestSchema);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote validation error');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });

  it('returns INVALID_REQUEST when JSON is malformed', async () => {
    // Given
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{"commitment": "0xabc",',
    });

    // When
    const result = await parseJsonBody(request, VoteRequestSchema);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote malformed json');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });

  it('returns PAYLOAD_TOO_LARGE when payload exceeds configured body limit', async () => {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = '120';
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commitment: '0x' + 'a'.repeat(64),
        vote: 'A',
        rand: '0x' + 'b'.repeat(64),
        turnstileToken: 'x'.repeat(256),
      }),
    });

    const result = await parseJsonBody(request, VoteRequestSchema);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote payload too large');
      expect(result.status).toBe(413);
      expect(getApiErrorCode(payload)).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('returns INVALID_REQUEST when the request body stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('request body stream failed'));
      },
    });
    const request = new Request('http://localhost/api/sessions/session-123/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const result = await parseJsonBody(request, VoteRequestSchema);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote body read failure');
      expect(result.status).toBe(400);
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });
});

describe('parseJsonBody with VerificationObservationRequestSchema', () => {
  it('returns only the strict browser-local observation payload', async () => {
    const request = new Request(
      'http://localhost/api/sessions/session-1/finalizations/finalization-1/verification/observations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          castChecks: {
            cast_receipt_present: 'success',
            cast_choice_range: 'success',
            cast_random_format: 'not_run',
            cast_commitment_match: 'failed',
          },
        }),
      },
    );

    const result = await parseJsonBody(request, VerificationObservationRequestSchema);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data).toEqual({
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'not_run',
          cast_commitment_match: 'failed',
        },
      });
    }
  });
});

describe('parseJsonBody with FinalizationCreateRequestSchema', () => {
  it('returns parsed data with scenarioId', async () => {
    // Given
    const request = new Request('http://localhost/api/sessions/session-123/finalizations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    // When
    const result = await parseJsonBody(request, FinalizationCreateRequestSchema);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data.scenarioId).toBe('S0');
    }
  });

  it('rejects finalize requests without scenarioId', async () => {
    // Given
    const request = new Request('http://localhost/api/sessions/session-123/finalizations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    // When
    const result = await parseJsonBody(request, FinalizationCreateRequestSchema);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize missing scenarioId');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });
});

describe('parseSessionCreateRequest', () => {
  it('returns PAYLOAD_TOO_LARGE when payload exceeds configured body limit', async () => {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = '80';
    const request = new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        turnstileToken: 'x'.repeat(256),
      }),
    });

    const result = await parseSessionCreateRequest(request);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'session payload too large');
      expect(result.status).toBe(413);
      expect(getApiErrorCode(payload)).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});
