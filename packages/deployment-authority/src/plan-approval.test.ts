import { describe, expect, it, vi } from 'vitest';
import {
  admitSavedPlanApprovalActionProjection,
  admitFoundationAcceptanceApprovalBinding,
  allowsAppEmptyPlanSkip,
  admitFoundationBoundApprovalSummary,
  renderFoundationBoundApprovalSummary,
  parseSavedPlanChecksum,
  parseSavedPlanChecksumSidecar,
  validateFoundationBoundSavedPlanApprovalPublication,
  validateSavedPlanApprovalPublication,
} from '@stark-ballot/deployment-authority/plan-approval';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from '@stark-ballot/deployment-authority';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from './foundation-contract.js';

const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const actionExecutionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sourceSha = 'a'.repeat(40);
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const accountId = target.accountId;
const mismatchedAccountId = `${accountId.startsWith('0') ? '1' : '0'}${accountId.slice(1)}`;
const reviewedPlanChecksum = 'b'.repeat(64);
const foundationAuthority = resolveDeploymentLaneAuthority(target, 'foundation');
const foundationAcceptanceDigest = 'c'.repeat(64);
const foundationAcceptance = {
  foundationAcceptanceKey:
    `${foundationAuthority.names.terraformBaselinePrefix}/${foundationAuthority.stateIdentity}/acceptances/` +
    `${foundationAcceptanceDigest}.json`,
  foundationAcceptedSourceSha: 'd'.repeat(64),
  closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
  foundationContractHash: 'f'.repeat(64),
} as const;

function foundationBoundInput() {
  return {
    sourceSha: 'a'.repeat(64),
    accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum,
    foundationAcceptance,
    summaryType: 'verifier-preflight',
  } as const;
}

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

function actionProjection() {
  return {
    actionExecutionDetails: [
      {
        actionExecutionId,
        actionName: preflightPolicy.actionName,
        lastUpdateTime: '2026-07-24T08:00:00.000Z',
        output: {
          executionResult: {
            externalExecutionId: actionExecutionId,
            externalExecutionSummary: '{}',
          },
        },
        pipelineExecutionId,
        stageName: preflightPolicy.stageName,
        status: 'Succeeded',
        updatedBy: `arn:aws:sts::${accountId}:assumed-role/stark-dev-operator/user00`,
      },
    ],
  };
}

describe('saved-plan approval action projection', () => {
  it('admits only the exact succeeded action shape projected after agreement', () => {
    const projection = actionProjection();

    expect(admitSavedPlanApprovalActionProjection(projection, target.targetKey)).toEqual(projection);

    const [detail] = projection.actionExecutionDetails;
    if (detail === undefined) throw new Error('Projection fixture is missing.');
    for (const candidate of [
      { ...projection, unexpected: true },
      { actionExecutionDetails: [{ ...detail, unexpected: true }] },
      { actionExecutionDetails: [{ ...detail, output: { ...detail.output, unexpected: true } }] },
      {
        actionExecutionDetails: [
          {
            ...detail,
            output: {
              executionResult: { ...detail.output.executionResult, unexpected: true },
            },
          },
        ],
      },
    ]) {
      expect(() => admitSavedPlanApprovalActionProjection(candidate, target.targetKey)).toThrow(/exact current shape/u);
    }
  });

  it('rejects a duplicate, non-succeeded, or action-detached projection', () => {
    const projection = actionProjection();
    const [detail] = projection.actionExecutionDetails;
    if (detail === undefined) throw new Error('Projection fixture is missing.');

    for (const candidate of [
      { actionExecutionDetails: [detail, structuredClone(detail)] },
      { actionExecutionDetails: [{ ...detail, status: 'Failed' }] },
      {
        actionExecutionDetails: [
          {
            ...detail,
            output: {
              executionResult: {
                ...detail.output.executionResult,
                externalExecutionId: pipelineExecutionId,
              },
            },
          },
        ],
      },
    ]) {
      expect(() => admitSavedPlanApprovalActionProjection(candidate, target.targetKey)).toThrow();
    }
  });
});

function foundationBoundPublicationInput() {
  const value = approvalInput();
  const [approval] = value.actionExecutions.actionExecutionDetails;
  if (approval === undefined) {
    throw new Error('Approval fixture is missing.');
  }
  delete (value as { expectedSummaryExtensions?: unknown }).expectedSummaryExtensions;
  approval.output.executionResult.externalExecutionSummary = JSON.stringify(
    renderFoundationBoundApprovalSummary(
      {
        sourceSha,
        accountId,
        deploymentEnvironment: 'develop',
        reviewedPlanChecksum,
        foundationAcceptance,
        summaryType: 'verifier-preflight',
      },
      target.targetKey,
    ),
  );
  return {
    ...value,
    foundationAcceptance,
    summaryType: 'verifier-preflight' as const,
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

describe('Foundation-bound saved-plan approval summary', () => {
  it('round-trips the raw reviewed authority through one canonical unpadded base64url projection', () => {
    const input = foundationBoundInput();
    const summary = renderFoundationBoundApprovalSummary(input, target.targetKey);

    expect(summary).toEqual({
      sourceShaB64u: Buffer.from(input.sourceSha, 'hex').toString('base64url'),
      accountId,
      deploymentEnvironment: 'develop',
      reviewedPlanChecksumB64u: Buffer.from(reviewedPlanChecksum, 'hex').toString('base64url'),
      foundationAcceptanceDigestB64u: Buffer.from(foundationAcceptanceDigest, 'hex').toString('base64url'),
      foundationAcceptedSourceShaB64u: Buffer.from(foundationAcceptance.foundationAcceptedSourceSha, 'hex').toString(
        'base64url',
      ),
      closureIdentityB64u: Buffer.from(foundationAcceptance.closureIdentity, 'hex').toString('base64url'),
      foundationContractHashB64u: Buffer.from(foundationAcceptance.foundationContractHash, 'hex').toString('base64url'),
    });
    expect(admitFoundationBoundApprovalSummary(summary, input, target.targetKey)).toEqual({
      sourceSha: input.sourceSha,
      accountId,
      deploymentEnvironment: 'develop',
      reviewedPlanChecksum,
      foundationAcceptance,
    });
  });

  it('stays within the 512-byte CodePipeline approval-summary limit at every admitted SHA width', () => {
    const preflight = renderFoundationBoundApprovalSummary(foundationBoundInput(), target.targetKey);

    expect(Buffer.byteLength(JSON.stringify(preflight), 'utf8')).toBe(499);
  });

  it.each([
    ['padding', (value: string) => `${value}=`],
    ['alternate spelling', (value: string) => `${value.slice(0, -1)}p`],
    ['wrong width', () => Buffer.from('a'.repeat(38), 'hex').toString('base64url')],
  ])('rejects a %s instead of canonical source-SHA bytes', (_label, mutate) => {
    const input = foundationBoundInput();
    const summary = {
      ...renderFoundationBoundApprovalSummary(input, target.targetKey),
      sourceShaB64u: mutate(Buffer.from(input.sourceSha, 'hex').toString('base64url')),
    };

    expect(() => admitFoundationBoundApprovalSummary(summary, input, target.targetKey)).toThrow(
      'Foundation-bound approval summary source SHA is invalid.',
    );
  });

  it('reconstructs the one governed content-addressed key and rejects a digest from another acceptance', () => {
    const input = foundationBoundInput();
    const summary = {
      ...renderFoundationBoundApprovalSummary(input, target.targetKey),
      foundationAcceptanceDigestB64u: Buffer.from('0'.repeat(64), 'hex').toString('base64url'),
    };

    expect(() => admitFoundationBoundApprovalSummary(summary, input, target.targetKey)).toThrow(
      'Foundation-bound approval summary Foundation acceptance key does not match the carried authority.',
    );
  });

  it('rejects an oversized encoded field before base64 decoding or allocation', () => {
    const input = foundationBoundInput();
    const summary = {
      ...renderFoundationBoundApprovalSummary(input, target.targetKey),
      sourceShaB64u: 'A'.repeat(1024 * 1024),
    };
    const decode = vi.spyOn(Buffer, 'from');
    try {
      expect(() => admitFoundationBoundApprovalSummary(summary, input, target.targetKey)).toThrow(
        'Foundation-bound approval summary source SHA is invalid.',
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('rejects proxied and accessor-bearing render inputs without executing traps or getters', () => {
    let observations = 0;
    const traps = {
      get: () => {
        observations += 1;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        observations += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        observations += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        observations += 1;
        return [];
      },
    };
    expect(() =>
      renderFoundationBoundApprovalSummary(new Proxy(foundationBoundInput(), traps), target.targetKey),
    ).toThrow();

    const proxiedPrototypeInput = { ...foundationBoundInput() };
    Object.setPrototypeOf(proxiedPrototypeInput, new Proxy(Object.prototype, traps));
    expect(() => renderFoundationBoundApprovalSummary(proxiedPrototypeInput, target.targetKey)).toThrow();

    const accessorInput = { ...foundationBoundInput() };
    Object.defineProperty(accessorInput, 'sourceSha', {
      enumerable: true,
      get: () => {
        observations += 1;
        return sourceSha;
      },
    });
    expect(() => renderFoundationBoundApprovalSummary(accessorInput, target.targetKey)).toThrow();
    expect(observations).toBe(0);
  });

  it('rejects proxied summaries and expected inputs without executing traps or getters', () => {
    const expected = foundationBoundInput();
    const summary = renderFoundationBoundApprovalSummary(expected, target.targetKey);
    let observations = 0;
    const traps = {
      get: () => {
        observations += 1;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        observations += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        observations += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        observations += 1;
        return [];
      },
    };
    expect(() => admitFoundationBoundApprovalSummary(new Proxy(summary, traps), expected, target.targetKey)).toThrow();

    const proxiedPrototypeExpected = { ...expected };
    Object.setPrototypeOf(proxiedPrototypeExpected, new Proxy(Object.prototype, traps));
    expect(() => admitFoundationBoundApprovalSummary(summary, proxiedPrototypeExpected, target.targetKey)).toThrow();

    const accessorExpected = { ...expected };
    Object.defineProperty(accessorExpected, 'foundationAcceptance', {
      enumerable: true,
      get: () => {
        observations += 1;
        return foundationAcceptance;
      },
    });
    expect(() => admitFoundationBoundApprovalSummary(summary, accessorExpected, target.targetKey)).toThrow();
    expect(observations).toBe(0);
  });
});

describe('saved-plan approval publication', () => {
  it('rejects proxied and accessor-bearing Foundation-bound validator inputs without executing authority code', () => {
    let observations = 0;
    const traps = {
      get: () => {
        observations += 1;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        observations += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        observations += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        observations += 1;
        return [];
      },
    };
    expect(() =>
      validateFoundationBoundSavedPlanApprovalPublication(
        new Proxy(foundationBoundPublicationInput(), traps),
        target.targetKey,
      ),
    ).toThrow();

    const proxiedPrototypeInput = foundationBoundPublicationInput();
    Object.setPrototypeOf(proxiedPrototypeInput, new Proxy(Object.prototype, traps));
    expect(() =>
      validateFoundationBoundSavedPlanApprovalPublication(proxiedPrototypeInput, target.targetKey),
    ).toThrow();

    const accessorInput = foundationBoundPublicationInput();
    Object.defineProperty(accessorInput, 'foundationAcceptance', {
      enumerable: true,
      get: () => {
        observations += 1;
        return foundationAcceptance;
      },
    });
    expect(() => validateFoundationBoundSavedPlanApprovalPublication(accessorInput, target.targetKey)).toThrow();

    const nestedAccessorInput = foundationBoundPublicationInput();
    const [approval] = nestedAccessorInput.actionExecutions.actionExecutionDetails;
    if (approval === undefined) {
      throw new Error('Approval fixture is missing.');
    }
    Object.defineProperty(approval.output.executionResult, 'externalExecutionSummary', {
      enumerable: true,
      get: () => {
        observations += 1;
        return '{}';
      },
    });
    expect(() => validateFoundationBoundSavedPlanApprovalPublication(nestedAccessorInput, target.targetKey)).toThrow();
    expect(observations).toBe(0);
  });

  it('binds one successful CodePipeline approval to the exact saved plan', () => {
    expect(validateSavedPlanApprovalPublication(approvalInput(), target.targetKey)).toEqual({
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
    const extension = { changeDisposition: 'reviewed-change' } as const;

    expect(validateSavedPlanApprovalPublication(approvalInput(extension), target.targetKey)).toMatchObject({
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
    expect(() =>
      validateSavedPlanApprovalPublication(approvalInput({ [field]: 'collision' }), target.targetKey),
    ).toThrow('Saved-plan approval summary extensions are invalid.');
  });

  it('requires a strict grouped lowercase pipeline execution UUID', () => {
    const value = approvalInput();
    value.pipelineExecutionId = 'a'.repeat(36);

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
      'Pipeline execution ID is invalid.',
    );
  });

  it('requires a strict grouped lowercase action execution UUID', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.actionExecutionId = 'a'.repeat(36);

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
      preflightPolicy.exactlyOneError,
    );
  });

  it('preserves the exact invalid-JSON message', () => {
    const value = approvalInput();
    const [approval] = value.actionExecutions.actionExecutionDetails;
    if (!approval) {
      throw new Error('Approval fixture is missing.');
    }
    approval.output.executionResult.externalExecutionSummary = '{invalid}';

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
      'Verifier-preflight approver is invalid.',
    );
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
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

    expect(() => validateSavedPlanApprovalPublication(value, target.targetKey)).toThrow(
      'Verifier-preflight approval timestamp is invalid.',
    );
  });
});

describe('App empty-plan skip eligibility', () => {
  it.each([
    ['develop', 'normal', true],
    ['develop', 'rollback', false],
    ['main', 'normal', false],
    ['main', 'rollback', false],
    ['production', 'normal', false],
    [undefined, 'normal', false],
    ['develop', undefined, false],
    ['develop', 'initial', false],
  ])('admits only develop normal eligibility (%s / %s)', (environment, mode, allowed) => {
    expect(allowsAppEmptyPlanSkip(environment, mode)).toBe(allowed);
  });
});

it('requires an independently selected target at every approval authority boundary', () => {
  const input = foundationBoundInput();
  const summary = renderFoundationBoundApprovalSummary(input, target.targetKey);
  for (const expectedTarget of [undefined, 'unreviewed/main']) {
    expect(() => admitSavedPlanApprovalActionProjection(actionProjection(), expectedTarget)).toThrow();
    expect(() => admitFoundationAcceptanceApprovalBinding(foundationAcceptance, expectedTarget)).toThrow();
    expect(() => renderFoundationBoundApprovalSummary(input, expectedTarget)).toThrow();
    expect(() => admitFoundationBoundApprovalSummary(summary, input, expectedTarget)).toThrow();
    expect(() => validateSavedPlanApprovalPublication(approvalInput(), expectedTarget)).toThrow();
    expect(() =>
      validateFoundationBoundSavedPlanApprovalPublication(
        {
          ...approvalInput(),
          foundationAcceptance,
          summaryType: 'verifier-preflight',
        },
        expectedTarget,
      ),
    ).toThrow();
  }
});

it('isolates production approval actions, compact Foundation summaries, and saved-plan publication', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configured = await import('./index.js');
    const approvals = await import('./plan-approval.js');
    const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
    const foundation = configured.resolveDeploymentLaneAuthority(production, 'foundation');
    const productionBinding = {
      ...foundationAcceptance,
      foundationAcceptanceKey: `${foundation.names.terraformBaselinePrefix}/${foundation.stateIdentity}/acceptances/${foundationAcceptanceDigest}.json`,
    };
    const input = {
      ...foundationBoundInput(),
      accountId: production.accountId,
      deploymentEnvironment: production.environmentId,
      foundationAcceptance: productionBinding,
    };
    const summary = approvals.renderFoundationBoundApprovalSummary(input, production.targetKey);
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBe(496);
    expect(approvals.admitFoundationBoundApprovalSummary(summary, input, production.targetKey)).toEqual({
      sourceSha: input.sourceSha,
      accountId: production.accountId,
      deploymentEnvironment: 'main',
      reviewedPlanChecksum,
      foundationAcceptance: productionBinding,
    });
    expect(approvals.admitFoundationAcceptanceApprovalBinding(productionBinding, production.targetKey)).toEqual(
      productionBinding,
    );
    expect(() =>
      approvals.admitFoundationAcceptanceApprovalBinding(foundationAcceptance, production.targetKey),
    ).toThrow();
    expect(() => approvals.admitFoundationAcceptanceApprovalBinding(productionBinding, target.targetKey)).toThrow();
    expect(() => approvals.renderFoundationBoundApprovalSummary(input, target.targetKey)).toThrow();
    expect(() =>
      approvals.renderFoundationBoundApprovalSummary({ ...input, foundationAcceptance }, production.targetKey),
    ).toThrow();
    expect(() => approvals.admitFoundationBoundApprovalSummary(summary, input, target.targetKey)).toThrow();
    const devSummary = approvals.renderFoundationBoundApprovalSummary(foundationBoundInput(), target.targetKey);
    expect(() => approvals.admitFoundationBoundApprovalSummary(devSummary, input, production.targetKey)).toThrow();
    for (const changes of [
      { accountId: target.accountId },
      { deploymentEnvironment: target.environmentId },
      { sourceShaB64u: Buffer.from('e'.repeat(64), 'hex').toString('base64url') },
      { reviewedPlanChecksumB64u: Buffer.from('e'.repeat(64), 'hex').toString('base64url') },
      { foundationAcceptanceDigestB64u: Buffer.from('e'.repeat(64), 'hex').toString('base64url') },
      { foundationContractHashB64u: Buffer.from('e'.repeat(64), 'hex').toString('base64url') },
    ]) {
      expect(() =>
        approvals.admitFoundationBoundApprovalSummary({ ...summary, ...changes }, input, production.targetKey),
      ).toThrow();
    }

    const action = actionProjection().actionExecutionDetails[0];
    if (action === undefined) throw new Error('Missing approval fixture.');
    const productionAction = {
      ...action,
      updatedBy: `arn:${production.partition}:sts::${production.accountId}:assumed-role/stark-prod-operator/user00`,
      output: {
        executionResult: {
          externalExecutionId: actionExecutionId,
          externalExecutionSummary: JSON.stringify(summary),
        },
      },
    };
    const projectedActions = { actionExecutionDetails: [productionAction] };
    expect(approvals.admitSavedPlanApprovalActionProjection(projectedActions, production.targetKey)).toEqual(
      projectedActions,
    );
    expect(() => approvals.admitSavedPlanApprovalActionProjection(projectedActions, target.targetKey)).toThrow();
    expect(() => approvals.admitSavedPlanApprovalActionProjection(actionProjection(), production.targetKey)).toThrow();
    const publication = {
      ...input,
      actionExecutions: projectedActions,
      pipelineExecutionId,
      policy: preflightPolicy,
    };
    expect(
      approvals.validateFoundationBoundSavedPlanApprovalPublication(publication, production.targetKey),
    ).toMatchObject({
      accountId: production.accountId,
      deploymentEnvironment: 'main',
      foundationAcceptanceKey: productionBinding.foundationAcceptanceKey,
      approver: productionAction.updatedBy,
      reviewedPlanChecksum,
    });
    expect(() =>
      approvals.validateFoundationBoundSavedPlanApprovalPublication(publication, target.targetKey),
    ).toThrow();
    expect(() =>
      approvals.validateFoundationBoundSavedPlanApprovalPublication(
        { ...publication, foundationAcceptance },
        production.targetKey,
      ),
    ).toThrow();
    const wrongApprover = {
      actionExecutionDetails: [{ ...productionAction, updatedBy: action.updatedBy }],
    };
    expect(() =>
      approvals.validateFoundationBoundSavedPlanApprovalPublication(
        { ...publication, actionExecutions: wrongApprover },
        production.targetKey,
      ),
    ).toThrow('approver');
    expect(() =>
      approvals.validateFoundationBoundSavedPlanApprovalPublication(
        { ...publication, actionExecutions: { actionExecutionDetails: [] } },
        production.targetKey,
      ),
    ).toThrow(preflightPolicy.exactlyOneError);

    const policy = {
      ...preflightPolicy,
      stageName: 'ManualApproval',
      actionName: configured.resolveBootstrapSavedPlanApprovalAction(production),
    };
    const generic = {
      ...approvalInput(),
      accountId: production.accountId,
      deploymentEnvironment: production.environmentId,
      policy,
      actionExecutions: {
        actionExecutionDetails: [
          {
            ...productionAction,
            stageName: policy.stageName,
            actionName: policy.actionName,
            output: {
              executionResult: {
                externalExecutionSummary: JSON.stringify({
                  sourceSha,
                  accountId: production.accountId,
                  deploymentEnvironment: 'main',
                  reviewedPlanChecksum,
                }),
              },
            },
          },
        ],
      },
    };
    expect(approvals.validateSavedPlanApprovalPublication(generic, production.targetKey)).toMatchObject({
      actionName: 'ApproveBootstrapApply',
      accountId: production.accountId,
      deploymentEnvironment: 'main',
      approver: productionAction.updatedBy,
      reviewedPlanChecksum,
    });
    expect(() => approvals.validateSavedPlanApprovalPublication(generic, target.targetKey)).toThrow();
    expect(() => approvals.validateSavedPlanApprovalPublication(approvalInput(), production.targetKey)).toThrow();
    const [genericAction] = generic.actionExecutions.actionExecutionDetails;
    if (genericAction === undefined) throw new Error('Missing generic approval fixture.');
    for (const wrongAction of [
      { ...genericAction, updatedBy: action.updatedBy },
      { ...genericAction, status: 'Failed' },
      { ...genericAction, actionName: 'ApproveDevelopBootstrapApply' },
      {
        ...genericAction,
        output: {
          executionResult: {
            externalExecutionSummary: JSON.stringify({
              sourceSha,
              accountId: target.accountId,
              deploymentEnvironment: 'develop',
              reviewedPlanChecksum,
            }),
          },
        },
      },
    ]) {
      expect(() =>
        approvals.validateSavedPlanApprovalPublication(
          {
            ...generic,
            actionExecutions: { actionExecutionDetails: [wrongAction] },
          },
          production.targetKey,
        ),
      ).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
