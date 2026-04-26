import { describe, expect, it } from 'vitest';
import { sanitizeFinalizationPayloadVerificationStatus } from '@/lib/verification/fail-closed-status';
import { createTestJournal } from '@/lib/testing/test-helpers';

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
