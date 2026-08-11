import { renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity } from '@stark-ballot/web/session';
import { VERIFICATION_CHECK_DEFINITIONS } from '@stark-ballot/verification/checks';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { VerificationPayload } from '../lib/verification-data';
import { useVerificationObservation } from './useVerificationObservation';

vi.mock('@stark-ballot/web/session', () => ({
  getSessionDataForIdentity: vi.fn(() => ({
    sessionId: 'session-1',
    capabilityToken: 'redacted-capability',
  })),
}));

vi.mock('@stark-ballot/web/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@stark-ballot/web/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

const apiModule = await import('@stark-ballot/web/api/apiFetch');
const mockApiFetch = vi.mocked(apiModule.apiFetch);

const castCheckIds = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
] as const;

function payload(): VerificationPayload {
  return {
    finalizationId: 'finalization-1',
    verificationStatus: 'success',
    verificationChecks: castCheckIds.map((id) => {
      const definition = VERIFICATION_CHECK_DEFINITIONS.find((candidate) => candidate.id === id);
      if (!definition) {
        throw new Error(`Missing verification check definition: ${id}`);
      }
      return {
        id,
        status: 'success',
        evidence: definition.evidence,
        inputs: definition.inputs,
      };
    }),
  };
}

describe('useVerificationObservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { status: 'recorded' },
          meta: { requestId: 'request-id' },
        }),
        { status: 200 },
      ),
    );
  });

  it('submits once only after server validation, terminal verification, and completed presentation', async () => {
    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'redacted-capability',
      },
    } as MutableRefObject<SessionIdentity | null>;
    const data = payload();
    type ObservationProps = {
      sequenceComplete: boolean;
      verificationStatus: VerificationStatus;
    };
    const { rerender } = renderHook<void, ObservationProps>(
      ({ sequenceComplete, verificationStatus }) =>
        useVerificationObservation({
          data,
          sequenceComplete,
          hasCheckPending: false,
          serverValidated: true,
          verificationStatus,
          sessionIdentityRef,
        }),
      {
        initialProps: {
          sequenceComplete: false,
          verificationStatus: 'running',
        },
      },
    );

    expect(mockApiFetch).not.toHaveBeenCalled();

    rerender({ sequenceComplete: true, verificationStatus: 'running' });
    expect(mockApiFetch).not.toHaveBeenCalled();

    rerender({ sequenceComplete: true, verificationStatus: 'success' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/sessions/session-1/finalizations/finalization-1/verification/observations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Capability': 'redacted-capability',
        },
        body: JSON.stringify({
          castChecks: {
            cast_receipt_present: 'success',
            cast_choice_range: 'success',
            cast_random_format: 'success',
            cast_commitment_match: 'success',
          },
        }),
      },
    );

    rerender({ sequenceComplete: true, verificationStatus: 'success' });
    await Promise.resolve();
    expect(mockApiFetch).toHaveBeenCalledOnce();
  });

  it('does not submit pending checks or provisional data', async () => {
    const data = payload();
    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'redacted-capability',
      },
    } as MutableRefObject<SessionIdentity | null>;

    renderHook(() =>
      useVerificationObservation({
        data,
        sequenceComplete: true,
        hasCheckPending: true,
        serverValidated: true,
        verificationStatus: 'success',
        sessionIdentityRef,
      }),
    );
    renderHook(() =>
      useVerificationObservation({
        data,
        sequenceComplete: true,
        hasCheckPending: false,
        serverValidated: false,
        verificationStatus: 'success',
        sessionIdentityRef,
      }),
    );

    await Promise.resolve();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('does not retry a deterministic client error for the same observation fingerprint', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid verification observation',
          },
          meta: { requestId: 'request-id' },
        }),
        { status: 409 },
      ),
    );
    const sessionIdentityRef = {
      current: {
        sessionId: 'session-1',
        capabilityToken: 'redacted-capability',
      },
    } as MutableRefObject<SessionIdentity | null>;
    type ObservationProps = { data: VerificationPayload };
    const { rerender } = renderHook<void, ObservationProps>(
      ({ data }) =>
        useVerificationObservation({
          data,
          sequenceComplete: true,
          hasCheckPending: false,
          serverValidated: true,
          verificationStatus: 'success',
          sessionIdentityRef,
        }),
      { initialProps: { data: payload() } },
    );

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledOnce());
    rerender({ data: payload() });
    await Promise.resolve();
    expect(mockApiFetch).toHaveBeenCalledOnce();
  });
});
