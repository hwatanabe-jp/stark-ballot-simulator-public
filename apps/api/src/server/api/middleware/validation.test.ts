import { afterEach, describe, expect, it } from 'vitest';
import {
  parseFinalizeRequest,
  parseSessionCreateRequest,
  parseVerificationObservationRequest,
  parseVoteRequest,
} from './validation';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';

const originalBodyLimit = process.env['API_REQUEST_BODY_LIMIT_BYTES'];

afterEach(() => {
  if (originalBodyLimit === undefined) {
    delete process.env['API_REQUEST_BODY_LIMIT_BYTES'];
  } else {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = originalBodyLimit;
  }
});

describe('parseVoteRequest', () => {
  it('returns parsed data for a valid payload', async () => {
    // Given
    const payload = {
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
    };
    const request = new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // When
    const result = await parseVoteRequest(request);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data.vote).toBe('A');
      expect(result.raw).toEqual(payload);
    }
  });

  it('returns INVALID_REQUEST when validation fails', async () => {
    // Given
    const request = new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ vote: 'X' }),
    });

    // When
    const result = await parseVoteRequest(request);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote validation error');
      expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    }
  });

  it('returns INVALID_REQUEST for invalid commitment format', async () => {
    const request = new Request('http://localhost/api/vote', {
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

    const result = await parseVoteRequest(request);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote validation error');
      expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    }
  });

  it('returns INVALID_REQUEST when JSON is malformed', async () => {
    // Given
    const request = new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{"commitment": "0xabc",',
    });

    // When
    const result = await parseVoteRequest(request);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote malformed json');
      expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    }
  });

  it('returns PAYLOAD_TOO_LARGE when payload exceeds configured body limit', async () => {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = '120';
    const request = new Request('http://localhost/api/vote', {
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

    const result = await parseVoteRequest(request);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote payload too large');
      expect(result.status).toBe(413);
      expect(getStringProperty(payload, 'error')).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});

describe('parseVerificationObservationRequest', () => {
  it('returns only the strict browser-local observation payload', async () => {
    const request = new Request('http://localhost/api/verification/observation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verificationExecutionId: 'execution-1',
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'not_run',
          cast_commitment_match: 'failed',
        },
      }),
    });

    const result = await parseVerificationObservationRequest(request);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data).toEqual({
        verificationExecutionId: 'execution-1',
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

describe('parseFinalizeRequest', () => {
  it('returns parsed data with scenarioId', async () => {
    // Given
    const request = new Request('http://localhost/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    // When
    const result = await parseFinalizeRequest(request);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.data.scenarioId).toBe('S0');
    }
  });

  it('rejects finalize requests without scenarioId', async () => {
    // Given
    const request = new Request('http://localhost/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    // When
    const result = await parseFinalizeRequest(request);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize missing scenarioId');
      expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    }
  });
});

describe('parseSessionCreateRequest', () => {
  it('returns PAYLOAD_TOO_LARGE when payload exceeds configured body limit', async () => {
    process.env['API_REQUEST_BODY_LIMIT_BYTES'] = '80';
    const request = new Request('http://localhost/api/session', {
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
      expect(getStringProperty(payload, 'error')).toBe('PAYLOAD_TOO_LARGE');
    }
  });
});
