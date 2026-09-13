import { describe, expect, it } from 'vitest';
import { resolveAllowedDeploymentTarget } from '@stark-ballot/deployment-authority';
import { admitAppAcceptanceApprovalEvidence } from './app-acceptance-approval.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const controlSourceSha = 'a'.repeat(40);
const selectedSourceSha = 'b'.repeat(40);
const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const reviewedPlanChecksum = 'c'.repeat(64);
const approverArn = `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`;

function manualApproval() {
  return {
    evidenceType: 'app-approval',
    approvalMode: 'manual-approval',
    pipelineExecutionId,
    stageName: 'ManualApproval',
    actionName: 'ApproveTargetRuntimeApply',
    deploymentMode: 'rollback',
    controlSourceSha,
    selectedSourceSha,
    sourceSha: selectedSourceSha,
    accountId: target.accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum,
    manualApprovalSkipped: false,
    approver: approverArn,
    approvalTimestamp: '2026-08-01T03:04:05.000Z',
  } as const;
}

function emptyPlanApproval() {
  return {
    evidenceType: 'app-approval',
    approvalMode: 'empty-plan-skip',
    pipelineExecutionId,
    deploymentMode: 'normal',
    controlSourceSha,
    selectedSourceSha: controlSourceSha,
    sourceSha: controlSourceSha,
    accountId: target.accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum,
    manualApprovalSkipped: true,
    approver: null,
    approvalTimestamp: null,
    planEmptyEvidence: {
      evidenceType: 'app-plan-empty',
      planEmpty: true,
      resourceChangeCount: 0,
      outputChangeCount: 0,
      movedResourceChangeCount: 0,
      importingResourceChangeCount: 0,
    },
  } as const;
}

describe('App approval evidence', () => {
  it('admits exact manual approval authority', () => {
    expect(admitAppAcceptanceApprovalEvidence(manualApproval(), target.targetKey)).toEqual(manualApproval());
  });

  it('admits an exact normal empty-plan skip without an approver', () => {
    expect(admitAppAcceptanceApprovalEvidence(emptyPlanApproval(), target.targetKey)).toEqual(emptyPlanApproval());
  });

  it('rejects unknown durable fields', () => {
    expect(() =>
      admitAppAcceptanceApprovalEvidence(
        {
          ...manualApproval(),
          decryptedSecret: 'sentinel-secret-value',
        },
        target.targetKey,
      ),
    ).toThrow('App acceptance approval evidence must use the exact enumerable data shape.');
  });

  it('rejects a skipped approval with nonempty Terraform changes', () => {
    const value = structuredClone(emptyPlanApproval()) as unknown as {
      planEmptyEvidence: { resourceChangeCount: number };
    };
    value.planEmptyEvidence.resourceChangeCount = 1;

    expect(() => admitAppAcceptanceApprovalEvidence(value, target.targetKey)).toThrow(
      'App acceptance empty-plan approval evidence must contain zero Terraform changes.',
    );
  });
});
