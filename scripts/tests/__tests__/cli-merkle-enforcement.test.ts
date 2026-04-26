import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLITestHelpers } from '../../../src/lib/testing/cli-test-helpers';
import { createTestJournal } from '../../../src/lib/testing/test-helpers';
import type { CLITestConfig } from '../cli-e2e-voting-flow';

vi.mock('../../../src/lib/verification/tamperDetection', () => ({
  detectTampering: vi.fn().mockResolvedValue({
    isTampered: false,
    detectedScenarios: [],
    details: {},
  }),
}));

import { CLIVotingTest } from '../cli-e2e-voting-flow';

describe('CLIVotingTest - Merkle enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails the test case when merkle verification does not pass', async () => {
    const verifyMerkleMock = vi.fn().mockReturnValue(false);

    const helpers: CLITestHelpers = {
      createSession: vi.fn().mockResolvedValue('session-123'),
      submitVote: vi.fn().mockResolvedValue({
        leafIndex: 0,
        merklePath: ['0xabc'],
        commitment: '0xcommit',
        choice: 'A',
        random: '0xrand',
      }),
      generateBotVotes: vi.fn().mockResolvedValue(undefined),
      finalizeWithScenarios: vi.fn().mockResolvedValue({
        data: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            merkleRoot: '0xroot',
            totalVotes: 64,
            tamperedCount: 0,
          },
          proof: {
            receipt: { mock: true },
            tamperDetected: false,
          },
          debug: {
            verifiedTally: [64, 0, 0, 0, 0],
            missingSlots: 0,
            invalidPresentedSlots: 0,
            validVotes: 64,
          },
          verificationStatus: 'success',
          verificationSteps: [
            {
              id: 'counted_as_recorded',
              status: 'success',
              inputs: [],
            },
            {
              id: 'stark_verification',
              status: 'success',
              inputs: [],
            },
          ],
          verificationChecks: [
            {
              id: 'counted_expected_vs_tree_size',
              status: 'success',
              evidence: 'public',
              inputs: ['totalExpected', 'treeSize'],
            },
            {
              id: 'counted_election_manifest_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['electionManifest'],
            },
            {
              id: 'counted_close_statement_consistent',
              status: 'success',
              evidence: 'public',
              inputs: ['closeStatement'],
            },
            {
              id: 'stark_receipt_verify',
              status: 'success',
              evidence: 'zk',
              inputs: ['proofBundleStatus'],
            },
          ],
          journal: createTestJournal({ totalExpected: 64, validVotes: 64 }),
          userVote: {
            commitment: '0xcommit',
            merklePath: ['0xabc'],
            leafIndex: 0,
          },
          userMerklePath: ['0xabc'],
          treeSize: 64,
          totalExpected: 64,
        },
      }),
      verifySTARK: vi.fn().mockResolvedValue(true),
      describeReceipt: vi.fn().mockReturnValue({ kind: 'mock' }),
      verifyMerkle: verifyMerkleMock,
      generateReport: vi.fn(),
      executeZkVM: vi.fn(),
    } as unknown as CLITestHelpers;

    const config: CLITestConfig = {
      scenarios: [],
      scenario: undefined,
      allScenarios: false,
      useRealZkVM: false,
      realMode: 'dev',
      verbose: false,
      outputFormat: 'table',
      userChoice: 'A',
      skipBuild: false,
    };

    const cliTest = new CLIVotingTest(config, helpers);

    const testCase = {
      name: 'S0: Normal case (no tampering)',
      scenario: [] as string[],
      expectedTamper: false,
    };

    const result = await cliTest.runTestCase(testCase);

    expect(verifyMerkleMock).toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.details.errors).toBeDefined();
    expect(result.details.errors).toEqual(expect.arrayContaining([expect.stringMatching(/Merkle inclusion/i)]));
  });
});
