import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';

import { admitAppAcceptanceApprovalEvidence } from './app-acceptance-approval.js';
import { resolveAllowedDeploymentTarget } from './index.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const detachedAccountId = target.accountId === '000000000000' ? '111111111111' : '000000000000';
const pipelineExecutionId = '11111111-2222-4333-8444-555555555555';
const selectedSourceSha = 'a'.repeat(40);

function manualFixture(mode: 'normal' | 'rollback') {
  const controlSourceSha = mode === 'normal' ? selectedSourceSha : 'b'.repeat(40);
  return {
    accountId: target.accountId,
    actionName: 'ApproveTargetRuntimeApply',
    approvalMode: 'manual-approval',
    approvalTimestamp: '2026-08-14T01:03:04.000Z',
    approver: `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/fixture`,
    controlSourceSha,
    deploymentEnvironment: target.environmentId,
    deploymentMode: mode,
    evidenceType: 'app-approval',
    manualApprovalSkipped: false,
    pipelineExecutionId,
    reviewedPlanChecksum: 'c'.repeat(64),
    selectedSourceSha,
    sourceSha: selectedSourceSha,
    stageName: 'ManualApproval',
  };
}

function emptyFixture() {
  return {
    accountId: target.accountId,
    approvalMode: 'empty-plan-skip',
    approvalTimestamp: null,
    approver: null,
    controlSourceSha: selectedSourceSha,
    deploymentEnvironment: target.environmentId,
    deploymentMode: 'normal',
    evidenceType: 'app-approval',
    manualApprovalSkipped: true,
    pipelineExecutionId,
    planEmptyEvidence: {
      evidenceType: 'app-plan-empty',
      importingResourceChangeCount: 0,
      movedResourceChangeCount: 0,
      outputChangeCount: 0,
      planEmpty: true,
      resourceChangeCount: 0,
    },
    reviewedPlanChecksum: 'c'.repeat(64),
    selectedSourceSha,
    sourceSha: selectedSourceSha,
  };
}

describe('App acceptance approval evidence admission', () => {
  it('admits and deeply freezes unchanged normal, rollback, and empty-skip evidence', () => {
    for (const evidence of [manualFixture('normal'), manualFixture('rollback'), emptyFixture()]) {
      const admitted = admitAppAcceptanceApprovalEvidence(evidence, target.targetKey);
      expect(admitted).toEqual(evidence);
      expect(Object.isFrozen(admitted)).toBe(true);
    }
    expect(
      Object.isFrozen(admitAppAcceptanceApprovalEvidence(emptyFixture(), target.targetKey)['planEmptyEvidence']),
    ).toBe(true);
  });

  it('rejects detached target, source, plan, and canonical manual authority', () => {
    expect(() =>
      admitAppAcceptanceApprovalEvidence(
        { ...manualFixture('normal'), accountId: detachedAccountId },
        target.targetKey,
      ),
    ).toThrow(/target.*invalid/iu);
    expect(() =>
      admitAppAcceptanceApprovalEvidence({ ...manualFixture('normal'), sourceSha: 'b'.repeat(40) }, target.targetKey),
    ).toThrow(/source authority.*invalid/iu);
    expect(() =>
      admitAppAcceptanceApprovalEvidence(
        { ...manualFixture('normal'), reviewedPlanChecksum: 'not-a-hash' },
        target.targetKey,
      ),
    ).toThrow(/plan checksum.*invalid|SHA-256/iu);
    expect(() =>
      admitAppAcceptanceApprovalEvidence(
        {
          ...manualFixture('normal'),
          approvalTimestamp: '2026-08-14T01:03:04Z',
        },
        target.targetKey,
      ),
    ).toThrow(/manual approval authority.*invalid/iu);
    expect(() =>
      admitAppAcceptanceApprovalEvidence(
        {
          ...manualFixture('normal'),
          approver: `arn:aws:iam::${detachedAccountId}:user/x`,
        },
        target.targetKey,
      ),
    ).toThrow(/manual approver.*invalid|manual approval authority.*invalid/iu);
  });

  it('captures proxied evidence without invoking getters and rejects extra fields', () => {
    const evidence = manualFixture('normal');
    let reads = 0;
    const proxy = new Proxy(evidence, {
      get(targetValue, property, receiver) {
        reads += 1;
        return Reflect.get(targetValue, property, receiver) as unknown;
      },
    });

    expect(admitAppAcceptanceApprovalEvidence(proxy, target.targetKey)).toEqual(evidence);
    expect(reads).toBe(0);
    expect(() => admitAppAcceptanceApprovalEvidence({ ...evidence, current: true }, target.targetKey)).toThrow(
      /exact.*shape/iu,
    );
  });
});

it('requires a production account approval for normal, rollback, and no-op acceptance', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const authority = await import('./app-acceptance-approval.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    for (const mode of ['normal', 'rollback'] as const) {
      const evidence = {
        ...manualFixture(mode),
        accountId: production.accountId,
        deploymentEnvironment: production.environmentId,
        approver: `arn:${production.partition}:sts::${production.accountId}:assumed-role/operator/fixture`,
      };
      expect(authority.admitAppAcceptanceApprovalEvidence(evidence, production.targetKey)).toEqual(evidence);
      for (const wrongTarget of [undefined, 'unreviewed/main', target.targetKey]) {
        expect(() => authority.admitAppAcceptanceApprovalEvidence(evidence, wrongTarget)).toThrow();
      }
      for (const field of ['accountId', 'deploymentEnvironment', 'approver'] as const) {
        expect(() =>
          authority.admitAppAcceptanceApprovalEvidence(
            { ...evidence, [field]: manualFixture(mode)[field] },
            production.targetKey,
          ),
        ).toThrow();
      }
    }
    expect(() =>
      authority.admitAppAcceptanceApprovalEvidence(
        { ...emptyFixture(), accountId: production.accountId, deploymentEnvironment: production.environmentId },
        production.targetKey,
      ),
    ).toThrow(/empty-plan/iu);
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
