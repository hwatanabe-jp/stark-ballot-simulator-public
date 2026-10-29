import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TerraformDriftResult, TerraformDriftSummary } from './terraform-drift.js';
import {
  MAX_REDACTED_TERRAFORM_ADDRESSES,
  classifyTerraformActionSequence,
  classifyTerraformDetailedExitCode,
  redactTerraformResourceAddress,
  summarizeTerraformPlan,
  validateTerraformDriftSummary,
} from './terraform-drift.js';

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
  });
});
