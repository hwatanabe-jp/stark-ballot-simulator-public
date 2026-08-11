import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from './internal.js';
import { buildSavedPlanReview } from './saved-plan-review.js';

const SOURCE_SHA = 'a'.repeat(40);
const SELECTED_SOURCE_SHA = 'b'.repeat(40);
const TFPLAN_SHA256 = 'c'.repeat(64);
const PLAN_JSON_SHA256 = 'd'.repeat(64);
const ARTIFACT_SHA256 = 'e'.repeat(64);

function appDeploymentAuthority() {
  return {
    authorityType: 'app-deployment' as const,
    deploymentMode: 'rollback' as const,
    selectedSourceSha: SELECTED_SOURCE_SHA,
    deploymentId: `dep_${'1'.repeat(32)}`,
    appDeploymentRecord: {
      key: 'artifacts/app/deployments/exact-app-deployment-record.json',
      versionId: 'opaque.App_Deployment_Version-1',
      sha256: '1'.repeat(64),
    },
    selectedProverSelector: 'accepted' as const,
    expectedImageId: `0x${'2'.repeat(64)}`,
    methodVersion: 14,
    imageIdVariant: 'default' as const,
    imageIdMappingSha256: '3'.repeat(64),
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    toolchainImageDigest: `sha256:${'5'.repeat(64)}`,
    proverReleaseRecord: {
      key: 'artifacts/prover/exact-release/manifest.json',
      versionId: 'opaque.Prover_Record_Version-1',
      sha256: '6'.repeat(64),
    },
    toolchainArtifactRecord: {
      key: 'artifacts/toolchain/exact-release/manifest.json',
      versionId: 'opaque.Toolchain_Record_Version-1',
      sha256: '7'.repeat(64),
    },
    lambdaSourceSha: SELECTED_SOURCE_SHA,
    lambdaCount: 6 as const,
    lambdaSetSha256: '8'.repeat(64),
    verifierFunctionVersion: '28',
  };
}

function appVerifierPreflightAuthority() {
  return {
    authorityType: 'app-verifier-preflight' as const,
    packageSourceSha: SOURCE_SHA,
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    package: {
      key: 'artifacts/app/verifier/exact-package.zip',
      versionId: 'opaque.Verifier_Package_Version-1',
      sha256: '9'.repeat(64),
    },
    sourceCodeHash: Buffer.alloc(32, 1).toString('base64'),
    assetManifestSha256: 'a'.repeat(64),
    trustRootSha256: 'b'.repeat(64),
    liveFunctionVersion: '28',
    liveAliasFunctionVersion: '28',
    liveAuthoritySha256: 'c'.repeat(64),
  };
}

function reviewInput() {
  return {
    context: {
      accountId: '123456789012',
      backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
      deploymentEnvironment: 'develop',
      gate: 'terraform' as 'terraform' | 'verifier-preflight',
      lane: 'app' as 'app' | 'bootstrap' | 'foundation',
      pipelineExecutionId: '11111111-2222-3333-4444-555555555555',
      region: 'ap-northeast-1',
      sourceSha: SOURCE_SHA,
      stateIdentity: 'stark-dev/develop/app',
    },
    artifact: {
      bucket: 'stark-ballot-app-plan-artifacts',
      key: 'pipeline/PlanOutput/exact-artifact.zip',
      versionId: 'opaque.Version_Id-1',
      sha256: ARTIFACT_SHA256,
    },
    state: {
      bucket: 'stark-ballot-terraform-state',
      key: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
      versionId: 'opaque.State_Version-1',
      etag: '"0123456789abcdef0123456789abcdef"',
    },
    plan: {
      planJson: {
        format_version: '1.2',
        terraform_version: '1.15.8',
        applyable: true,
        complete: true,
        errored: false,
        deferred_changes: [],
        resource_changes: [
          {
            address: 'aws_lambda_function.target["private-index"]',
            change: {
              actions: ['update'],
              before: {
                memory_size: 128,
                environment: { variables: { PRIVATE_TOKEN: 'private-before-token' } },
                function_name: 'stable-function-name',
                source_code_hash: 'private-old-source-hash',
              },
              after: {
                memory_size: 256,
                environment: { variables: { PRIVATE_TOKEN: 'private-after-token' } },
                function_name: 'stable-function-name',
                source_code_hash: null,
              },
              before_sensitive: { environment: { variables: { PRIVATE_TOKEN: true } } },
              after_sensitive: { environment: { variables: { PRIVATE_TOKEN: true } } },
              after_unknown: { source_code_hash: true },
            },
          },
          {
            address: 'aws_ecs_task_definition.prover',
            change: {
              actions: ['delete', 'create'],
              before: {
                family: 'stable-family',
                container_definitions: 'private-old-container-json',
              },
              after: {
                family: 'stable-family',
                container_definitions: 'private-new-container-json',
              },
              before_sensitive: {},
              after_sensitive: {},
              after_unknown: {},
              replace_paths: [['container_definitions', 0, 'private-container-key'], ['container_definitions']],
            },
          },
          {
            address: 'data.aws_iam_policy_document.target',
            change: {
              actions: ['read'],
              before: null,
              after: {
                statement: [{ resources: ['private-resource-arn'] }],
                json: null,
              },
              before_sensitive: false,
              after_sensitive: {},
              after_unknown: { json: true },
            },
          },
          {
            address: 'aws_s3_bucket.static',
            change: { actions: ['no-op'] },
          },
        ],
        output_changes: {
          deployment_identity: { actions: ['update'] },
          unchanged: { actions: ['no-op'] },
        },
        resource_drift: [
          {
            address: 'aws_iam_role.target["private-index"]',
            change: { actions: ['update'] },
          },
        ],
        checks: [{ status: 'pass' }, { status: 'unknown' }, { status: 'pass' }],
      },
      planJsonSha256: PLAN_JSON_SHA256,
      tfplanSha256: TFPLAN_SHA256,
    },
    approval: {
      deploymentMode: 'rollback' as 'normal' | 'rollback',
      controlSourceSha: SOURCE_SHA,
      selectedSourceSha: SELECTED_SOURCE_SHA,
      accountId: '123456789012',
      deploymentEnvironment: 'develop',
      reviewedPlanChecksum: TFPLAN_SHA256,
    },
    authority: appDeploymentAuthority(),
  };
}

function sourceApprovalInput(lane: 'app' | 'bootstrap' | 'foundation', gate: 'terraform' | 'verifier-preflight') {
  const input = structuredClone(reviewInput());
  const root = lane;
  return {
    ...input,
    context: {
      ...input.context,
      lane,
      gate,
      stateIdentity: `stark-dev/develop/${root}`,
      backendKey: `stark-ballot-simulator/stark-dev/develop/${root}/terraform.tfstate`,
    },
    state: {
      ...input.state,
      key: `stark-ballot-simulator/stark-dev/develop/${root}/terraform.tfstate`,
    },
    plan: {
      ...input.plan,
      planJson: { ...input.plan.planJson, complete: gate === 'terraform' },
    },
    approval: {
      sourceSha: SOURCE_SHA,
      accountId: input.context.accountId,
      deploymentEnvironment: input.context.deploymentEnvironment,
      reviewedPlanChecksum: TFPLAN_SHA256,
    },
    authority: lane === 'app' ? appVerifierPreflightAuthority() : null,
  };
}

function withPlanMutation(mutate: (plan: Record<string, unknown>) => void) {
  const input = structuredClone(reviewInput());
  mutate(input.plan.planJson);
  return input;
}

function setSemanticNoOp(plan: Record<string, unknown>, applyable = false): void {
  plan['applyable'] = applyable;
  plan['resource_changes'] = [
    {
      address: 'aws_s3_bucket.unchanged',
      change: { actions: ['no-op'] },
    },
  ];
  plan['resource_drift'] = [];
  plan['output_changes'] = {
    unchanged: { actions: ['no-op'] },
  };
  plan['checks'] = [{ status: 'pass' }];
}

function changeAt(input: ReturnType<typeof reviewInput>, index: number): Record<string, unknown> {
  const resourceChange = input.plan.planJson.resource_changes[index];
  if (resourceChange === undefined) {
    throw new Error(`Missing test resource change at index ${index}.`);
  }
  return resourceChange.change;
}

function authorityRecord(input: ReturnType<typeof reviewInput>): Record<string, unknown> {
  return input.authority;
}

function buildInvalidSavedPlanReview(value: unknown) {
  return buildSavedPlanReview(value as Parameters<typeof buildSavedPlanReview>[0]);
}

describe('saved Terraform plan review', () => {
  it('builds one deterministic, deeply frozen, redacted App Terraform review', () => {
    const review = buildSavedPlanReview(reviewInput());

    expect(review).toMatchObject({
      reviewType: 'saved-plan-review',
      summary: {
        actionCounts: { create: 0, update: 1, replace: 1, delete: 0, readOnly: 1 },
        changedAddresses: [
          {
            address: 'aws_ecs_task_definition.prover',
            actionClasses: ['replace'],
            changedAttributes: ['container_definitions'],
            sensitiveAttributes: [],
            unknownAttributes: [],
            replacementAttributes: ['container_definitions'],
          },
          {
            address: 'aws_lambda_function.target[*]',
            actionClasses: ['update'],
            changedAttributes: ['environment', 'memory_size', 'source_code_hash'],
            sensitiveAttributes: ['environment'],
            unknownAttributes: ['source_code_hash'],
            replacementAttributes: [],
          },
          {
            address: 'data.aws_iam_policy_document.target',
            actionClasses: ['read-only'],
            changedAttributes: ['json', 'statement'],
            sensitiveAttributes: [],
            unknownAttributes: ['json'],
            replacementAttributes: [],
          },
        ],
        omittedChangedAddressCount: 0,
        outputChanges: {
          count: 1,
          names: ['deployment_identity'],
          omittedNameCount: 0,
        },
        drift: {
          count: 1,
          names: ['aws_iam_role.target[*]'],
          omittedNameCount: 0,
        },
        checkStatusCounts: { pass: 2, unknown: 1, fail: 0, error: 0 },
        deferredChangeCount: 0,
        formatVersion: '1.2',
        terraformVersion: '1.15.8',
        applyable: true,
        complete: true,
        errored: false,
        planJsonSha256: PLAN_JSON_SHA256,
        tfplanSha256: TFPLAN_SHA256,
      },
    });
    expect(review.reviewDigest).toBe(
      canonicalJsonSha256({
        context: review.context,
        artifact: review.artifact,
        state: review.state,
        summary: review.summary,
        approval: review.approval,
        authority: review.authority,
      }),
    );
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(review.summary)).toBe(true);
    expect(Object.isFrozen(review.summary.changedAddresses)).toBe(true);
    expect(Object.isFrozen(review.summary.changedAddresses[0])).toBe(true);
    expect(Object.isFrozen(review.summary.changedAddresses[0]?.changedAttributes)).toBe(true);
    expect(Object.isFrozen(review.state)).toBe(true);
    expect(Object.isFrozen(review.approval)).toBe(true);
    expect(review.authority).toEqual(appDeploymentAuthority());
    if (review.authority?.authorityType !== 'app-deployment') {
      throw new Error('Expected an App deployment authority review.');
    }
    expect(Object.isFrozen(review.authority)).toBe(true);
    expect(Object.isFrozen(review.authority.appDeploymentRecord)).toBe(true);
    expect(JSON.stringify(review)).not.toContain('private-index');
    expect(JSON.stringify(review)).not.toContain('private-before-token');
    expect(JSON.stringify(review)).not.toContain('private-after-token');
    expect(JSON.stringify(review)).not.toContain('private-container-key');
    expect(JSON.stringify(review)).not.toContain('private-resource-arn');
    expect(Object.keys(review).sort()).toEqual([
      'approval',
      'artifact',
      'authority',
      'context',
      'reviewDigest',
      'reviewType',
      'state',
      'summary',
    ]);
  });

  it.each([
    ['bootstrap', 'terraform'],
    ['foundation', 'terraform'],
    ['app', 'verifier-preflight'],
  ] as const)('admits the exact %s/%s source-bound approval gate', (lane, gate) => {
    const review = buildSavedPlanReview(sourceApprovalInput(lane, gate));

    expect(review.context).toMatchObject({ lane, gate, sourceSha: SOURCE_SHA });
    expect(review.summary.complete).toBe(gate === 'terraform');
    expect(review.approval).toEqual({
      sourceSha: SOURCE_SHA,
      accountId: '123456789012',
      deploymentEnvironment: 'develop',
      reviewedPlanChecksum: TFPLAN_SHA256,
    });
    expect(review.authority).toEqual(lane === 'app' ? appVerifierPreflightAuthority() : null);
  });

  it.each([
    ['bootstrap', 'terraform'],
    ['foundation', 'terraform'],
  ] as const)('admits the exact non-applyable semantic no-op for %s/%s', (lane, gate) => {
    const input = sourceApprovalInput(lane, gate);
    setSemanticNoOp(input.plan.planJson);

    const review = buildSavedPlanReview(input);

    expect(review.summary).toMatchObject({
      applyable: false,
      actionCounts: { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 },
      outputChanges: { count: 0 },
      deferredChangeCount: 0,
    });
  });

  it('rejects a non-applyable no-op for the targeted verifier-preflight gate', () => {
    const input = sourceApprovalInput('app', 'verifier-preflight');
    setSemanticNoOp(input.plan.planJson);

    expect(() => buildSavedPlanReview(input)).toThrow(/non-applyable.*selected gate/u);
  });

  it('rejects an applyable plan with no semantic changes', () => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson, true);

    expect(() => buildSavedPlanReview(input)).toThrow(/applyable.*no semantic changes/u);
  });

  it.each(['action_invocations', 'deferred_action_invocations'] as const)(
    'rejects unsupported Terraform %s',
    (field) => {
      const input = reviewInput();
      Reflect.set(input.plan.planJson, field, [{ address: 'action.example.private' }]);

      expect(() => buildSavedPlanReview(input)).toThrow(/action invocations/u);
    },
  );

  it('admits a non-applyable semantic no-op for an App rollback approval', () => {
    const input = reviewInput();
    setSemanticNoOp(input.plan.planJson);

    expect(buildSavedPlanReview(input).summary.applyable).toBe(false);
  });

  it('rejects a non-applyable plan with only an output change', () => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson);
    Reflect.set(input.plan.planJson, 'output_changes', {
      changed: { actions: ['update'] },
    });

    expect(() => buildSavedPlanReview(input)).toThrow(/non-applyable.*semantic changes/u);
  });

  it('rejects a non-applyable plan with only a resource change', () => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson);
    Reflect.set(input.plan.planJson, 'resource_changes', [
      {
        address: 'aws_s3_bucket.changed',
        change: {
          actions: ['update'],
          before: { value: 'before' },
          after: { value: 'after' },
          before_sensitive: {},
          after_sensitive: {},
          after_unknown: {},
        },
      },
    ]);
    expect(() => buildSavedPlanReview(input)).toThrow(/non-applyable.*semantic changes/u);
  });

  it.each([
    [
      'deferred change',
      (plan: Record<string, unknown>) => {
        plan['deferred_changes'] = [{ reason: 'deferred' }];
      },
      /deferred changes/u,
    ],
    [
      'failed check',
      (plan: Record<string, unknown>) => {
        plan['checks'] = [{ status: 'fail' }];
      },
      /failed or errored check/u,
    ],
    [
      'errored plan',
      (plan: Record<string, unknown>) => {
        plan['errored'] = true;
      },
      /execution disposition/u,
    ],
  ] as const)('rejects a non-applyable semantic no-op with a %s', (_label, mutate, error) => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson);
    mutate(input.plan.planJson);

    expect(() => buildSavedPlanReview(input)).toThrow(error);
  });

  it('requires the exact gate-specific authority and binds it into the review digest', () => {
    const appReview = buildSavedPlanReview(reviewInput());
    const preflightReview = buildSavedPlanReview(sourceApprovalInput('app', 'verifier-preflight'));
    const foundationReview = buildSavedPlanReview(sourceApprovalInput('foundation', 'terraform'));

    expect(appReview.authority).toEqual(appDeploymentAuthority());
    expect(preflightReview.authority).toEqual(appVerifierPreflightAuthority());
    expect(foundationReview.authority).toBeNull();
    expect(appReview.reviewDigest).not.toBe(
      canonicalJsonSha256({
        context: appReview.context,
        artifact: appReview.artifact,
        state: appReview.state,
        summary: appReview.summary,
        approval: appReview.approval,
      }),
    );
  });

  it('rejects missing, mismatched, malformed, and widened saved-plan authority', () => {
    const missingAuthority: Record<string, unknown> = { ...reviewInput() };
    delete missingAuthority['authority'];
    const wrongNonAppAuthority = sourceApprovalInput('foundation', 'terraform');
    wrongNonAppAuthority.authority = appVerifierPreflightAuthority();
    const wrongDiscriminator = reviewInput();
    authorityRecord(wrongDiscriminator)['authorityType'] = 'app-verifier-preflight';
    const widened = reviewInput();
    const widenedAuthority = { ...widened.authority, note: 'private-note' };
    const wrongMode = reviewInput();
    authorityRecord(wrongMode)['deploymentMode'] = 'normal';
    const wrongSelectedSource = reviewInput();
    wrongSelectedSource.authority.selectedSourceSha = SOURCE_SHA;
    const wrongLambdaSource = reviewInput();
    wrongLambdaSource.authority.lambdaSourceSha = SOURCE_SHA;
    const wrongLambdaCount = reviewInput();
    authorityRecord(wrongLambdaCount)['lambdaCount'] = 7;
    const malformedPreflight = sourceApprovalInput('app', 'verifier-preflight');
    if (malformedPreflight.authority === null) {
      throw new Error('Expected App verifier preflight authority fixture.');
    }
    malformedPreflight.authority.sourceCodeHash = 'private-invalid-source-code-hash';

    expect(() => buildInvalidSavedPlanReview(missingAuthority)).toThrow(/exact current shape/u);
    expect(() => buildSavedPlanReview(wrongNonAppAuthority)).toThrow(/authority.*null/u);
    expect(() => buildSavedPlanReview(wrongDiscriminator)).toThrow(/authority/u);
    expect(() => buildSavedPlanReview({ ...widened, authority: widenedAuthority })).toThrow(/exact current shape/u);
    expect(() => buildSavedPlanReview(wrongMode)).toThrow(/authority.*approval/u);
    expect(() => buildSavedPlanReview(wrongSelectedSource)).toThrow(/authority.*approval/u);
    expect(() => buildSavedPlanReview(wrongLambdaSource)).toThrow(/Lambda source/u);
    expect(() => buildSavedPlanReview(wrongLambdaCount)).toThrow(/Lambda count/u);
    expect(() => buildSavedPlanReview(malformedPreflight)).toThrow(/source code hash/u);
  });

  it('does not encode a rollout-specific Terraform resource allowlist', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_cloudwatch_log_group.future_reviewed_resource["sensitive-key"]',
          change: {
            actions: ['create'],
            before: null,
            after: { name: 'private-name', retention_in_days: 30 },
            before_sensitive: false,
            after_sensitive: {},
            after_unknown: {},
          },
        },
      ];
      plan['resource_drift'] = [];
    });

    expect(buildSavedPlanReview(input).summary).toMatchObject({
      actionCounts: { create: 1, update: 0, replace: 0, delete: 0, readOnly: 0 },
      changedAddresses: [
        {
          address: 'aws_cloudwatch_log_group.future_reviewed_resource[*]',
          actionClasses: ['create'],
          changedAttributes: ['name', 'retention_in_days'],
          sensitiveAttributes: [],
          unknownAttributes: [],
          replacementAttributes: [],
        },
      ],
    });
  });

  it('ignores empty sensitive metadata for unmaterialized Terraform schema attributes', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_iam_role.report_only',
          change: {
            actions: ['create'],
            before: null,
            after: { name: 'stable-report-only-role' },
            before_sensitive: false,
            after_sensitive: { inline_policy: [], managed_policy_arns: [] },
            after_unknown: { inline_policy: true, managed_policy_arns: true },
          },
        },
      ];
      plan['resource_drift'] = [];
    });

    expect(buildSavedPlanReview(input).summary.changedAddresses).toEqual([
      {
        address: 'aws_iam_role.report_only',
        actionClasses: ['create'],
        changedAttributes: ['name'],
        sensitiveAttributes: [],
        unknownAttributes: ['inline_policy', 'managed_policy_arns'],
        replacementAttributes: [],
      },
    ]);
  });

  it('rejects true sensitive metadata for an unmaterialized attribute', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_iam_role.report_only',
          change: {
            actions: ['create'],
            before: null,
            after: { name: 'stable-report-only-role' },
            before_sensitive: false,
            after_sensitive: { private_missing_attribute: true },
            after_unknown: { private_missing_attribute: true },
          },
        },
      ];
      plan['resource_drift'] = [];
    });

    expect(() => buildSavedPlanReview(input)).toThrow(/sensitive attribute metadata does not match/u);
  });

  it('rejects a plan whose changed resource addresses cannot all be shown', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = Array.from({ length: 101 }, (_, index) => ({
        address: `aws_s3_bucket.changed_${String(index).padStart(3, '0')}`,
        change: {
          actions: ['update'],
          before: { force_destroy: false },
          after: { force_destroy: true },
          before_sensitive: {},
          after_sensitive: {},
          after_unknown: {},
        },
      }));
      plan['resource_drift'] = [];
    });

    expect(() => buildSavedPlanReview(input)).toThrow('Saved-plan review cannot omit changed resource addresses.');
  });

  it('rejects a plan whose changed output names cannot all be shown', () => {
    const input = withPlanMutation((plan) => {
      plan['output_changes'] = Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [
          `changed_output_${String(index).padStart(3, '0')}`,
          { actions: ['update'] },
        ]),
      );
    });

    expect(() => buildSavedPlanReview(input)).toThrow('Saved-plan review cannot omit changed output names.');
  });

  it('rejects a plan whose drift addresses cannot all be shown', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_drift'] = Array.from({ length: 101 }, (_, index) => ({
        address: `aws_iam_role.drifted_${String(index).padStart(3, '0')}`,
        change: { actions: ['update'] },
      }));
    });

    expect(() => buildSavedPlanReview(input)).toThrow('Saved-plan review cannot omit drift addresses.');
  });

  it('summarizes meaningful top-level attributes for create, delete, and read actions', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_s3_bucket.created["private-create-key"]',
          change: {
            actions: ['create'],
            before: null,
            after: { tags: { PrivateTag: 'private-tag-value' }, bucket: 'private-bucket-name' },
            before_sensitive: false,
            after_sensitive: {},
            after_unknown: {},
          },
        },
        {
          address: 'aws_s3_bucket.deleted["private-delete-key"]',
          change: {
            actions: ['delete'],
            before: { tags: { PrivateTag: 'private-tag-value' }, bucket: 'private-bucket-name' },
            after: null,
            before_sensitive: {},
            after_sensitive: false,
            after_unknown: false,
          },
        },
        {
          address: 'data.aws_iam_policy_document.read["private-read-key"]',
          change: {
            actions: ['read'],
            before: null,
            after: { json: null, statement: [{ sid: 'private-statement-id' }] },
            before_sensitive: false,
            after_sensitive: {},
            after_unknown: { json: true },
          },
        },
      ];
      plan['resource_drift'] = [];
    });

    const review = buildSavedPlanReview(input);

    expect(review.summary.changedAddresses).toEqual([
      {
        address: 'aws_s3_bucket.created[*]',
        actionClasses: ['create'],
        changedAttributes: ['bucket', 'tags'],
        sensitiveAttributes: [],
        unknownAttributes: [],
        replacementAttributes: [],
      },
      {
        address: 'aws_s3_bucket.deleted[*]',
        actionClasses: ['delete'],
        changedAttributes: ['bucket', 'tags'],
        sensitiveAttributes: [],
        unknownAttributes: [],
        replacementAttributes: [],
      },
      {
        address: 'data.aws_iam_policy_document.read[*]',
        actionClasses: ['read-only'],
        changedAttributes: ['json', 'statement'],
        sensitiveAttributes: [],
        unknownAttributes: ['json'],
        replacementAttributes: [],
      },
    ]);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain('private-create-key');
    expect(serialized).not.toContain('private-delete-key');
    expect(serialized).not.toContain('private-read-key');
    expect(serialized).not.toContain('private-tag-value');
    expect(serialized).not.toContain('private-bucket-name');
    expect(serialized).not.toContain('private-statement-id');
  });

  it('rejects malformed dynamic attribute metadata and overbound top-level summaries', () => {
    const dynamic = reviewInput();
    Object.defineProperty(changeAt(dynamic, 0), 'after_unknown', {
      enumerable: true,
      get: () => ({ source_code_hash: true }),
    });
    const proxied = reviewInput();
    const proxiedChange = changeAt(proxied, 0);
    proxiedChange['after'] = new Proxy(proxiedChange['after'] as object, {});
    const malformedUnknown = structuredClone(reviewInput());
    changeAt(malformedUnknown, 0)['after_unknown'] = {
      source_code_hash: 'private-dynamic-marker',
    };
    const malformedReplacementPath = structuredClone(reviewInput());
    changeAt(malformedReplacementPath, 1)['replace_paths'] = [['container_definitions', -1, 'private-container-key']];
    const overbound = structuredClone(reviewInput());
    const overboundChange = changeAt(overbound, 0);
    overboundChange['after'] = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`attribute_${String(index).padStart(3, '0')}`, index]),
    );
    overboundChange['after_sensitive'] = {};
    overboundChange['after_unknown'] = {};

    expect(() => buildSavedPlanReview(dynamic)).toThrow(/attribute metadata/u);
    expect(() => buildSavedPlanReview(proxied)).toThrow(/attribute metadata/u);
    expect(() => buildSavedPlanReview(malformedUnknown)).toThrow(/unknown attribute metadata/u);
    expect(() => buildSavedPlanReview(malformedReplacementPath)).toThrow(/replacement path/u);
    expect(() => buildSavedPlanReview(overbound)).toThrow(/attribute summary.*bound/u);
  });

  it.each([
    [
      'wrong format version',
      (plan: Record<string, unknown>) => {
        plan['format_version'] = '1.1';
      },
      /reviewed runtime/u,
    ],
    [
      'wrong Terraform version',
      (plan: Record<string, unknown>) => {
        plan['terraform_version'] = '1.15.5';
      },
      /reviewed runtime/u,
    ],
    [
      'non-applyable plan with semantic changes',
      (plan: Record<string, unknown>) => {
        plan['applyable'] = false;
      },
      /non-applyable.*semantic changes/u,
    ],
    [
      'errored plan',
      (plan: Record<string, unknown>) => {
        plan['errored'] = true;
      },
      /execution disposition/u,
    ],
    [
      'deferred changes',
      (plan: Record<string, unknown>) => {
        plan['deferred_changes'] = [{ reason: 'deferred' }];
      },
      /deferred changes/u,
    ],
    [
      'unsupported action sequence',
      (plan: Record<string, unknown>) => {
        plan['resource_changes'] = [{ address: 'aws_s3_bucket.invalid', change: { actions: ['create', 'update'] } }];
      },
      /supported Terraform action sequence/u,
    ],
    [
      'resource move',
      (plan: Record<string, unknown>) => {
        plan['resource_changes'] = [
          {
            address: 'aws_s3_bucket.current',
            previous_address: 'aws_s3_bucket.previous',
            change: { actions: ['no-op'] },
          },
        ];
      },
      /move or import/u,
    ],
    [
      'resource import',
      (plan: Record<string, unknown>) => {
        plan['resource_changes'] = [
          {
            address: 'aws_s3_bucket.imported',
            change: { actions: ['no-op'], importing: { id: 'private-id' } },
          },
        ];
      },
      /move or import/u,
    ],
    [
      'failed check',
      (plan: Record<string, unknown>) => {
        plan['checks'] = [{ status: 'fail' }];
      },
      /failed or errored check/u,
    ],
    [
      'errored check',
      (plan: Record<string, unknown>) => {
        plan['checks'] = [{ status: 'error' }];
      },
      /failed or errored check/u,
    ],
  ] as const)('rejects %s', (_label, mutate, error) => {
    expect(() => buildSavedPlanReview(withPlanMutation(mutate))).toThrow(error);
  });

  it('requires targeted and complete gates to use their exact Terraform completion disposition', () => {
    const targeted = sourceApprovalInput('app', 'verifier-preflight');
    targeted.plan.planJson.complete = true;
    const full = reviewInput();
    full.plan.planJson.complete = false;

    expect(() => buildSavedPlanReview(targeted)).toThrow(/execution disposition/u);
    expect(() => buildSavedPlanReview(full)).toThrow(/execution disposition/u);
  });

  it('rejects unsupported lane/gate pairs and noncanonical state/backend coordinates', () => {
    const unsupported = sourceApprovalInput('bootstrap', 'terraform');
    unsupported.context.gate = 'verifier-preflight';
    unsupported.plan.planJson.complete = false;
    const wrongState = structuredClone(reviewInput());
    wrongState.context.stateIdentity = 'stark-dev/develop/foundation';
    const wrongBackend = structuredClone(reviewInput());
    wrongBackend.context.backendKey = 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate';

    expect(() => buildSavedPlanReview(unsupported)).toThrow(/not supported/u);
    expect(() => buildSavedPlanReview(wrongState)).toThrow(/state identity/u);
    expect(() => buildSavedPlanReview(wrongBackend)).toThrow(/backend key/u);
  });

  it('binds an exact immutable artifact and rejects unknown input or approval fields', () => {
    const unversioned = structuredClone(reviewInput());
    unversioned.artifact.versionId = 'null';
    const extraInput = { ...reviewInput(), rawPlan: 'secret' };
    const extraApproval = reviewInput();
    const approvalWithNote = { ...extraApproval.approval, note: 'free form' };

    expect(() => buildSavedPlanReview(unversioned)).toThrow(/VersionId/u);
    expect(() => buildSavedPlanReview(extraInput)).toThrow(/exact current shape/u);
    expect(() => buildSavedPlanReview({ ...extraApproval, approval: approvalWithNote })).toThrow(
      /exact current shape/u,
    );
  });

  it('binds the exact current backend state object and rejects mismatched or unbounded coordinates', () => {
    const wrongKey = structuredClone(reviewInput());
    wrongKey.state.key = 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate';
    const unversioned = structuredClone(reviewInput());
    unversioned.state.versionId = 'null';
    const invalidEtag = structuredClone(reviewInput());
    invalidEtag.state.etag = `"${'a'.repeat(1_025)}"`;

    expect(buildSavedPlanReview(reviewInput()).state).toEqual(reviewInput().state);
    expect(() => buildSavedPlanReview(wrongKey)).toThrow(/state key/u);
    expect(() => buildSavedPlanReview(unversioned)).toThrow(/VersionId/u);
    expect(() => buildSavedPlanReview(invalidEtag)).toThrow(/ETag/u);
  });

  it('rejects approval target, source, and checksum mismatches', () => {
    const wrongTarget = structuredClone(reviewInput());
    wrongTarget.approval.accountId = '000000000000';
    const wrongSource = structuredClone(reviewInput());
    wrongSource.approval.controlSourceSha = 'f'.repeat(40);
    const wrongChecksum = structuredClone(reviewInput());
    wrongChecksum.approval.reviewedPlanChecksum = 'f'.repeat(64);
    const invalidNormalSelection = structuredClone(reviewInput());
    invalidNormalSelection.approval.deploymentMode = 'normal';

    expect(() => buildSavedPlanReview(wrongTarget)).toThrow(/approval does not match/u);
    expect(() => buildSavedPlanReview(wrongSource)).toThrow(/source authority/u);
    expect(() => buildSavedPlanReview(wrongChecksum)).toThrow(/approval does not match/u);
    expect(() => buildSavedPlanReview(invalidNormalSelection)).toThrow(/source authority/u);
  });
});
