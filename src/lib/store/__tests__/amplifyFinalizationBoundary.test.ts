import { describe, expect, it } from 'vitest';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import type { FinalizationStoragePayload } from '@/types/server';
import {
  parseStoredFinalizationEnvelope,
  parseStoredFinalizationPayload,
  serializeStoredFinalizationPayload,
} from '@/lib/store/amplify/finalization';

describe('Amplify finalization boundary helpers', () => {
  it('fails closed when stored payload carries compatibility mirrors', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const parsed = parseStoredFinalizationPayload(
      JSON.stringify({
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationResult: {
          tally: {
            counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          bulletinRoot: journal.bulletinRoot,
          imageId: '0x' + '1'.repeat(64),
          missingIndices: journal.missingSlots,
          excludedCount: journal.excludedSlots,
          journal,
        },
        finalizationState: null,
      }),
    );

    expect(parsed).toBeUndefined();
  });

  it('still reads the wrapper generation from stale compatibility payloads', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const rawPayload = JSON.stringify({
      contractGeneration: '2026-04-zkvm-current-v2',
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal,
        publicInputSummary: {
          schema: 'stark-ballot.public_input',
          version: '1.1',
          valid: true,
          electionId: journal.electionId,
          electionConfigHash: journal.electionConfigHash,
          votesCount: 64,
          treeSize: journal.treeSize,
          totalExpected: journal.totalExpected,
          bulletinRoot: journal.bulletinRoot,
          logId: '0x' + '2'.repeat(64),
          timestamp: 1730000000000,
          methodVersion: journal.methodVersion,
          uniqueIndices: true,
          uniqueCommitments: true,
          recomputedInputCommitment: journal.inputCommitment,
        },
      },
      finalizationState: null,
    });

    expect(parseStoredFinalizationPayload(rawPayload)).toBeUndefined();
    expect(parseStoredFinalizationEnvelope(rawPayload)).toEqual({
      contractGeneration: '2026-04-zkvm-current-v2',
      hasFinalizationResult: true,
      hasFinalizationState: true,
      hasFinalizationScenarioContext: false,
    });
  });

  it('rejects wrapped payloads without contractGeneration', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const parsed = parseStoredFinalizationPayload(
      JSON.stringify({
        finalizationResult: {
          tally: {
            counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          journal,
        },
        finalizationState: null,
      }),
    );

    expect(parsed).toBeUndefined();
  });

  it('re-serializes only the authority shape for persisted payloads', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const serialized = serializeStoredFinalizationPayload({
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal,
      },
      finalizationState: {
        status: 'running',
        executionId: 'exec-1',
        queuedAt: 1730000000000,
        startedAt: 1730000005000,
      },
    } satisfies FinalizationStoragePayload);

    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized ?? '{}') as {
      contractGeneration?: string;
      finalizationResult?: Record<string, unknown> | null;
    };
    expect(parsed.finalizationResult).toMatchObject({
      tally: {
        counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
        totalVotes: 64,
        tamperedCount: 0,
      },
      imageId: '0x' + '1'.repeat(64),
      journal,
    });
    expect(parsed.contractGeneration).toBe(resolveCurrentContractGeneration());
    expect(parsed.finalizationResult).not.toHaveProperty('bulletinRoot');
    expect(parsed.finalizationResult).not.toHaveProperty('missingIndices');
    expect(parsed.finalizationResult).not.toHaveProperty('excludedCount');
  });
});
