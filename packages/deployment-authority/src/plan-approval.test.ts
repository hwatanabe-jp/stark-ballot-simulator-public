import { describe, expect, it } from 'vitest';
import {
  parseSavedPlanChecksum,
  parseSavedPlanChecksumSidecar,
  validateSavedPlanApprovalPublication,
} from '@stark-ballot/deployment-authority/plan-approval';
import { resolveAllowedDeploymentTarget } from '@stark-ballot/deployment-authority';

const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const actionExecutionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sourceSha = 'a'.repeat(40);
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const accountId = target.accountId;
const mismatchedAccountId = `${accountId.startsWith('0') ? '1' : '0'}${accountId.slice(1)}`;
const reviewedPlanChecksum = 'b'.repeat(64);

const preflightPolicy = {
  actionName: 'ApproveVerifierPreflightApply',
  approvalSubject: 'Verifier-preflight',
  exactlyOneError: 'Exactly one successful verifier-preflight approval is required before apply.',
  stageName: 'VerifierPreflightApproval',
  summaryLabel: 'Verifier-preflight approval summary',
} as const;

function approvalInput(summaryExtensions: Readonly<Record<string, string>> = {}) {
  const summary = {
    sourceSha,
    accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum,
    ...summaryExtensions,
  };
  return {
    actionExecutions: {
      actionExecutionDetails: [
        {
          pipelineExecutionId,
          stageName: preflightPolicy.stageName,
          actionName: preflightPolicy.actionName,
          status: 'Succeeded',
          actionExecutionId,
          updatedBy: `arn:aws:sts::${accountId}:assumed-role/stark-dev-operator/user00`,
          lastUpdateTime: '2026-07-24T08:00:00+00:00',
          output: {
            executionResult: {
              externalExecutionSummary: JSON.stringify(summary),
            },
          },
        },
      ],
    },
    pipelineExecutionId,
    sourceSha,
    accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum,
    expectedSummaryExtensions: summaryExtensions,
    policy: preflightPolicy,
  };
}

describe('saved-plan checksums', () => {
  it('admits one lowercase SHA-256 digest', () => {
    expect(parseSavedPlanChecksum(reviewedPlanChecksum)).toBe(reviewedPlanChecksum);
  });

  it('reads the checksum token from the current Terraform sidecar format', () => {
    expect(parseSavedPlanChecksumSidecar(`${reviewedPlanChecksum}  tfplan\n`)).toBe(reviewedPlanChecksum);
  });

  it('rejects a sidecar without a canonical checksum token', () => {
    expect(() => parseSavedPlanChecksumSidecar('tfplan\n')).toThrow('Reviewed plan checksum is invalid.');
  });

  it.each(['B'.repeat(64), 'b'.repeat(63), `${'b'.repeat(64)} tfplan`])(
    'rejects a non-canonical checksum: %s',
    (value) => {
      expect(() => parseSavedPlanChecksum(value)).toThrow('Reviewed plan checksum is invalid.');
    },
  );
});

describe('saved-plan approval publication', () => {
  it('binds one successful CodePipeline approval to the exact saved plan', () => {
    expect(validateSavedPlanApprovalPublication(approvalInput())).toEqual({
      pipelineExecutionId,
      stageName: preflightPolicy.stageName,
      actionName: preflightPolicy.actionName,
      actionExecutionId,
      sourceSha,
      accountId,
      deploymentEnvironment: 'develop',
      reviewedPlanChecksum,
      approver: `arn:aws:sts::${accountId}:assumed-role/stark-dev-operator/user00`,
      approvalTimestamp: '2026-07-24T08:00:00.000Z',
    });
  });

  it('admits one exact caller-owned semantic extension', () => {
    const extension = { stateRefreshDisposition: 'reviewed-state-refresh' } as const;

    expect(validateSavedPlanApprovalPublication(approvalInput(extension))).toMatchObject({
      reviewedPlanChecksum,
      approvalTimestamp: '2026-07-24T08:00:00.000Z',
    });
  });

  it.each([
    'accountId',
    'actionExecutionId',
    'actionName',
    'approvalTimestamp',
    'approver',
    'deploymentEnvironment',
    'pipelineExecutionId',
    'reviewedPlanChecksum',
    'sourceSha',
    'stageName',
  ])('rejects an extension that collides with the %s output field', (field) => {
    expect(() => validateSavedPlanApprovalPublication(approvalInput({ [field]: 'collision' }))).toThrow(
      'Saved-plan approval summary extensions are invalid.',
    );
  });

  it('requires a strict grouped lowercase pipeline execution UUID', () => {
    const value = approvalInput();
    value.pipelineExecutionId = 'a'.repeat(36);

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow('Pipeline execution ID is invalid.');
  });

  it('requires a strict grouped lowercase action execution UUID', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.actionExecutionId = 'a'.repeat(36);

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'Verifier-preflight approval action execution ID is invalid.',
    );
  });

  it('preserves the caller-owned ambiguous-approval message', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    value.actionExecutions.actionExecutionDetails.push({ ...approval });

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(preflightPolicy.exactlyOneError);
  });

  it('preserves the exact invalid-JSON message', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.output.executionResult.externalExecutionSummary = '{invalid}';

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'Verifier-preflight approval summary must be valid JSON.',
    );
  });

  it.each([
    'schemaVersion', // operational-versioning-allow: rejection-fixture
    'contractVersion',
  ])('rejects the retired %s summary shape', (field) => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    const summary = JSON.parse(approval.output.executionResult.externalExecutionSummary) as Record<string, unknown>;
    summary[field] = 1;
    approval.output.executionResult.externalExecutionSummary = JSON.stringify(summary);

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'Verifier-preflight approval summary must use the exact current shape.',
    );
  });

  it('rejects a checksum that differs from the reviewed saved plan', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    const summary = JSON.parse(approval.output.executionResult.externalExecutionSummary) as Record<string, unknown>;
    summary['reviewedPlanChecksum'] = 'c'.repeat(64);
    approval.output.executionResult.externalExecutionSummary = JSON.stringify(summary);

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'Verifier-preflight approval summary reviewedPlanChecksum does not match the saved plan.',
    );
  });

  it('rejects an approver outside the selected AWS account', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.updatedBy = 'arn:aws:sts::999999999999:assumed-role/operator/session';

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow('Verifier-preflight approver is invalid.');
  });

  it('rejects an internally consistent approval for an unreviewed AWS account', () => {
    const value = approvalInput();
    value.accountId = mismatchedAccountId;
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    const summary = JSON.parse(approval.output.executionResult.externalExecutionSummary) as Record<string, unknown>;
    summary['accountId'] = mismatchedAccountId;
    approval.output.executionResult.externalExecutionSummary = JSON.stringify(summary);
    approval.updatedBy = `arn:aws:sts::${mismatchedAccountId}:assumed-role/stark-dev-operator/user00`;

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'AWS account does not match the reviewed target.',
    );
  });

  it('rejects a parseable timestamp without an explicit offset', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.lastUpdateTime = '2026-07-24 08:00:00';

    expect(() => validateSavedPlanApprovalPublication(value)).toThrow(
      'Verifier-preflight approval timestamp is invalid.',
    );
  });
});
