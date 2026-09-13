import { describe, expect, it } from 'vitest';
import { getVerificationStepInputs, VERIFICATION_CHECK_DEFINITIONS } from '@stark-ballot/verification/checks';
import { buildCliVerificationPresentationFixture } from './cli-verification-fixtures';

describe('buildCliVerificationPresentationFixture', () => {
  it('keeps required IDs and statuses explicit while deriving canonical metadata', () => {
    const fixture = buildCliVerificationPresentationFixture({
      steps: [
        { id: 'counted_as_recorded', status: 'failed' },
        { id: 'stark_verification', status: 'not_run' },
      ],
      checks: [
        { id: 'counted_expected_vs_tree_size', status: 'failed' },
        { id: 'counted_election_manifest_consistent', status: 'not_run' },
        { id: 'counted_close_statement_consistent', status: 'pending' },
        { id: 'stark_receipt_verify', status: 'running' },
      ],
    });

    expect(fixture.verificationSteps).toEqual([
      {
        id: 'counted_as_recorded',
        status: 'failed',
        inputs: getVerificationStepInputs('counted_as_recorded'),
      },
      {
        id: 'stark_verification',
        status: 'not_run',
        inputs: getVerificationStepInputs('stark_verification'),
      },
    ]);
    expect(fixture.verificationChecks).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(fixture.verificationChecks).toEqual(
      expect.arrayContaining([
        {
          id: 'counted_expected_vs_tree_size',
          status: 'failed',
          evidence: 'zk',
          inputs: ['totalExpected', 'treeSize'],
        },
        {
          id: 'counted_election_manifest_consistent',
          status: 'not_run',
          evidence: 'public',
          inputs: ['electionManifest', 'electionId', 'electionConfigHash', 'proofBundleStatus'],
        },
        {
          id: 'counted_close_statement_consistent',
          status: 'pending',
          evidence: 'public',
          inputs: ['closeStatement', 'logId', 'timestamp', 'sthDigest', 'bulletinRoot', 'treeSize'],
        },
        {
          id: 'stark_receipt_verify',
          status: 'running',
          evidence: 'zk',
          inputs: ['proofBundleStatus'],
        },
      ]),
    );
    expect(fixture.presentationPolicy.stageStatuses).toMatchObject({
      counted_as_recorded: 'failed',
      stark_verification: 'running',
    });
  });
});
