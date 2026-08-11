import { describe, it, expect } from 'vitest';
import {
  VoteRequestSchema,
  SessionCreateRequestSchema,
  SessionResponseSchema,
  FinalizationCreateRequestSchema,
  VerificationObservationRequestSchema,
  VerificationObservationResponseSchema,
  VerificationRunRequestSchema,
  VerificationResourceQuerySchema,
  CurrentFinalizationBitmapProofParamsSchema,
  CurrentFinalizationInputCommitmentParamsSchema,
  BulletinQuerySchema,
  ConsistencyProofQuerySchema,
  ConsistencyProofResponseSchema,
  SthQuerySchema,
  FinalizationResponseSchema,
  CurrentFinalizationResponseSchema,
  StandardErrorResponseSchema,
} from './index';
import finalizeAcceptedFixture from './fixtures/json/finalizations.post.accepted.json';
import finalizeSyncFixture from './fixtures/json/finalizations.post.succeeded.json';
import statusSucceededFixture from './fixtures/json/finalizations.current.succeeded.json';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

describe('VoteRequestSchema', () => {
  it('accepts valid vote payloads', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      turnstileToken: 'token',
    });
    expect(result.success).toBe(true);
  });

  it('rejects retired Turnstile alias fields', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unexpected fields', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
      verificationBundleUrl: 'https://example.invalid/bundle.zip',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid vote choice', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'Z',
      rand: '0x' + 'b'.repeat(64),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(strictDefined(result.error.issues[0]).path).toEqual(['vote']);
    }
  });

  it('rejects commitment with invalid length', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(62),
      vote: 'A',
      rand: '0x' + 'b'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects rand with invalid hex characters', () => {
    const result = VoteRequestSchema.safeParse({
      commitment: '0x' + 'a'.repeat(64),
      vote: 'A',
      rand: '0x' + 'g'.repeat(64),
    });
    expect(result.success).toBe(false);
  });
});

describe('SessionCreateRequestSchema', () => {
  it('rejects retired Turnstile alias fields', () => {
    const result = SessionCreateRequestSchema.safeParse({
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unexpected fields', () => {
    const result = SessionCreateRequestSchema.safeParse({ verificationBundleUrl: 'https://example.invalid' });
    expect(result.success).toBe(false);
  });
});

describe('SessionResponseSchema', () => {
  const response = {
    data: {
      sessionId: 'session-1',
      electionId: 'election-1',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: '0x' + 'b'.repeat(64),
      capabilityToken: 'capability-token',
    },
    meta: { requestId: 'request-1' },
  };

  it('admits the complete semantic session identity without a repository generation marker', () => {
    expect(SessionResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects the retired artifact-contract marker', () => {
    expect(
      SessionResponseSchema.safeParse({
        ...response,
        data: { ...response.data, artifactContractId: 'artifact-contract:sha256:retired' },
      }).success,
    ).toBe(false);
  });
});

describe('FinalizationCreateRequestSchema', () => {
  it('accepts scenarioId payload', () => {
    const result = FinalizationCreateRequestSchema.safeParse({
      scenarioId: 'S0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects retired Turnstile alias fields', () => {
    const result = FinalizationCreateRequestSchema.safeParse({
      scenarioId: 'S0',
      'cf-turnstile-response': 'token',
      cfTurnstileResponse: 'token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects payloads without scenarioId', () => {
    const result = FinalizationCreateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects unexpected fields', () => {
    const result = FinalizationCreateRequestSchema.safeParse({
      scenarioId: 'S0',
      excludedCount: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('VerificationRunRequestSchema', () => {
  it('rejects non-empty payloads', () => {
    const result = VerificationRunRequestSchema.safeParse({ verificationBundleUrl: 'https://example.invalid' });
    expect(result.success).toBe(false);
  });
});

describe('VerificationObservationRequestSchema', () => {
  const validPayload = {
    castChecks: {
      cast_receipt_present: 'success',
      cast_choice_range: 'success',
      cast_random_format: 'not_run',
      cast_commitment_match: 'failed',
    },
  };

  it('accepts exactly all four terminal browser-local cast statuses', () => {
    expect(VerificationObservationRequestSchema.safeParse(validPayload).success).toBe(true);
  });

  it.each([
    {
      ...validPayload,
      castChecks: {
        cast_receipt_present: 'success',
        cast_choice_range: 'success',
        cast_random_format: 'not_run',
      },
    },
    {
      ...validPayload,
      castChecks: {
        ...validPayload.castChecks,
        cast_commitment_match: 'pending',
      },
    },
    {
      ...validPayload,
      castChecks: {
        ...validPayload.castChecks,
        counted_input_sanity: 'success',
      },
    },
    {
      ...validPayload,
      presentedOutcome: 'fully_verified',
    },
    {
      ...validPayload,
      finalizationId: 'finalization-1',
    },
  ])('rejects incomplete, non-terminal, or extra client authority %#', (payload) => {
    expect(VerificationObservationRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe('VerificationObservationResponseSchema', () => {
  it('accepts only the recorded and idempotent outcomes', () => {
    expect(
      VerificationObservationResponseSchema.safeParse({
        data: { status: 'recorded' },
        meta: { requestId: 'observation-test-request' },
      }).success,
    ).toBe(true);
    expect(
      VerificationObservationResponseSchema.safeParse({
        data: { status: 'idempotent' },
        meta: { requestId: 'observation-test-request' },
      }).success,
    ).toBe(true);
    expect(
      VerificationObservationResponseSchema.safeParse({
        data: { status: 'conflict' },
        meta: { requestId: 'observation-test-request' },
      }).success,
    ).toBe(false);
  });
});

describe('VerificationResourceQuerySchema', () => {
  it('accepts only the declared journal representation selector', () => {
    expect(VerificationResourceQuerySchema.safeParse({}).success).toBe(true);
    expect(VerificationResourceQuerySchema.parse({ include: 'journal' })).toEqual({ include: 'journal' });
    expect(VerificationResourceQuerySchema.safeParse({ include: 'other' }).success).toBe(false);
    expect(VerificationResourceQuerySchema.safeParse({ includeJournal: '1' }).success).toBe(false);
  });
});

describe('current finalization evidence params', () => {
  it('requires path-scoped bitmap selectors and keeps input commitment hash-only', () => {
    expect(
      CurrentFinalizationBitmapProofParamsSchema.parse({
        sessionId: 'session-123',
        kind: 'seen',
        voteIndex: '7',
      }),
    ).toEqual({
      sessionId: 'session-123',
      kind: 'seen',
      voteIndex: 7,
    });
    expect(CurrentFinalizationBitmapProofParamsSchema.safeParse({ sessionId: 'session-123' }).success).toBe(false);
    expect(
      CurrentFinalizationInputCommitmentParamsSchema.safeParse({
        sessionId: 'session-123',
      }).success,
    ).toBe(true);
    expect(
      CurrentFinalizationInputCommitmentParamsSchema.safeParse({
        sessionId: 'session-123',
        includeData: 'false',
      }).success,
    ).toBe(false);
  });
});

describe('numeric query schemas', () => {
  it('preserves lexical admission while returning numeric values', () => {
    expect(BulletinQuerySchema.parse({ offset: '0', limit: '1000' })).toEqual({ offset: 0, limit: 1000 });
    expect(ConsistencyProofQuerySchema.parse({ fromTreeSize: '0', toTreeSize: '12' })).toEqual({
      fromTreeSize: 0,
      toTreeSize: 12,
    });
    expect(SthQuerySchema.parse({ auditorId: 'auditor-b' })).toEqual({ auditorId: 'auditor-b' });
  });

  it.each([
    [BulletinQuerySchema, { offset: '01' }],
    [BulletinQuerySchema, { limit: '1001' }],
    [ConsistencyProofQuerySchema, { fromTreeSize: '-1', toTreeSize: '2' }],
    [ConsistencyProofQuerySchema, { oldSize: '1', newSize: '2' }],
    [SthQuerySchema, { auditor: 'auditor-b' }],
    [CurrentFinalizationBitmapProofParamsSchema, { sessionId: 'session-123', kind: 'included', voteIndex: '1.5' }],
    [CurrentFinalizationBitmapProofParamsSchema, { sessionId: 'session-123', kind: 'other', voteIndex: '1' }],
  ])('rejects ambiguous or out-of-contract query %#', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('ConsistencyProofResponseSchema', () => {
  it.each(['oldSubtreeHashes', 'appendSubtreeHashes'] as const)('rejects malformed hashes in %s', (field) => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(
      ConsistencyProofResponseSchema.safeParse({
        data: {
          fromTreeSize: 1,
          toTreeSize: 2,
          rootAtFromTreeSize: hash,
          rootAtToTreeSize: hash,
          proofNodes: [hash],
          [field]: ['not-a-32-byte-hash'],
          generatedAtMs: 1_730_000_000_000,
        },
        meta: { requestId: 'consistency-proof-schema-test' },
      }).success,
    ).toBe(false);
  });
});

describe('nullable response projections', () => {
  it('preserves omitted queue projections and represents known unavailable estimates with null', () => {
    const acceptedWithoutQueue = structuredClone(finalizeAcceptedFixture);
    const acceptedRuntimeDiagnostics = acceptedWithoutQueue.data.runtimeDiagnostics as unknown as {
      queue?: unknown;
    };
    delete acceptedRuntimeDiagnostics.queue;
    expect(FinalizationResponseSchema.safeParse(acceptedWithoutQueue).success).toBe(true);
    expect(
      FinalizationResponseSchema.safeParse({
        ...finalizeAcceptedFixture,
        data: {
          ...finalizeAcceptedFixture.data,
          runtimeDiagnostics: { ...finalizeAcceptedFixture.data.runtimeDiagnostics, queue: null },
        },
      }).success,
    ).toBe(true);

    const statusWithoutQueue = structuredClone(statusSucceededFixture);
    expect(CurrentFinalizationResponseSchema.safeParse(statusWithoutQueue).success).toBe(true);
    expect(
      CurrentFinalizationResponseSchema.safeParse({
        ...statusSucceededFixture,
        data: {
          ...statusSucceededFixture.data,
          runtimeDiagnostics: { ...statusSucceededFixture.data.runtimeDiagnostics, queue: null },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects retired generation diagnostics and raw verification reports', () => {
    const baseError = {
      error: { code: 'INVALID_REQUEST', message: 'Invalid request' },
      meta: { requestId: 'schema-test-request' },
    };
    expect(StandardErrorResponseSchema.safeParse(baseError).success).toBe(true);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...baseError,
        persistedContractGeneration: 'generation-1',
      }).success,
    ).toBe(false);
    expect(
      StandardErrorResponseSchema.safeParse({
        ...baseError,
        verificationReport: { status: 'failed', errors: ['private diagnostic'] },
      }).success,
    ).toBe(false);
  });
});

describe('schema ownership strictness', () => {
  it('accepts externally opaque validation field names but validates their values', () => {
    expect(
      StandardErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          details: {
            kind: 'validation',
            issues: { formErrors: [], fieldErrors: { 'nested.dynamic.path': ['Invalid input'] } },
          },
        },
        meta: { requestId: 'schema-test-request' },
      }).success,
    ).toBe(true);
    expect(
      StandardErrorResponseSchema.safeParse({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          details: {
            kind: 'validation',
            issues: { formErrors: [], fieldErrors: { 'nested.dynamic.path': 'Invalid input' } },
          },
        },
        meta: { requestId: 'schema-test-request' },
      }).success,
    ).toBe(false);
  });

  it('rejects nested finalization identity outside the single resource authority', () => {
    const status = structuredClone(statusSucceededFixture);
    (
      status.data.result.presentation as typeof status.data.result.presentation & {
        finalizationId?: string;
      }
    ).finalizationId = 'nested-finalization';
    expect(CurrentFinalizationResponseSchema.safeParse(status).success).toBe(false);
  });

  it('keeps tamperDetected in the presentation partition rather than the resource root', () => {
    const response = structuredClone(finalizeSyncFixture) as typeof finalizeSyncFixture & {
      data: typeof finalizeSyncFixture.data & { tamperDetected?: boolean };
    };
    response.data.tamperDetected = false;
    expect(FinalizationResponseSchema.safeParse(response).success).toBe(false);
    expect(FinalizationResponseSchema.safeParse(finalizeSyncFixture).success).toBe(true);
  });
});
