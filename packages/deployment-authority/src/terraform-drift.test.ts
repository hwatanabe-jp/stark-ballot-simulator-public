import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import { renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from '@stark-ballot/deployment-authority';
import type { TerraformDriftEvidence, TerraformDriftResult, TerraformDriftSummary } from './terraform-drift.js';
import {
  MAX_REDACTED_TERRAFORM_ADDRESSES,
  buildTerraformDriftEvidence,
  classifyTerraformActionSequence,
  classifyTerraformDetailedExitCode,
  redactTerraformResourceAddress,
  summarizeTerraformPlan,
  validateTerraformDriftEvidence,
  validateTerraformDriftSummary,
} from './terraform-drift.js';

const sourceSha = 'a'.repeat(40);
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const mismatchedAccountId = `${target.accountId.startsWith('0') ? '1' : '0'}${target.accountId.slice(1)}`;
const stateKmsKeyArn = `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/11111111-2222-3333-4444-555555555555`;
const acceptedAuthorityReference = {
  key: 'accepted-authority/app/executions/11111111-2222-3333-4444-555555555555.json',
  versionId: 'accepted-authority-version',
  sha256: 'b'.repeat(64),
};
const targetConfigurationSha256 = renderDeploymentLaneContext({
  target,
  lane: 'app',
  accountId: target.accountId,
  requestedControlSourceSha: sourceSha,
  selectedApplicationSourceSha: sourceSha,
  frameworkSourceSha: sourceSha,
}).targetConfigurationSha256;

function driftIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: target.accountId,
    region: target.region,
    root: 'app',
    stateIdentity: 'stark-dev/develop/app',
    backend: {
      bucketName: 'stark-ballot-simulator-terraform-state-stark-dev-develop',
      backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
      kmsKeyArn: stateKmsKeyArn,
      region: target.region,
    },
    controlSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
    targetConfigurationSha256,
    ...overrides,
  };
}

const toolRuntime = {
  runnerSourceSha: sourceSha,
  terraformVersion: '1.15.5',
  terraformPlanFormatVersion: '1.2',
};
const buildRuntime = {
  configuredManagedImage: 'aws/codebuild/standard:8.0',
  runningManagedImage: 'aws/codebuild/standard:7.0',
};

function driftEvidenceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    acceptedAuthority: acceptedAuthorityReference,
    buildRuntime,
    expectedIdentity: driftIdentity(),
    observed: driftIdentity(),
    executionId: 'drift-check:11111111-2222-3333-4444-555555555555',
    startedAt: '2026-08-01T12:00:00.000Z',
    finishedAt: '2026-08-01T12:01:00.000Z',
    terraformDetailedExitCode: 0,
    failureStage: null,
    summary: summarizeTerraformPlan({}),
    toolRuntime,
    ...overrides,
  };
}

function resourceChange(address: string, actions: readonly string[]): Record<string, unknown> {
  return {
    address,
    mode: 'managed',
    change: {
      actions,
      before: { ignored: true },
      after: { ignored: true },
      before_sensitive: { ignored: true },
      after_sensitive: { ignored: true },
      after_unknown: { ignored: true },
    },
  };
}

describe('Terraform drift plan summary', () => {
  it.each([
    [['no-op'], null],
    [['create'], 'create'],
    [['update'], 'update'],
    [['delete', 'create'], 'replace'],
    [['create', 'delete'], 'replace'],
    [['delete'], 'delete'],
    [['read'], 'read-only'],
  ] as const)('owns the closed action classification for %j', (actions, expected) => {
    expect(classifyTerraformActionSequence(actions)).toBe(expected);
  });

  it.each([[], ['forget'], ['update', 'read'], ['no-op', 'update'], null, {}])(
    'rejects an unsupported public action sequence: %j',
    (actions) => {
      expect(() => classifyTerraformActionSequence(actions)).toThrow('Terraform action sequence');
    },
  );

  it('excludes no-ops and deterministically deduplicates redacted indexed addresses', () => {
    const summary = summarizeTerraformPlan({
      resource_changes: [
        resourceChange('aws_s3_bucket.unchanged', ['no-op']),
        resourceChange('module.worker["tenant-secret"].aws_instance.node[1]', ['update']),
        resourceChange('module.worker["another-secret"].aws_instance.node[2]', ['update']),
      ],
    });

    expect(summary).toEqual({
      actionCounts: {
        create: 0,
        update: 2,
        replace: 0,
        delete: 0,
        readOnly: 0,
      },
      addresses: [
        {
          address: 'module.worker[*].aws_instance.node[*]',
          actionClasses: ['update'],
        },
      ],
      omittedAddressCount: 0,
    });
  });

  it('classifies the closed Terraform action sequences and both replacement orders', () => {
    const summary = summarizeTerraformPlan({
      resource_changes: [
        resourceChange('aws_s3_bucket.created', ['create']),
        resourceChange('aws_s3_bucket.updated', ['update']),
        resourceChange('aws_s3_bucket.replaced_destroy_first', ['delete', 'create']),
        resourceChange('aws_s3_bucket.replaced_create_first', ['create', 'delete']),
        resourceChange('aws_s3_bucket.deleted', ['delete']),
        resourceChange('data.aws_caller_identity.current', ['read']),
      ],
    });

    expect(summary.actionCounts).toEqual({
      create: 1,
      update: 1,
      replace: 2,
      delete: 1,
      readOnly: 1,
    });
    expect(summary.addresses).toEqual([
      { address: 'aws_s3_bucket.created', actionClasses: ['create'] },
      { address: 'aws_s3_bucket.deleted', actionClasses: ['delete'] },
      { address: 'aws_s3_bucket.replaced_create_first', actionClasses: ['replace'] },
      { address: 'aws_s3_bucket.replaced_destroy_first', actionClasses: ['replace'] },
      { address: 'aws_s3_bucket.updated', actionClasses: ['update'] },
      { address: 'data.aws_caller_identity.current', actionClasses: ['read-only'] },
    ]);
  });

  it.each<readonly [readonly string[]]>([
    [[]],
    [['forget']],
    [['forget', 'create']],
    [['update', 'read']],
    [['create', 'update']],
    [['no-op', 'update']],
  ])('fails closed for an unsupported Terraform action sequence: %j', (actions) => {
    expect(() =>
      summarizeTerraformPlan({ resource_changes: [resourceChange('aws_s3_bucket.example', actions)] }),
    ).toThrow('resource_changes[0].change.actions is not a supported Terraform action sequence.');
  });

  it('redacts every numeric or quoted index without leaking quoted closing brackets', () => {
    expect(
      redactTerraformResourceAddress('module.worker["tenant]secret"].module.task[0].aws_instance.node["private-key"]'),
    ).toBe('module.worker[*].module.task[*].aws_instance.node[*]');
  });

  it('admits its own canonical redacted indexed-address summaries', () => {
    const summary = summarizeTerraformPlan({
      resource_changes: [resourceChange('module.worker["tenant"].aws_instance.node[0]', ['update'])],
    });

    expect(validateTerraformDriftSummary(summary)).toEqual(summary);
    expect(() => redactTerraformResourceAddress('module.worker[*].aws_instance.node[*]')).toThrow(
      'Terraform resource address is invalid.',
    );
  });

  it.each([
    '',
    '.aws_s3_bucket.example',
    'aws_s3_bucket..example',
    'aws_s3_bucket.example.',
    'aws_s3_bucket.example[]',
    'aws_s3_bucket.example["unterminated"',
    'aws_s3_bucket.example\nsecond-line',
    `aws_s3_bucket.${'a'.repeat(4_100)}`,
  ])('fails closed without echoing a malformed address: %j', (address) => {
    expect(() => redactTerraformResourceAddress(address)).toThrow('Terraform resource address is invalid.');
    try {
      redactTerraformResourceAddress(address);
    } catch (error) {
      if (address.length > 0) {
        expect(String(error)).not.toContain(address);
      }
    }
  });

  it('sorts merged action classes and caps deduplicated addresses independently of input order', () => {
    const changes = Array.from({ length: MAX_REDACTED_TERRAFORM_ADDRESSES + 5 }, (_, index) =>
      resourceChange(`aws_s3_bucket.bucket_${String(index).padStart(3, '0')}`, ['update']),
    );
    changes.push(resourceChange('aws_s3_bucket.bucket_000', ['create']));

    const forward = summarizeTerraformPlan({ resource_changes: changes });
    const reverse = summarizeTerraformPlan({ resource_changes: [...changes].reverse() });

    expect(forward).toEqual(reverse);
    expect(forward.addresses).toHaveLength(MAX_REDACTED_TERRAFORM_ADDRESSES);
    expect(forward.addresses[0]).toEqual({
      address: 'aws_s3_bucket.bucket_000',
      actionClasses: ['create', 'update'],
    });
    expect(forward.omittedAddressCount).toBe(5);
    expect(forward.actionCounts).toEqual({
      create: 1,
      update: MAX_REDACTED_TERRAFORM_ADDRESSES + 5,
      replace: 0,
      delete: 0,
      readOnly: 0,
    });
    const review = summarizeTerraformPlan({ resource_changes: changes }, 'saved-plan-review');
    expect(review.addresses).toHaveLength(MAX_REDACTED_TERRAFORM_ADDRESSES + 5);
    expect(review.omittedAddressCount).toBe(0);
    expect(review.actionCounts).toEqual(forward.actionCounts);
    expect(() => validateTerraformDriftSummary(review)).toThrow('Terraform drift addresses');
  });

  it('rejects an unknown summary purpose', () => {
    expect(() => {
      Reflect.apply(summarizeTerraformPlan, undefined, [{}, 'unreviewed']);
    }).toThrow('purpose');
  });

  it('never traverses or serializes raw plan values and sensitive projections', () => {
    const change: Record<string, unknown> = { actions: ['update'] };
    for (const field of ['before', 'after', 'before_sensitive', 'after_sensitive', 'after_unknown']) {
      Object.defineProperty(change, field, {
        enumerable: true,
        get() {
          throw new Error(`sensitive sentinel ${field}`);
        },
      });
    }
    const plan: Record<string, unknown> = {
      resource_changes: [{ address: 'aws_s3_bucket.example["secret-index"]', mode: 'managed', change }],
    };
    for (const field of ['resource_drift', 'output_changes', 'planned_values', 'prior_state']) {
      Object.defineProperty(plan, field, {
        enumerable: true,
        get() {
          throw new Error(`sensitive sentinel ${field}`);
        },
      });
    }

    const summary = summarizeTerraformPlan(plan);

    expect(summary.addresses).toEqual([{ address: 'aws_s3_bucket.example[*]', actionClasses: ['update'] }]);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it.each([
    null,
    [],
    { resource_changes: null },
    { resource_changes: {} },
    { resource_changes: [null] },
    { resource_changes: [{}] },
    { resource_changes: [{ address: 'aws_s3_bucket.example', change: {} }] },
    { resource_changes: [{ change: { actions: ['update'] } }] },
    { resource_changes: [{ change: { actions: ['no-op'] } }] },
  ])('fails closed for malformed Terraform plan JSON: %j', (plan) => {
    expect(() => summarizeTerraformPlan(plan)).toThrow();
  });

  it('rejects accessor-backed required plan fields without invoking them', () => {
    let getterInvoked = false;
    const resourceChangeWithAccessor = {
      change: { actions: ['update'] },
    };
    Object.defineProperty(resourceChangeWithAccessor, 'address', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'aws_s3_bucket.secret';
      },
    });

    expect(() => summarizeTerraformPlan({ resource_changes: [resourceChangeWithAccessor] })).toThrow(
      'resource_changes[0].address must be an enumerable data property.',
    );
    expect(getterInvoked).toBe(false);
  });

  it('rejects an accessor-backed action array without invoking it', () => {
    let getterInvoked = false;
    const actions = ['update'];
    Object.defineProperty(actions, '0', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'update';
      },
    });

    expect(() =>
      summarizeTerraformPlan({
        resource_changes: [resourceChange('aws_s3_bucket.example', actions)],
      }),
    ).toThrow('resource_changes[0].change.actions must be a dense data-property array.');
    expect(getterInvoked).toBe(false);
  });
});

describe('Terraform detailed exit status', () => {
  it.each([
    [0, 'no-drift'],
    [2, 'drift-detected'],
    [1, 'check-failed'],
    [255, 'check-failed'],
    [null, 'check-failed'],
  ] as const)('maps %j to %s', (exitCode, expected) => {
    expect(classifyTerraformDetailedExitCode(exitCode)).toBe(expected);
  });

  it.each([undefined, '2', -1, 256, 1.5, Number.NaN])('rejects an invalid detailed exit status: %j', (value) => {
    expect(() => classifyTerraformDetailedExitCode(value)).toThrow('Terraform detailed exit code is invalid.');
  });

  it('exposes closed result and evidence types', () => {
    expectTypeOf<ReturnType<typeof classifyTerraformDetailedExitCode>>().toEqualTypeOf<TerraformDriftResult>();
    expectTypeOf<ReturnType<typeof summarizeTerraformPlan>>().toEqualTypeOf<TerraformDriftSummary>();
    expectTypeOf<ReturnType<typeof buildTerraformDriftEvidence>>().toEqualTypeOf<TerraformDriftEvidence>();
    expectTypeOf<ReturnType<typeof validateTerraformDriftEvidence>>().toEqualTypeOf<TerraformDriftEvidence>();
  });
});

describe('Terraform drift evidence', () => {
  it('builds and validates exact report-only no-drift evidence', () => {
    const evidence = buildTerraformDriftEvidence(driftEvidenceInput());

    expect(evidence).toEqual({
      evidenceType: 'terraform-drift-report',
      executionId: 'drift-check:11111111-2222-3333-4444-555555555555',
      acceptedAuthority: acceptedAuthorityReference,
      buildRuntime,
      observed: driftIdentity(),
      startedAt: '2026-08-01T12:00:00.000Z',
      finishedAt: '2026-08-01T12:01:00.000Z',
      result: 'no-drift',
      terraformDetailedExitCode: 0,
      failureStage: null,
      summary: {
        actionCounts: { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 },
        addresses: [],
        omittedAddressCount: 0,
      },
      reportOnly: true,
      toolRuntime,
    });
    expect(validateTerraformDriftEvidence(evidence)).toEqual(evidence);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it('reports output-only Terraform exit 2 as drift with an empty resource summary', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          terraformDetailedExitCode: 2,
        }),
      ),
    ).toMatchObject({
      result: 'drift-detected',
      terraformDetailedExitCode: 2,
      summary: {
        actionCounts: { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 },
        addresses: [],
        omittedAddressCount: 0,
      },
    });
  });

  it('records a pre-pointer failure without fabricating accepted authority or observed coordinates', () => {
    const evidence = buildTerraformDriftEvidence(
      driftEvidenceInput({
        acceptedAuthority: null,
        expectedIdentity: null,
        observed: null,
        terraformDetailedExitCode: null,
        failureStage: 'authority-selection',
        summary: null,
        toolRuntime: null,
      }),
    );

    expect(evidence).toMatchObject({
      acceptedAuthority: null,
      observed: null,
      result: 'check-failed',
      terraformDetailedExitCode: null,
      failureStage: 'authority-selection',
      summary: null,
      reportOnly: true,
      toolRuntime: null,
    });
    expect(validateTerraformDriftEvidence(evidence)).toEqual(evidence);
  });

  it('maps an ordinary Terraform error to check-failed with an explicit derived stage', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          terraformDetailedExitCode: 1,
          summary: null,
        }),
      ),
    ).toMatchObject({
      result: 'check-failed',
      terraformDetailedExitCode: 1,
      failureStage: 'terraform-plan',
      summary: null,
    });
  });

  it('lets a later summary admission failure override exit 2 without retaining an untrusted summary', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          terraformDetailedExitCode: 2,
          failureStage: 'plan-summary',
          summary: null,
        }),
      ),
    ).toMatchObject({
      result: 'check-failed',
      terraformDetailedExitCode: 2,
      failureStage: 'plan-summary',
      summary: null,
    });
  });

  it('admits an explicit runner-runtime failure stage', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          acceptedAuthority: null,
          buildRuntime: null,
          expectedIdentity: null,
          observed: null,
          terraformDetailedExitCode: null,
          failureStage: 'runner-runtime',
          summary: null,
          toolRuntime: null,
        }),
      ),
    ).toMatchObject({ result: 'check-failed', failureStage: 'runner-runtime' });
  });

  it('admits plan-input-preparation as a closed report-only failure stage', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          terraformDetailedExitCode: null,
          failureStage: 'plan-input-preparation',
          summary: null,
          toolRuntime: null,
        }),
      ),
    ).toMatchObject({ result: 'check-failed', failureStage: 'plan-input-preparation' });
  });

  it('retains distinct configured and running AWS-managed build images', () => {
    expect(buildTerraformDriftEvidence(driftEvidenceInput()).buildRuntime).toEqual(buildRuntime);
  });

  it.each([
    ['configuredManagedImage', 'registry.example.invalid/custom:latest'],
    ['runningManagedImage', 'aws/codebuild/standard:8.0-26.08.30'],
  ] as const)('rejects an invalid %s independently', (field, value) => {
    expect(() =>
      buildTerraformDriftEvidence(driftEvidenceInput({ buildRuntime: { ...buildRuntime, [field]: value } })),
    ).toThrow(/AWS-managed|build runtime|image/iu);
  });

  it.each([
    [
      'backend',
      {
        bucketName: 'another-valid-state-bucket',
        backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
        kmsKeyArn: stateKmsKeyArn,
        region: target.region,
      },
    ],
    ['controlSourceSha', 'f'.repeat(40)],
    ['frameworkSourceSha', 'f'.repeat(40)],
    ['targetConfigurationSha256', 'f'.repeat(64)],
  ])('rejects a successful observation whose %s differs from accepted identity', (field, value) => {
    expect(() =>
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          observed: driftIdentity({ [field]: value }),
        }),
      ),
    ).toThrow('Terraform drift observed identity does not match the accepted authority identity.');
  });

  it.each([
    ['accountId', '999999999999'],
    ['region', 'us-east-1'],
    ['stateIdentity', 'other/develop/app'],
  ])('rejects drift evidence whose %s conflicts with its backend authority', (field, value) => {
    expect(() =>
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          observed: driftIdentity({ [field]: value }),
        }),
      ),
    ).toThrow('Terraform drift observed identity backend authority is invalid.');
  });

  it.each([
    ['backendKey', 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate'],
    ['region', 'us-east-1'],
    [
      'kmsKeyArn',
      `arn:${target.partition}:kms:${target.region}:${mismatchedAccountId}:key/11111111-2222-3333-4444-555555555555`,
    ],
  ] as const)('rejects drift evidence with invalid backend %s authority', (field, value) => {
    const identity = driftIdentity();
    const backend = identity['backend'] as Record<string, unknown>;

    expect(() =>
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          observed: driftIdentity({ backend: { ...backend, [field]: value } }),
        }),
      ),
    ).toThrow('Terraform drift observed identity backend authority is invalid.');
  });

  it('records the trusted runner source independently from the accepted Terraform source', () => {
    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          toolRuntime: { ...toolRuntime, runnerSourceSha: 'f'.repeat(40) },
        }),
      ).toolRuntime,
    ).toEqual({ ...toolRuntime, runnerSourceSha: 'f'.repeat(40) });
  });

  it.each([
    {
      label: 'observed coordinates without accepted authority',
      overrides: {
        acceptedAuthority: null,
        expectedIdentity: null,
        terraformDetailedExitCode: null,
        failureStage: 'authority-selection',
        summary: null,
      },
      message: 'Terraform drift observed identity requires an expected identity.',
    },
    {
      label: 'expected identity without accepted authority',
      overrides: {
        acceptedAuthority: null,
        observed: null,
        terraformDetailedExitCode: null,
        failureStage: 'authority-selection',
        summary: null,
      },
      message: 'Terraform drift expected identity requires an admitted accepted authority reference.',
    },
    {
      label: 'pre-run failure without a failure stage',
      overrides: {
        acceptedAuthority: null,
        expectedIdentity: null,
        observed: null,
        terraformDetailedExitCode: null,
        summary: null,
        toolRuntime: null,
      },
      message: 'A pre-Terraform check failure requires an explicit failureStage.',
    },
    {
      label: 'successful result without accepted authority',
      overrides: { acceptedAuthority: null },
      message: 'Successful Terraform drift evidence requires complete admitted coordinates.',
    },
    {
      label: 'failed result retaining a plan summary',
      overrides: { terraformDetailedExitCode: 1 },
      message: 'Failed Terraform drift evidence must not claim a plan summary.',
    },
  ])('rejects $label', ({ overrides, message }) => {
    expect(() => buildTerraformDriftEvidence(driftEvidenceInput(overrides))).toThrow(message);
  });

  it.each([
    ['startedAt', '2026-08-01 12:00:00'],
    ['startedAt', '2026-08-01T12:00:00+00:00'],
    ['startedAt', '2026-02-31T12:00:00.000Z'],
    ['finishedAt', 'not-a-timestamp'],
    ['finishedAt', '2026-08-01T11:59:59.999Z'],
  ])('rejects invalid timestamp field %s', (field, value) => {
    expect(() => buildTerraformDriftEvidence(driftEvidenceInput({ [field]: value }))).toThrow(/Terraform drift/);
  });

  it('rejects accessor-backed summary arrays without invoking them', () => {
    let getterInvoked = false;
    const addresses = [{ address: 'aws_s3_bucket.example', actionClasses: ['update'] }];
    Object.defineProperty(addresses, '0', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return { address: 'aws_s3_bucket.secret', actionClasses: ['update'] };
      },
    });
    const summary = {
      actionCounts: { create: 0, update: 1, replace: 0, delete: 0, readOnly: 0 },
      addresses,
      omittedAddressCount: 0,
    };

    expect(() => buildTerraformDriftEvidence(driftEvidenceInput({ terraformDetailedExitCode: 2, summary }))).toThrow(
      'Terraform drift addresses must be a dense data-property array.',
    );
    expect(getterInvoked).toBe(false);
  });

  it.each([
    ['top-level input', { unknown: true }],
    ['expected identity', { expectedIdentity: driftIdentity({ unknown: true }) }],
    ['observed identity', { observed: driftIdentity({ unknown: true }) }],
    ['accepted authority reference', { acceptedAuthority: { ...acceptedAuthorityReference, unknown: true } }],
    ['summary', { summary: { ...summarizeTerraformPlan({}), unknown: true } }],
    ['tool runtime', { toolRuntime: { ...toolRuntime, unknown: true } }],
    ['build runtime', { buildRuntime: { ...buildRuntime, unknown: true } }],
  ])('rejects unknown keys in %s', (_label, additions) => {
    const input = 'unknown' in additions ? { ...driftEvidenceInput(), ...additions } : driftEvidenceInput(additions);
    expect(() => buildTerraformDriftEvidence(input)).toThrow();
  });

  it.each([
    ['evidenceType', 'terraform-drift-report-unknown'],
    ['reportOnly', false],
    ['result', 'unknown'],
    ['result', 'drift-detected'],
    ['failureStage', 'unknown-stage'],
  ])('rejects tampered evidence field %s=%j', (field, value) => {
    const evidence: Record<string, unknown> = { ...buildTerraformDriftEvidence(driftEvidenceInput()) };
    evidence[field] = value;
    expect(() => validateTerraformDriftEvidence(evidence)).toThrow();
  });

  it('rejects unknown evidence keys', () => {
    const evidence = { ...buildTerraformDriftEvidence(driftEvidenceInput()), rawPlan: { secret: true } };
    expect(() => validateTerraformDriftEvidence(evidence)).toThrow(
      'Terraform drift evidence must use the exact current shape.',
    );
  });

  it('rejects mutating resource actions under a no-drift exit code but permits read-only observations', () => {
    expect(() =>
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          summary: summarizeTerraformPlan({
            resource_changes: [resourceChange('aws_s3_bucket.changed', ['update'])],
          }),
        }),
      ),
    ).toThrow('Terraform no-drift evidence cannot contain mutating resource actions.');

    expect(
      buildTerraformDriftEvidence(
        driftEvidenceInput({
          summary: summarizeTerraformPlan({
            resource_changes: [resourceChange('data.aws_caller_identity.current', ['read'])],
          }),
        }),
      ),
    ).toMatchObject({ result: 'no-drift' });
  });

  it.each([
    {
      label: 'an address class absent from counts',
      summary: {
        actionCounts: { create: 0, update: 0, replace: 0, delete: 0, readOnly: 1 },
        addresses: [{ address: 'aws_s3_bucket.example', actionClasses: ['update'] }],
        omittedAddressCount: 0,
      },
    },
    {
      label: 'actions without any represented or omitted address',
      summary: {
        actionCounts: { create: 0, update: 1, replace: 0, delete: 0, readOnly: 0 },
        addresses: [],
        omittedAddressCount: 0,
      },
    },
    {
      label: 'duplicate address classes',
      summary: {
        actionCounts: { create: 0, update: 2, replace: 0, delete: 0, readOnly: 0 },
        addresses: [{ address: 'aws_s3_bucket.example', actionClasses: ['update', 'update'] }],
        omittedAddressCount: 0,
      },
    },
  ])('rejects a noncanonical summary with $label', ({ summary }) => {
    expect(() => buildTerraformDriftEvidence(driftEvidenceInput({ terraformDetailedExitCode: 2, summary }))).toThrow();
  });
});

it('admits configured production drift identity and rejects a backend from development', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configuredTargets = await import('./index.js');
    const configuredDrift = await import('./terraform-drift.js');
    const production = configuredTargets.resolveAllowedDeploymentTarget('stark-prod/main');
    const context = configuredTargets.renderDeploymentLaneContext({
      target: production,
      lane: 'app',
      accountId: production.accountId,
      requestedControlSourceSha: sourceSha,
      selectedApplicationSourceSha: sourceSha,
      frameworkSourceSha: sourceSha,
    });
    const identity = {
      ...driftIdentity(),
      accountId: production.accountId,
      stateIdentity: context.root.stateIdentity,
      targetConfigurationSha256: context.targetConfigurationSha256,
      backend: {
        bucketName: context.names.terraformStateBucket,
        backendKey: context.root.backendKey,
        kmsKeyArn: `arn:${production.partition}:kms:${production.region}:${production.accountId}:key/11111111-2222-3333-4444-555555555555`,
        region: production.region,
      },
    };
    const input = driftEvidenceInput({ expectedIdentity: identity, observed: identity });
    const evidence = configuredDrift.buildTerraformDriftEvidence(input);
    expect(configuredDrift.validateTerraformDriftEvidence(evidence)).toEqual(evidence);
    expect(evidence.observed).toEqual(identity);
    for (const invalid of [
      { ...identity, backend: driftIdentity()['backend'] },
      { ...identity, stateIdentity: 'stark-dev/develop/app' },
      { ...identity, accountId: target.accountId },
    ]) {
      expect(() => configuredDrift.buildTerraformDriftEvidence({ ...input, observed: invalid })).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
