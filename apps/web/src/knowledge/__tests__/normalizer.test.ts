import { describe, expect, it } from 'vitest';
import { normalizeKnowledgeData } from '../normalizer';

describe('normalizeKnowledgeData', () => {
  it('should ignore null object fields without throwing', () => {
    const input = {
      proof: null,
      tally: null,
      verificationReport: null,
      voteReceipt: null,
    };

    expect(() => normalizeKnowledgeData(input)).not.toThrow();
    expect(normalizeKnowledgeData(input)).toEqual({});
  });

  describe('voteReceipt normalization', () => {
    it('should preserve voteReceipt as user.voteReceipt object', () => {
      const input = {
        voteReceipt: {
          voteId: 'test-uuid',
          commitment: '0xabc123',
          bulletinIndex: 5,
          bulletinRootAtCast: '0xdef456',
          castAtMs: 1730000000000,
          inputCommitment: '0x789',
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.voteReceipt']).toEqual({
        voteId: 'test-uuid',
        commitment: '0xabc123',
        bulletinIndex: 5,
        bulletinRootAtCast: '0xdef456',
        timestamp: 1730000000000,
        inputCommitment: '0x789',
      });
      // Should NOT extract individual fields from voteReceipt
      expect(result['user.voteId']).toBeUndefined();
      expect(result['user.commitment']).toBeUndefined();
    });

    it('should handle voteReceipt without inputCommitment', () => {
      const input = {
        voteReceipt: {
          voteId: 'test-uuid',
          commitment: '0xabc123',
          bulletinIndex: 0,
          bulletinRootAtCast: '0xdef456',
          castAtMs: 1730000000000,
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.voteReceipt']).toEqual({
        voteId: 'test-uuid',
        commitment: '0xabc123',
        bulletinIndex: 0,
        bulletinRootAtCast: '0xdef456',
        timestamp: 1730000000000,
      });
    });

    it('should ignore voteReceipt missing canonical fields', () => {
      const input = {
        voteReceipt: {
          voteId: 'test-uuid',
          commitment: '0xabc123',
          bulletinIndex: 5,
          castAtMs: 1730000000000,
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.voteReceipt']).toBeUndefined();
    });
  });

  describe('field name normalization', () => {
    it('should ignore unknown fields', () => {
      const input = { unexpectedField: '0xabc123' };
      const result = normalizeKnowledgeData(input);
      expect(result).toEqual({});
    });

    it('should ignore legacy bot-scoped flat keys', () => {
      const input = { 'bot.vote': 'A', 'bot.rand': '0xabc123' };
      const result = normalizeKnowledgeData(input);
      expect(result).toEqual({});
    });
  });

  describe('nested userVote normalization', () => {
    it('should flatten userVote fields', () => {
      const input = {
        userVote: {
          vote: 'A',
          commitment: '0xabc',
          random: '0x123',
          voteId: 'test-id',
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.choice']).toBe('A');
      expect(result['user.commitment']).toBe('0xabc');
      expect(result['user.random']).toBe('0x123');
      expect(result['user.voteId']).toBe('test-id');
    });

    it('should normalize userVote.proof to user.merklePath without requiring proofMode', () => {
      const input = {
        userVote: {
          vote: 'B',
          commitment: '0xabc',
          random: '0x123',
          voteId: 'test-id',
          proof: {
            leafIndex: 5,
            treeSize: 64,
            merklePath: ['0x111', '0x222'],
            bulletinRootAtCast: '0xroot',
          },
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.merklePath']).toEqual({
        leafIndex: 5,
        treeSize: 64,
        merklePath: ['0x111', '0x222'],
        bulletinRootAtCast: '0xroot',
      });
    });

    it('should drop userVote.proof when proofMode is present', () => {
      const input = {
        userVote: {
          vote: 'B',
          commitment: '0xabc',
          random: '0x123',
          voteId: 'test-id',
          proof: {
            leafIndex: 5,
            treeSize: 64,
            merklePath: ['0x111', '0x222'],
            bulletinRootAtCast: '0xroot',
            proofMode: 'rfc6962',
          },
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['user.merklePath']).toBeUndefined();
    });
  });

  describe('tally normalization', () => {
    it('should extract tally.counts and tally.totalVotes', () => {
      const input = {
        tally: {
          counts: { A: 10, B: 20, C: 5, D: 15, E: 14 },
          totalVotes: 64,
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['tally.counts']).toEqual({ A: 10, B: 20, C: 5, D: 15, E: 14 });
      expect(result['tally.totalVotes']).toBe(64);
    });

    it('should extract tally.tamperedCount if present', () => {
      const input = {
        tally: {
          counts: { A: 10, B: 20 },
          totalVotes: 30,
          tamperedCount: 5,
        },
      };

      const result = normalizeKnowledgeData(input);

      expect(result['tally.tamperedCount']).toBe(5);
    });
  });

  describe('verificationSteps normalization', () => {
    it('should normalize verificationSteps array', () => {
      const steps = [
        { id: 'cast_as_intended', status: 'success' },
        { id: 'recorded_as_cast', status: 'pending' },
      ];
      const input = { verificationSteps: steps };

      const result = normalizeKnowledgeData(input);

      expect(result['verification.steps']).toEqual(steps);
    });
  });

  describe('verificationReport normalization', () => {
    it('projects only the current knowledge summary from a full verifier report', () => {
      const report = {
        status: 'success',
        verifier_version: 'test-verifier',
        verified_at: '2026-08-02T00:00:00.000Z',
        duration_ms: 5000,
        expected_image_id: `0x${'1'.repeat(64)}`,
        receipt_image_id: `0x${'1'.repeat(64)}`,
        dev_mode_receipt: false,
        errors: ['diagnostic'],
      };
      const input = { verificationReport: report };

      const result = normalizeKnowledgeData(input);

      expect(result['verification.reportSummary']).toEqual({
        status: 'success',
        duration_ms: 5000,
        errors: ['diagnostic'],
      });
    });
  });

  describe('completeness metrics normalization', () => {
    it('should include completeness metrics when provided', () => {
      const input = {
        missingSlots: 0,
        invalidPresentedSlots: 2,
        rejectedRecords: 3,
        validVotes: 62,
        totalExpected: 64,
      };

      const result = normalizeKnowledgeData(input);

      expect(result.missingSlots).toBe(0);
      expect(result.invalidPresentedSlots).toBe(2);
      expect(result['rejectedRecords']).toBe(3);
      expect(result.validVotes).toBe(62);
      expect(result['totalExpected']).toBe(64);
    });
  });
});
