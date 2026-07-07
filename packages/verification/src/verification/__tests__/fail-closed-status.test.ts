import { describe, expect, it } from 'vitest';
import {
  sanitizeFinalizationPayloadVerificationStatus,
  sanitizeFinalizationResultVerificationStatus,
} from '@stark-ballot/verification/fail-closed-status';
import { createTestJournal } from './test-helpers';

type FinalizationResultStatusInput = NonNullable<Parameters<typeof sanitizeFinalizationResultVerificationStatus>[0]>;

describe('sanitizeFinalizationPayloadVerificationStatus', () => {
  function buildSuccessPayload() {
    return {
      verificationStatus: 'success' as const,
      imageId: '0x' + '1'.repeat(64),
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      journal: {
        ...createTestJournal({}),
        verifiedTally: [1, 0, 0, 0, 0] as number[],
        imageId: '0x' + '1'.repeat(64),
      },
      verificationReport: undefined as { expected_image_id: string; receipt_image_id: string | null } | undefined,
      verificationResult: {
        status: 'success' as const,
        report: {
          expected_image_id: '0x' + '1'.repeat(64),
          receipt_image_id: ('0x' + '1'.repeat(64)) as string | null,
        },
      },
    };
  }

  it('fails closed when canonical journal shows excluded votes', () => {
    const payload = buildSuccessPayload();
    payload.journal = {
      ...payload.journal,
      missingSlots: 1,
      invalidPresentedSlots: 0,
      excludedSlots: 1,
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('failed');
    expect(sanitized.verificationResult.status).toBe('failed');
  });

  it.each([
    ['excludedCount', { excludedCount: 1 }],
    ['missingIndices', { missingIndices: 1 }],
    ['invalidIndices', { invalidIndices: 1 }],
  ])('ignores stale top-level legacy %s when the canonical journal is clean', (_label, legacyAlias) => {
    const payload = {
      ...buildSuccessPayload(),
      ...legacyAlias,
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('success');
    expect(sanitized.verificationResult.status).toBe('success');
  });

  it.each([
    ['excludedCount', { excludedCount: 0 }],
    ['missingIndices', { missingIndices: 0 }],
    ['invalidIndices', { invalidIndices: 0 }],
    ['countedIndices', { countedIndices: 1 }],
  ])('fails closed when stale legacy %s is present inside a journal-like payload', (_label, legacyAlias) => {
    const payload = buildSuccessPayload();
    payload.journal = {
      ...payload.journal,
      ...legacyAlias,
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('failed');
    expect(sanitized.verificationResult.status).toBe('failed');
  });

  it('fails closed when canonical journal tree size contradicts total expected', () => {
    const payload = buildSuccessPayload();
    payload.journal = {
      ...payload.journal,
      treeSize: 2,
      totalExpected: 1,
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('failed');
    expect(sanitized.verificationResult.status).toBe('failed');
  });

  it('keeps STARK verification status when only the claimed tally disagrees with the canonical verified tally', () => {
    const payload = buildSuccessPayload();
    payload.tally = {
      counts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 1,
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('success');
    expect(sanitized.verificationResult.status).toBe('success');
  });

  it('fails closed when nested verificationResult.report has a null receipt image id', () => {
    const payload = buildSuccessPayload();
    payload.verificationReport = {
      expected_image_id: '0x' + '1'.repeat(64),
      receipt_image_id: '0x' + '1'.repeat(64),
    };
    payload.verificationResult = {
      ...payload.verificationResult,
      report: {
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: null,
      },
    };

    const sanitized = sanitizeFinalizationPayloadVerificationStatus(payload);

    expect(sanitized.verificationStatus).toBe('failed');
    expect(sanitized.verificationResult.status).toBe('failed');
  });
});

describe('sanitizeFinalizationResultVerificationStatus', () => {
  function buildSuccessResult(): FinalizationResultStatusInput {
    return {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: '0x' + '1'.repeat(64),
      journal: {
        ...createTestJournal({}),
        verifiedTally: [1, 0, 0, 0, 0] as number[],
        imageId: '0x' + '1'.repeat(64),
      },
      verificationResult: {
        status: 'success' as const,
        report: {
          status: 'success' as const,
          verifier_version: 'test',
          verified_at: '2026-06-17T00:00:00.000Z',
          duration_ms: 1,
          expected_image_id: '0x' + '1'.repeat(64),
          receipt_image_id: '0x' + '1'.repeat(64),
          dev_mode_receipt: false,
        },
      },
    };
  }

  it.each([
    ['excludedCount', { excludedCount: 1 }],
    ['missingIndices', { missingIndices: 1 }],
    ['invalidIndices', { invalidIndices: 1 }],
  ])('ignores stale top-level legacy %s when the canonical journal is clean', (_label, legacyAlias) => {
    const result = {
      ...buildSuccessResult(),
      ...legacyAlias,
    };

    const sanitized = sanitizeFinalizationResultVerificationStatus(result);

    expect(sanitized.verificationResult?.status).toBe('success');
  });

  it.each([
    ['excludedCount', { excludedCount: 0 }],
    ['missingIndices', { missingIndices: 0 }],
    ['invalidIndices', { invalidIndices: 0 }],
    ['countedIndices', { countedIndices: 1 }],
  ])('fails closed when stale legacy %s is present inside result journal data', (_label, legacyAlias) => {
    const result = buildSuccessResult();
    result.journal = {
      ...result.journal,
      ...legacyAlias,
    };

    const sanitized = sanitizeFinalizationResultVerificationStatus(result);

    expect(sanitized.verificationResult?.status).toBe('failed');
  });
});
