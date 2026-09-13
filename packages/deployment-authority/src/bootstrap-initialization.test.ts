import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';

const { configuration } = productionConfigurationFixture();
vi.resetModules();
vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
const {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} = await import('./index.js');
const {
  buildBootstrapInitializationPlanReview,
  observeBootstrapInitializationState,
  resolveBootstrapInitializationScope,
  selectBootstrapInitializationInputs,
  admitBootstrapInitializationHandoff,
  assertBootstrapAcceptanceNeverPublished,
  buildBootstrapInitializationInputs,
  assertBootstrapInitializationPlanInputs,
} = await import('./bootstrap-initialization.js');
afterAll(() => {
  vi.doUnmock('../deployment-targets.json');
  vi.resetModules();
});
const {
  createBootstrapInitializationStateFixture,
  createBootstrapInitializationExecutionFixture,
  createBootstrapInitializationHandoffFixture,
} = await import('./test-support/bootstrap-initialization-fixtures');
const TARGET_KEY = 'stark-prod/main';
const target = resolveAllowedDeploymentTarget(TARGET_KEY);
const bootstrapNames = resolveDeploymentLaneAuthority(target, 'bootstrap').names;
const sourceSha = 'a'.repeat(40);
const backendScope = resolveBootstrapInitializationScope('backend', TARGET_KEY);

describe('Bootstrap initialization input derivation', () => {
  function inputFixture() {
    const handoff = createBootstrapInitializationHandoffFixture();
    return {
      context: handoff.request.context,
      phase: 'backend',
      backend: null as unknown,
      operatorInputs: {
        backend_principal_arns: [`arn:aws:iam::${target.accountId}:role/initializer`],
        development_app_public_hostname: 'production.example.invalid',
        development_app_cloudfront_acm_certificate_arn: `arn:aws:acm:us-east-1:${target.accountId}:certificate/11111111-2222-3333-4444-555555555555`,
      },
    };
  }
  it('requires real backend authority before enabling managed lanes', () => {
    const input = inputFixture();
    const backend = buildBootstrapInitializationInputs(input, TARGET_KEY);
    expect(backend.state_kms_key_id).toBeNull();
    expect(backend.enable_development_pipeline).toBe(false);
    input.phase = 'control-plane';
    expect(() => buildBootstrapInitializationInputs(input, TARGET_KEY)).toThrow();
    input.backend = observeBootstrapInitializationState(
      Buffer.from(JSON.stringify(createBootstrapInitializationStateFixture('backend'))),
      'backend',
      TARGET_KEY,
    ).backend;
    const control = buildBootstrapInitializationInputs(input, TARGET_KEY);
    expect(control.state_kms_key_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(control.enable_development_pipeline).toBe(true);
    input.phase = 'backend';
    expect(() => buildBootstrapInitializationInputs(input, TARGET_KEY)).toThrow('existing backend');
  });
  it('binds every evaluated Terraform input before a limited plan is reviewable', () => {
    const request = inputFixture();
    const expected = buildBootstrapInitializationInputs(request, TARGET_KEY);
    const variables = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, { value }]));
    expect(() => assertBootstrapInitializationPlanInputs({ variables }, request, TARGET_KEY)).not.toThrow();
    const key = variables['state_kms_key_id'];
    if (key === undefined) throw new Error('Missing state key fixture');
    key.value = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(() => assertBootstrapInitializationPlanInputs({ variables }, request, TARGET_KEY)).toThrow(
      'state_kms_key_id',
    );
    key.value = null;
    delete variables['source_branch'];
    expect(() => assertBootstrapInitializationPlanInputs({ variables }, request, TARGET_KEY)).toThrow();
  });
  it.each(['aws_account_id', 'control_source_sha', 'state_kms_key_id', 'enable_development_pipeline', 'secret'])(
    'rejects an operator override of %s',
    (name) => {
      const input = inputFixture();
      Object.assign(input.operatorInputs, { [name]: 'unreviewed' });
      expect(() => buildBootstrapInitializationInputs(input, TARGET_KEY)).toThrow();
    },
  );
  it('rejects development and cross-account backend or public inputs', () => {
    const input = inputFixture();
    expect(() => buildBootstrapInitializationInputs(input, 'stark-dev/develop')).toThrow();
    input.operatorInputs.development_app_public_hostname = 'Develop.stark-ballot-sim.hwatanabe.dev';
    expect(() => buildBootstrapInitializationInputs(input, TARGET_KEY)).toThrow('Production requires');
    input.operatorInputs.development_app_public_hostname = 'production.example.invalid';
    input.operatorInputs.backend_principal_arns = [
      `arn:aws:iam::${resolveAllowedDeploymentTarget('stark-dev/develop').accountId}:role/initializer`,
    ];
    expect(() => buildBootstrapInitializationInputs(input, TARGET_KEY)).toThrow('exact target account');
  });
});

type Change = {
  address: string;
  mode: string;
  type: string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    before_sensitive: Record<string, unknown>;
    after_sensitive: Record<string, unknown>;
    after_unknown: Record<string, unknown>;
  };
  previous_address?: string;
};

function fixture(phase: 'backend' | 'control-plane' = 'backend') {
  const scope = resolveBootstrapInitializationScope(phase, TARGET_KEY);
  const changes: Change[] = scope.addresses.map((address) => {
    const existing = phase === 'control-plane' && backendScope.addresses.includes(address);
    const update = existing && (address === 'aws_kms_key.state' || address === 'aws_s3_bucket_policy.state');
    return {
      address,
      mode: 'managed',
      type: address.startsWith('module.') ? 'aws_cloudwatch_log_group' : address.slice(0, address.indexOf('.')),
      change: {
        actions: [update ? 'update' : existing ? 'no-op' : 'create'],
        before: existing ? (update ? { policy: 'old-private-policy' } : {}) : null,
        after: update ? { policy: 'new-private-policy' } : {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    };
  });
  const planJson = {
    format_version: '1.2',
    terraform_version: '1.15.8',
    applyable: true,
    complete: false,
    errored: false,
    resource_changes: changes,
    output_changes: {},
    resource_drift: [] as Change[],
    checks: [{ status: 'pass' }],
    deferred_changes: [] as unknown[],
    action_invocations: [] as unknown[],
    deferred_action_invocations: [] as unknown[],
  };
  return {
    initializationId: '11111111-2222-4333-8444-555555555555',
    phase,
    context: renderDeploymentLaneContext({
      target,
      lane: 'bootstrap',
      accountId: target.accountId,
      requestedControlSourceSha: sourceSha,
      selectedApplicationSourceSha: sourceSha,
      frameworkSourceSha: sourceSha,
    }),
    plan: {
      planJson,
      planJsonSha256: createHash('sha256').update(JSON.stringify(planJson)).digest('hex'),
      tfplanSha256: 'f'.repeat(64),
    },
  };
}

function firstChange(input: ReturnType<typeof fixture>): Change {
  const first = input.plan.planJson.resource_changes[0];
  if (first === undefined) throw new Error('Missing first fixture change.');
  return first;
}

function resourceAt(input: ReturnType<typeof fixture>, address: string): Change {
  const resource = input.plan.planJson.resource_changes.find((item) => item.address === address);
  if (resource === undefined) throw new Error('Missing fixture resource.');
  return resource;
}

describe('bounded Bootstrap initialization plan review', () => {
  it.each(['backend', 'control-plane'] as const)(
    'admits the complete %s resource scope without retaining values',
    (phase) => {
      const input = fixture(phase);
      const review = buildBootstrapInitializationPlanReview(input, TARGET_KEY);
      expect(review.phase).toBe(phase);
      expect(review.summary.complete).toBe(false);
      expect(review.summary.actionCounts.create).toBe(phase === 'backend' ? 11 : 70);
      expect(review.summary.actionCounts.update).toBe(phase === 'backend' ? 0 : 2);
      expect(JSON.stringify(review)).not.toContain('private-policy');
      expect(Object.isFrozen(review)).toBe(true);
      expect(review.reviewSha256).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it('allows only the three Bootstrap projects and one pipeline in the control seed', () => {
    const scope = resolveBootstrapInitializationScope('control-plane', TARGET_KEY);
    expect(scope.addresses.filter((name) => name.startsWith('aws_codebuild_project.'))).toEqual([
      'aws_codebuild_project.bootstrap_smoke[0]',
      'aws_codebuild_project.terraform_apply[0]',
      'aws_codebuild_project.terraform_plan[0]',
    ]);
    expect(scope.addresses.filter((name) => name.startsWith('aws_codepipeline.'))).toEqual([
      'aws_codepipeline.development[0]',
    ]);
    expect(scope.targets).toContain('aws_iam_role_policy.terraform_plan_pipeline_state');
    expect(scope.targets).toContain('aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management');
    expect(scope.targets).toContain('aws_s3_bucket_policy.terraform_authority');
  });

  it.each([undefined, 'stark-dev/develop', 'unknown/main'])('rejects unadmitted initialization target %s', (key) => {
    expect(() => buildBootstrapInitializationPlanReview(fixture(), key)).toThrow();
    expect(() => resolveBootstrapInitializationScope('backend', key)).toThrow();
  });
  it.each([undefined, null, 'full', 'terraform', 'app'])('rejects invalid phase %s', (phase) => {
    expect(() => resolveBootstrapInitializationScope(phase, TARGET_KEY)).toThrow();
  });

  const invalidPlans: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
    [
      'complete full plan',
      (input) => {
        input.plan.planJson.complete = true;
      },
    ],
    [
      'non-applyable plan',
      (input) => {
        input.plan.planJson.applyable = false;
      },
    ],
    [
      'errored plan',
      (input) => {
        input.plan.planJson.errored = true;
      },
    ],
    [
      'wrong runtime',
      (input) => {
        input.plan.planJson.terraform_version = '1.0.0';
      },
    ],
    [
      'deferred resource',
      (input) => {
        input.plan.planJson.deferred_changes = [{}];
      },
    ],
    [
      'action invocation',
      (input) => {
        input.plan.planJson.action_invocations = [{}];
      },
    ],
    [
      'deferred invocation',
      (input) => {
        input.plan.planJson.deferred_action_invocations = [{}];
      },
    ],
    [
      'failed check',
      (input) => {
        input.plan.planJson.checks = [{ status: 'fail' }];
      },
    ],
    [
      'missing resource',
      (input) => {
        input.plan.planJson.resource_changes.pop();
      },
    ],
    [
      'duplicate resource',
      (input) => {
        input.plan.planJson.resource_changes.push(structuredClone(firstChange(input)));
      },
    ],
    [
      'extra App pipeline',
      (input) => {
        firstChange(input).address = 'aws_codepipeline.app[0]';
      },
    ],
    [
      'delete',
      (input) => {
        firstChange(input).change.actions = ['delete'];
      },
    ],
    [
      'replacement',
      (input) => {
        firstChange(input).change.actions = ['delete', 'create'];
      },
    ],
    [
      'existing resource adoption',
      (input) => {
        firstChange(input).change.before = {};
      },
    ],
    [
      'initial no-op',
      (input) => {
        firstChange(input).change.actions = ['no-op'];
      },
    ],
    [
      'absent resulting resource',
      (input) => {
        firstChange(input).change.after = null;
      },
    ],
    [
      'move',
      (input) => {
        firstChange(input).previous_address = 'aws_s3_bucket.predecessor';
      },
    ],
    [
      'import',
      (input) => {
        Object.assign(firstChange(input).change, { importing: { id: 'unowned' } });
      },
    ],
    [
      'drift',
      (input) => {
        const drift = structuredClone(firstChange(input));
        drift.change.actions = ['update'];
        drift.change.before = {};
        drift.change.after = { policy: 'changed' };
        input.plan.planJson.resource_drift = [drift];
      },
    ],
  ];
  it.each(invalidPlans)('rejects %s', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow();
  });

  it('requires the same target and source in the caller context', () => {
    const input = fixture();
    const dev = resolveAllowedDeploymentTarget('stark-dev/develop');
    const otherContext = renderDeploymentLaneContext({
      target: dev,
      lane: 'bootstrap',
      accountId: dev.accountId,
      requestedControlSourceSha: sourceSha,
      selectedApplicationSourceSha: sourceSha,
      frameworkSourceSha: sourceSha,
    });
    expect(() => buildBootstrapInitializationPlanReview({ ...input, context: otherContext }, TARGET_KEY)).toThrow();
    expect(() =>
      buildBootstrapInitializationPlanReview(
        {
          ...input,
          context: { ...input.context, source: { ...input.context.source, frameworkSourceSha: 'b'.repeat(40) } },
        },
        TARGET_KEY,
      ),
    ).toThrow();
  });

  it.each(['aws_kms_key.state', 'aws_s3_bucket_policy.state'])('limits %s updates to policy', (address) => {
    const input = fixture('control-plane');
    const resource = resourceAt(input, address);
    resource.change.after = { policy: 'new-private-policy', unrelated: 'unreviewed' };
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('outside policy');
  });
  it.each(['aws_kms_key.state', 'aws_s3_bucket_policy.state'])(
    'rejects unknown changes outside %s policy',
    (address) => {
      const input = fixture('control-plane');
      resourceAt(input, address).change.after_unknown = { unrelated: true };
      expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('outside policy');
    },
  );
  it.each(['aws_kms_key.state', 'aws_s3_bucket_policy.state', 'aws_s3_bucket.state'])(
    'rejects a false no-op for %s',
    (address) => {
      const input = fixture('control-plane');
      const resource = resourceAt(input, address);
      resource.change.actions = ['no-op'];
      resource.change.before = {};
      resource.change.after = { changed: true };
      expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('identical values');
      resource.change.after = {};
      resource.change.after_unknown = { changed: true };
      expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('no unknown changes');
    },
  );
  it('requires the existing backend state in the control phase', () => {
    const input = fixture('control-plane');
    const bucket = resourceAt(input, 'aws_s3_bucket.state');
    bucket.change.before = null;
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('existing state shape');
  });
  it('rejects changed existing backend attributes', () => {
    const input = fixture('control-plane');
    const bucket = resourceAt(input, 'aws_s3_bucket.state');
    bucket.change.actions = ['update'];
    bucket.change.after = { bucket: 'different' };
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('preserve');
  });
  it.each([
    'data.aws_iam_policy_document.state_bucket',
    'data.aws_iam_policy_document.terraform_plan[0]',
    'data.aws_iam_policy_document.saved_plan_approval_apply_read["app_terraform"]',
    'data.aws_iam_policy_document.saved_plan_approval_apply_read["app_verifier_preflight"]',
    'data.aws_iam_policy_document.saved_plan_approval_apply_read["foundation_terraform"]',
  ])('accepts local policy generation at %s and rejects external discovery', (address) => {
    const input = fixture('control-plane');
    const read: Change = {
      address,
      mode: 'data',
      type: 'aws_iam_policy_document',
      change: {
        actions: ['read'],
        before: null,
        after: {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    };
    input.plan.planJson.resource_changes.push(read);
    expect(buildBootstrapInitializationPlanReview(input, TARGET_KEY).summary.actionCounts.readOnly).toBe(1);
    read.type = 'aws_secretsmanager_secret_version';
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('local IAM');
  });
  it.each([
    'data.aws_iam_policy_document.saved_plan_approval_apply_read["bootstrap_terraform"]',
    'data.aws_iam_policy_document.saved_plan_approval_apply_read["unknown"]',
    'data.aws_iam_policy_document.other["app_terraform"]',
    'data.aws_iam_policy_document.terraform_plan[1]',
    'module.other.data.aws_iam_policy_document.state_bucket',
  ])('rejects an unreviewed indexed policy-document address %s', (address) => {
    const input = fixture('control-plane');
    input.plan.planJson.resource_changes.push({
      address,
      mode: 'data',
      type: 'aws_iam_policy_document',
      change: {
        actions: ['read'],
        before: null,
        after: {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    });
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow('local IAM');
  });
  it('rejects unknown fields and getters before review', () => {
    expect(() => buildBootstrapInitializationPlanReview({ ...fixture(), bypass: true }, TARGET_KEY)).toThrow();
    const input = fixture();
    const getter = vi.fn(() => 'backend');
    Object.defineProperty(input, 'phase', { enumerable: true, get: getter });
    expect(() => buildBootstrapInitializationPlanReview(input, TARGET_KEY)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

const stateFixture = createBootstrapInitializationStateFixture;
function stateResource(input: ReturnType<typeof stateFixture>, type: string, name: string) {
  const resource = input.resources.find((item) => item.type === type && item.name === name);
  const instance = resource?.instances[0];
  if (resource === undefined || instance === undefined) throw new Error('Missing state fixture resource.');
  return { resource, instance };
}
function stateBytes(input: ReturnType<typeof stateFixture>): Buffer {
  return Buffer.from(JSON.stringify(input));
}

describe('initial Bootstrap state metadata', () => {
  it.each(['backend', 'control-plane'] as const)(
    'binds the genuine %s state bytes without retaining the state',
    (phase) => {
      const input = stateFixture(phase);
      const bytes = stateBytes(input);
      const observed = observeBootstrapInitializationState(bytes, phase, TARGET_KEY);
      expect(observed.managedResourceCount).toBe(phase === 'backend' ? 11 : 81);
      expect(observed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(observed.serial).toBe(1);
      expect(observed.lineage).toBe(input.lineage);
      expect(JSON.stringify(observed)).not.toContain('created-resource');
      expect(stateBytes(input)).toEqual(bytes);
    },
  );

  const invalidStates: Array<[string, (input: ReturnType<typeof stateFixture>) => void]> = [
    [
      'wrong state format',
      (input) => {
        input.version = 3;
      },
    ],
    [
      'wrong Terraform version',
      (input) => {
        input.terraform_version = '1.0.0';
      },
    ],
    [
      'invalid lineage',
      (input) => {
        input.lineage = 'not-a-lineage';
      },
    ],
    [
      'unwritten serial',
      (input) => {
        input.serial = 0;
      },
    ],
    [
      'fractional serial',
      (input) => {
        input.serial = 1.5;
      },
    ],
    [
      'missing resource',
      (input) => {
        input.resources.pop();
      },
    ],
    [
      'duplicate resource',
      (input) => {
        const { resource } = stateResource(input, 'aws_s3_bucket', 'state');
        input.resources.push(structuredClone(resource));
      },
    ],
    [
      'foreign resource',
      (input) => {
        stateResource(input, 'aws_s3_bucket', 'state').resource.name = 'unowned';
      },
    ],
    [
      'foreign provider',
      (input) => {
        stateResource(input, 'aws_s3_bucket', 'state').resource.provider = 'unowned';
      },
    ],
    [
      'foreign bucket',
      (input) => {
        stateResource(input, 'aws_s3_bucket', 'state').instance.attributes['bucket'] = 'foreign-bucket';
      },
    ],
    [
      'foreign key',
      (input) => {
        stateResource(input, 'aws_kms_key', 'state').instance.attributes['arn'] =
          'arn:aws:kms:ap-northeast-1:000000000000:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      },
    ],
    [
      'wrong alias',
      (input) => {
        stateResource(input, 'aws_kms_alias', 'state').instance.attributes['name'] = 'alias/foreign';
      },
    ],
    [
      'wrong alias target',
      (input) => {
        stateResource(input, 'aws_kms_alias', 'state').instance.attributes['target_key_id'] =
          '11111111-2222-3333-4444-555555555555';
      },
    ],
    [
      'deposed instance',
      (input) => {
        Object.assign(stateResource(input, 'aws_s3_bucket', 'state').instance, { deposed: 'abcd' });
      },
    ],
    [
      'tainted instance',
      (input) => {
        Object.assign(stateResource(input, 'aws_s3_bucket', 'state').instance, { status: 'tainted' });
      },
    ],
    [
      'foreign index',
      (input) => {
        Object.assign(stateResource(input, 'aws_s3_bucket', 'state').instance, { index_key: 1 });
      },
    ],
    [
      'foreign module',
      (input) => {
        Object.assign(stateResource(input, 'aws_s3_bucket', 'state').resource, { module: 'module.foreign' });
      },
    ],
    [
      'external data',
      (input) => {
        const r = structuredClone(stateResource(input, 'aws_s3_bucket', 'state').resource);
        r.mode = 'data';
        r.type = 'aws_secretsmanager_secret_version';
        input.resources.push(r);
      },
    ],
  ];
  it.each(invalidStates)('rejects %s', (_name, mutate) => {
    const input = stateFixture();
    mutate(input);
    expect(() => observeBootstrapInitializationState(stateBytes(input), 'backend', TARGET_KEY)).toThrow();
  });
  it('does not expose a malformed state fragment in errors or their cause', () => {
    try {
      observeBootstrapInitializationState(Buffer.from('{"private_state_sentinel":'), 'backend', TARGET_KEY);
      throw new Error('Expected malformed state to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('private_state_sentinel');
      expect((error as Error).cause).toBeUndefined();
    }
  });
  it('rejects the development target and an incomplete control state', () => {
    expect(() =>
      observeBootstrapInitializationState(stateBytes(stateFixture()), 'backend', 'stark-dev/develop'),
    ).toThrow();
    expect(() => observeBootstrapInitializationState(stateBytes(stateFixture()), 'control-plane', TARGET_KEY)).toThrow(
      'incomplete',
    );
  });
});

describe('Bootstrap initial input execution selection', () => {
  const context = fixture().context;
  const executionId = '11111111-2222-3333-4444-555555555555';
  const execution = createBootstrapInitializationExecutionFixture;
  const handoff = createBootstrapInitializationHandoffFixture;
  it('binds the complete first input file to its real seed state without retaining state values', () => {
    const input = handoff();
    const admitted = admitBootstrapInitializationHandoff(input.request, input.seedState, TARGET_KEY);
    expect(admitted.nonsecretInputs).toEqual(input.request.manifest.nonsecretInputs);
    expect(admitted.state).toEqual(input.request.manifest.seedState);
    expect(JSON.stringify(admitted)).not.toContain('created-resource');
    expect(() =>
      admitBootstrapInitializationHandoff(input.request, stateBytes(stateFixture('backend')), TARGET_KEY),
    ).toThrow();
  });
  it('rejects changed state bytes or VersionId and manifest checksum mismatch', () => {
    const input = handoff();
    expect(() =>
      admitBootstrapInitializationHandoff(
        { ...input.request, stateVersionId: 'new-version' },
        input.seedState,
        TARGET_KEY,
      ),
    ).toThrow();
    const changedState = stateFixture('control-plane');
    changedState.serial++;
    expect(() => admitBootstrapInitializationHandoff(input.request, stateBytes(changedState), TARGET_KEY)).toThrow();
    input.request.manifest.administratorArn += '-changed';
    expect(() => admitBootstrapInitializationHandoff(input.request, input.seedState, TARGET_KEY)).toThrow();
  });
  it('rejects cross-account input identity even when its manifest digest is self-consistent', () => {
    const input = handoff();
    const file = input.request.manifest.nonsecretInputs.files[0];
    if (file === undefined) throw new Error('Missing fixture inputs.');
    const variables = JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8')) as Record<string, unknown>;
    variables['aws_account_id'] = '000000000000';
    const body = canonicalRecordJson(variables);
    file.contentBase64 = Buffer.from(body).toString('base64');
    file.sha256 = createHash('sha256').update(body).digest('hex');
    input.request.executionResponse.pipelineExecution.variables[3] = {
      name: 'BootstrapInitializationSha256',
      resolvedValue: createHash('sha256').update(canonicalRecordJson(input.request.manifest)).digest('hex'),
    };
    expect(() => admitBootstrapInitializationHandoff(input.request, input.seedState, TARGET_KEY)).toThrow();
  });
  it('requires exact source, execution, explicit administrator start, and immutable selection', () => {
    const input = execution();
    expect(selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toEqual({
      mode: 'initial',
      initializationId: fixture().initializationId,
      pipelineExecutionId: executionId,
      administratorArn: input.pipelineExecution.trigger.triggerDetail,
      manifest: {
        key: `initializations/bootstrap/${fixture().initializationId}.json`,
        versionId: '+opaque.version/value',
        sha256: 'c'.repeat(64),
      },
    });
  });
  it('admits an explicit administrator initialization when AWS omits executionType', () => {
    const input = execution();
    const expected = selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY);
    Reflect.deleteProperty(input.pipelineExecution, 'executionType');
    expect(selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toEqual(expected);
    expect(Object.hasOwn(input.pipelineExecution, 'executionType')).toBe(false);
    const initialized = handoff();
    Reflect.deleteProperty(initialized.request.executionResponse.pipelineExecution, 'executionType');
    expect(() =>
      admitBootstrapInitializationHandoff(initialized.request, initialized.seedState, TARGET_KEY),
    ).not.toThrow();
  });
  it.each([
    { rollbackMetadata: {} },
    { trigger: { triggerType: 'RollbackStage', triggerDetail: 'unreviewed' } },
    { trigger: { triggerType: 'CreatePipeline' } },
    { status: 'Succeeded' },
  ])('rejects an invalid initialization even when executionType is omitted %#', (overrides) => {
    const input = execution();
    Reflect.deleteProperty(input.pipelineExecution, 'executionType');
    Object.assign(input.pipelineExecution, overrides);
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toThrow();
  });
  it('admits ordinary accepted inputs only with all initial selectors explicitly disabled', () => {
    const input = execution();
    input.pipelineExecution.trigger.triggerType = 'CreatePipeline';
    input.pipelineExecution.variables = input.pipelineExecution.variables.map(({ name }) => ({
      name,
      resolvedValue: name === 'BootstrapInputMode' ? 'accepted' : 'disabled',
    }));
    expect(selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toBeNull();
    input.pipelineExecution.variables[1] = {
      name: 'BootstrapInitializationId',
      resolvedValue: fixture().initializationId,
    };
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toThrow();
  });
  it.each([
    { pipelineName: 'unrelated-pipeline' },
    { pipelineExecutionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { status: 'Succeeded' },
    { executionType: 'ROLLBACK' },
    { executionType: null },
    { executionType: 'unknown' },
    { executionType: '' },
    { rollbackMetadata: {} },
    { artifactRevisions: [{ name: 'SourceOutput', revisionId: 'b'.repeat(40) }] },
    { artifactRevisions: [] },
    { trigger: { triggerType: 'CreatePipeline' } },
    {
      trigger: {
        triggerType: 'StartPipelineExecution',
        triggerDetail: `arn:aws:sts::${target.accountId}:assumed-role/operator/reviewer`,
      },
    },
    {
      trigger: {
        triggerType: 'StartPipelineExecution',
        triggerDetail:
          'arn:aws:sts::000000000000:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/reviewer',
      },
    },
    { variables: [] },
  ])('rejects detached or implicit execution %#', (overrides) => {
    const input = execution();
    Object.assign(input.pipelineExecution, overrides);
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toThrow();
  });
  it.each([
    ['BootstrapInputMode', 'unreviewed'],
    ['BootstrapInitializationId', 'disabled'],
    ['BootstrapInitializationVersionId', 'null'],
    ['BootstrapInitializationSha256', 'disabled'],
  ])('rejects invalid selector %s', (name, resolvedValue) => {
    const input = execution();
    input.pipelineExecution.variables = input.pipelineExecution.variables.map((entry) =>
      entry.name === name ? { name, resolvedValue } : entry,
    );
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toThrow();
  });
  it('rejects duplicated variables and a different independently selected target', () => {
    const input = execution();
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, 'stark-dev/develop')).toThrow();
    input.pipelineExecution.variables[1] = { name: 'BootstrapInputMode', resolvedValue: 'initial' };
    expect(() => selectBootstrapInitializationInputs(input, context, executionId, TARGET_KEY)).toThrow();
  });
});

describe('Bootstrap first-publication inventory', () => {
  const inventory = {
    Name: bootstrapNames.terraformAuthorityBucket,
    Prefix: `${bootstrapNames.terraformBaselinePrefix}/${fixture().context.root.stateIdentity}/current.json`,
    IsTruncated: false,
    MaxKeys: 1,
  };
  it('admits only an empty unpaginated exact-prefix observation', () => {
    expect(() => assertBootstrapAcceptanceNeverPublished(inventory, TARGET_KEY)).not.toThrow();
    expect(() =>
      assertBootstrapAcceptanceNeverPublished(
        { ...inventory, Versions: [], DeleteMarkers: [], KeyMarker: '', VersionIdMarker: '' },
        TARGET_KEY,
      ),
    ).not.toThrow();
  });
  it.each(['', 'url'])('admits an empty exact-prefix response with encoding %j', (EncodingType) => {
    expect(() =>
      assertBootstrapAcceptanceNeverPublished(
        { ...inventory, KeyMarker: '', VersionIdMarker: '', EncodingType },
        TARGET_KEY,
      ),
    ).not.toThrow();
  });
  it.each([
    { EncodingType: null },
    { EncodingType: 'unknown' },
    { EncodingType: 'url', Prefix: inventory.Prefix.replaceAll('/', '%2F') },
    { EncodingType: 'url', Versions: [{}] },
    { EncodingType: 'url', DeleteMarkers: [{}] },
    { EncodingType: 'url', CommonPrefixes: [{}] },
    { EncodingType: 'url', IsTruncated: true },
    { EncodingType: 'url', NextKeyMarker: 'hidden-next-page' },
  ])('rejects invalid encoding or nonempty encoded inventory %#', (overrides) => {
    expect(() => assertBootstrapAcceptanceNeverPublished({ ...inventory, ...overrides }, TARGET_KEY)).toThrow();
  });
  it.each([
    undefined,
    {},
    { ...inventory, Name: 'unrelated-bucket' },
    { ...inventory, Prefix: 'unrelated-prefix' },
    { ...inventory, IsTruncated: true },
    { ...inventory, MaxKeys: 0 },
    { ...inventory, Versions: [{}] },
    { ...inventory, DeleteMarkers: [{}] },
    { ...inventory, CommonPrefixes: [{}] },
    { ...inventory, Versions: null },
    { ...inventory, NextKeyMarker: 'hidden-next-page' },
  ])('rejects a missing, hidden, or existing history %#', (value) => {
    expect(() => assertBootstrapAcceptanceNeverPublished(value, TARGET_KEY)).toThrow();
  });
});
