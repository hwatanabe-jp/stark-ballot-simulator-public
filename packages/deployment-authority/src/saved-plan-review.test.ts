import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJsonSha256 } from './internal.js';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from './foundation-contract.js';
import {
  assertFoundationInitialStateObjectNeverPublished,
  buildSavedPlanReview,
  foundationInitialStateObjects,
  isInitialFoundationPlan,
} from './saved-plan-review.js';
import { buildSavedPlanFixture } from './testdata/saved-plan-fixture.js';
import { admitSavedPlanReviewContext, buildSavedPlanSemanticReview } from './saved-plan-semantic-review.js';
import { MAX_SAVED_PLAN_REVIEW_ADDRESSES } from './terraform-drift.js';

const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const APP = resolveDeploymentLaneAuthority(TARGET, 'app');

const SOURCE_SHA = 'a'.repeat(40);
const SELECTED_SOURCE_SHA = 'b'.repeat(40);
const TFPLAN_SHA256 = 'c'.repeat(64);
const PLAN_JSON_SHA256 = 'd'.repeat(64);
const ARTIFACT_SHA256 = 'e'.repeat(64);

describe('first production Foundation saved-plan review', () => {
  function initialInput() {
    const fixture = buildSavedPlanFixture({
      targetKey: 'stark-prod/main',
      lane: 'foundation',
      foundationInitial: true,
    });
    return {
      context: fixture.review.context,
      artifact: fixture.review.artifact,
      state: fixture.review.state,
      approval: fixture.review.approval,
      authority: fixture.review.authority,
      plan: {
        planJson: JSON.parse(Buffer.from(fixture.correspondence.files.tfplanJson).toString()) as Record<
          string,
          unknown
        >,
        planJsonSha256: fixture.review.summary.planJsonSha256,
        tfplanSha256: fixture.review.summary.tfplanSha256,
      },
    };
  }

  it('binds uncreated state to managed creates with freshly refreshed data and planned outputs', () => {
    const input = initialInput();
    expect(buildSavedPlanReview(input, 'stark-prod/main').state).toEqual(input.state);
    const noPrior = { ...input.plan.planJson };
    delete noPrior['prior_state'];
    expect(isInitialFoundationPlan(noPrior, input.context, 'stark-prod/main')).toBe(true);
    expect(() =>
      buildSavedPlanReview(
        { ...input, state: { ...input.state, versionId: 'existing', etag: '"existing"' } },
        'stark-prod/main',
      ),
    ).toThrow('uncreated');
    const malformed = { ...input, state: { ...input.state } };
    Object.assign(malformed.state, { versionId: 'existing', etag: null });
    expect(() => buildSavedPlanReview(malformed, 'stark-prod/main')).toThrow('uncreated');
  });

  it('rejects prior outputs unless their complete planned values are known, nonsecret creates from null', () => {
    const input = initialInput();
    const base = input.plan.planJson;
    const prior = base['prior_state'] as { values: Record<string, unknown> };
    const outputs = prior.values['outputs'] as Record<string, Record<string, unknown>>;
    const name = 'foundation_state_identity';
    const output = outputs[name];
    const planned = base['planned_values'] as Record<string, unknown>;
    const changes = base['output_changes'] as Record<string, Record<string, unknown>>;
    const change = changes[name];
    if (output === undefined || change === undefined) throw new Error('Known output fixture is missing.');
    const withPriorOutput = (value: unknown) => ({
      ...base,
      prior_state: { ...prior, values: { ...prior.values, outputs: { [name]: value } } },
    });
    const rejected: Record<string, unknown>[] = [
      withPriorOutput(null),
      withPriorOutput({ sensitive: false, type: 'string' }),
      withPriorOutput({ ...output, extra: true }),
      withPriorOutput({ ...output, sensitive: true }),
      withPriorOutput({ ...output, value: 'previous-value' }),
      withPriorOutput({ ...output, type: 'bool' }),
      { ...base, planned_values: null },
      { ...base, planned_values: { ...planned, outputs: {} } },
      { ...base, planned_values: { ...planned, outputs: { [name]: { ...output, value: 'different' } } } },
      { ...base, output_changes: {} },
      ...[
        { actions: ['update'] },
        { actions: ['no-op'] },
        { before: output['value'] },
        { after: 'different' },
        { after_unknown: true },
        { after_unknown: {} },
        { before_sensitive: true },
        { after_sensitive: true },
      ].map((override) => ({ ...base, output_changes: { ...changes, [name]: { ...change, ...override } } })),
    ];
    for (const plan of rejected) expect(isInitialFoundationPlan(plan, input.context, 'stark-prod/main')).toBe(false);
    expect(
      isInitialFoundationPlan(
        { ...base, prior_state: { ...prior, values: { ...prior.values, outputs: {} } } },
        input.context,
        'stark-prod/main',
      ),
    ).toBe(true);
  });

  it('never reclassifies existing, incomplete, destructive, or malformed plans as first construction', () => {
    const input = initialInput();
    const base = input.plan.planJson;
    const create = (base['resource_changes'] as Record<string, unknown>[])[0];
    if (create === undefined) throw new Error('Initial Foundation fixture must contain a managed create.');
    const change = create['change'] as Record<string, unknown>;
    const data = { address: 'data.aws_caller_identity.current', mode: 'data' };
    const rejected: Record<string, unknown>[] = [
      { ...base, applyable: false },
      { ...base, complete: false },
      { ...base, errored: true },
      { ...base, resource_changes: [] },
      { ...base, resource_changes: [{ ...data, change: { actions: ['read'], before: null } }] },
      ...[['update'], ['delete'], ['no-op'], ['delete', 'create']].map((actions) => ({
        ...base,
        resource_changes: [{ ...create, change: { ...change, actions } }],
      })),
      { ...base, resource_changes: [{ ...create, change: { ...change, before: {} } }] },
      { ...base, resource_changes: [{ ...create, previous_address: 'aws_s3_bucket.retired' }] },
      { ...base, resource_changes: [{ ...create, change: { ...change, importing: { id: 'existing' } } }] },
      { ...base, prior_state: null },
      { ...base, prior_state: { values: { root_module: { resources: [create] } } } },
      { ...base, prior_state: { values: { root_module: { resources: null } } } },
      { ...base, prior_state: { values: { root_module: { resources: [{ ...data, mode: 'unknown' }] } } } },
      { ...base, prior_state: { values: { root_module: { child_modules: [{ resources: [create] }] } } } },
      { ...base, prior_state: { values: { outputs: { retained: { value: 'existing' } } } } },
      { ...base, resource_drift: [create] },
      { ...base, output_changes: { retained: { actions: ['update'], before: {}, after: {} } } },
    ];
    for (const planJson of rejected) {
      expect(isInitialFoundationPlan(planJson, input.context, 'stark-prod/main')).toBe(false);
      expect(() => buildSavedPlanReview({ ...input, plan: { ...input.plan, planJson } }, 'stark-prod/main')).toThrow();
    }
  });

  it('does not weaken existing state requirements for other targets or gates', () => {
    const initial = initialInput();
    for (const options of [
      { targetKey: 'stark-dev/develop', lane: 'foundation' as const },
      { targetKey: 'stark-prod/main', lane: 'bootstrap' as const },
      { targetKey: 'stark-prod/main', lane: 'app' as const },
    ]) {
      const fixture = buildSavedPlanFixture(options);
      expect(isInitialFoundationPlan(initial.plan.planJson, fixture.review.context, options.targetKey)).toBe(false);
      expect(() => buildSavedPlanReview({ ...initial, context: fixture.review.context }, options.targetKey)).toThrow();
    }
  });

  it('requires exact, versioned, never-published state and Foundation acceptance objects', () => {
    const objects = foundationInitialStateObjects('stark-prod/main');
    expect(objects.map(({ kind }) => kind)).toEqual(['state', 'acceptance']);
    expect(() => foundationInitialStateObjects('stark-dev/develop')).toThrow('production-only');
    for (const scope of objects) {
      const versions = {
        Name: scope.bucket,
        Prefix: scope.key,
        MaxKeys: 1,
        IsTruncated: false,
        ...(scope.kind === 'state' ? { Delimiter: '.' } : {}),
      };
      const input = { versioning: { Status: 'Enabled' }, versions };
      expect(assertFoundationInitialStateObjectNeverPublished(input, scope.kind, 'stark-prod/main')).toEqual(scope);
      expect(
        assertFoundationInitialStateObjectNeverPublished(
          { ...input, versions: { ...versions, Versions: [], DeleteMarkers: [], CommonPrefixes: [] } },
          scope.kind,
          'stark-prod/main',
        ),
      ).toEqual(scope);
      for (const override of [
        { Name: 'another-bucket' },
        { Prefix: `${scope.key}/` },
        { MaxKeys: 2 },
        { IsTruncated: true },
        { Versions: [{ VersionId: 'existing' }] },
        { DeleteMarkers: [{ VersionId: 'deleted' }] },
        { CommonPrefixes: [{}] },
        { CommonPrefixes: [{ Prefix: `${scope.key}.tflock` }] },
        { CommonPrefixes: [{ Prefix: `${scope.key}.` }, { Prefix: `${scope.key}.` }] },
        { Versions: null },
        { KeyMarker: 'skipped' },
        { NextVersionIdMarker: 'more' },
        { Delimiter: '/' },
        { Delimiter: null },
        { NextToken: 'more' },
      ]) {
        expect(() =>
          assertFoundationInitialStateObjectNeverPublished(
            { ...input, versions: { ...versions, ...override } },
            scope.kind,
            'stark-prod/main',
          ),
        ).toThrow('empty inventory');
      }
      const withLockHistory = { ...versions, CommonPrefixes: [{ Prefix: `${scope.key}.` }] };
      if (scope.kind === 'state') {
        expect(
          assertFoundationInitialStateObjectNeverPublished(
            { ...input, versions: withLockHistory },
            scope.kind,
            'stark-prod/main',
          ),
        ).toEqual(scope);
        for (const override of [
          { IsTruncated: true },
          { Versions: [{ Key: scope.key, VersionId: 'created' }] },
          { DeleteMarkers: [{ Key: scope.key, VersionId: 'deleted' }] },
          { Delimiter: undefined },
        ]) {
          expect(() =>
            assertFoundationInitialStateObjectNeverPublished(
              { ...input, versions: { ...withLockHistory, ...override } },
              scope.kind,
              'stark-prod/main',
            ),
          ).toThrow();
        }
      } else {
        expect(() =>
          assertFoundationInitialStateObjectNeverPublished(
            { ...input, versions: withLockHistory },
            scope.kind,
            'stark-prod/main',
          ),
        ).toThrow();
      }
      for (const versioning of [{}, { Status: 'Suspended' }, null]) {
        expect(() =>
          assertFoundationInitialStateObjectNeverPublished({ ...input, versioning }, scope.kind, 'stark-prod/main'),
        ).toThrow();
      }
    }
  });
});

function appDeploymentAuthority() {
  return {
    authorityType: 'app-deployment' as const,
    deploymentMode: 'rollback' as const,
    selectedSourceSha: SELECTED_SOURCE_SHA,
    deploymentId: `dep_${'1'.repeat(32)}`,
    appExecutionAuthoritySha256: '1'.repeat(64),
    selectedProverSelector: 'accepted' as const,
    expectedImageId: `0x${'2'.repeat(64)}`,
    methodVersion: 14,
    imageIdVariant: 'default' as const,
    imageIdMappingSha256: '3'.repeat(64),
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    toolchainImageDigest: `sha256:${'5'.repeat(64)}`,
    proverReleaseKey: `artifacts/prover/releases/${'6'.repeat(64)}.json`,
    toolchainReleaseKey: `artifacts/toolchain/releases/${'7'.repeat(64)}.json`,
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
    expectedFunctionVersion: '29',
    reconciliationDesiredSha256: 'c'.repeat(64),
    foundationAcceptance: {
      foundationAcceptanceKey: `accepted-baselines/stark-dev/develop/foundation/acceptances/${'f'.repeat(64)}.json`,
      foundationAcceptedSourceSha: SOURCE_SHA,
      closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
      foundationContractHash: 'd'.repeat(64),
    },
  };
}

function reviewInput() {
  return {
    context: {
      accountId: TARGET.accountId,
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
      bucket: APP.names.artifactBucket,
      key: 'pipeline/PlanOutput/exact-artifact.zip',
      versionId: 'opaque.Version_Id-1',
      sha256: ARTIFACT_SHA256,
    },
    state: {
      bucket: APP.names.terraformStateBucket,
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
      accountId: TARGET.accountId,
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
    artifact: { ...input.artifact, bucket: resolveDeploymentLaneAuthority(TARGET, lane).names.artifactBucket },
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
  return buildSavedPlanReview(value as Parameters<typeof buildSavedPlanReview>[0], 'stark-dev/develop');
}

describe('saved Terraform plan review', () => {
  it('builds the exact plan-time semantic view through the shared Terraform parser', () => {
    const input = reviewInput();
    const fullReview = buildSavedPlanReview(input, 'stark-dev/develop');

    const semanticReview = buildSavedPlanSemanticReview(
      {
        context: input.context,
        plan: input.plan,
        approval: input.approval,
        authority: input.authority,
      },
      'stark-dev/develop',
    );

    expect(semanticReview).toEqual({
      reviewType: 'saved-plan-semantic-review',
      context: fullReview.context,
      summary: fullReview.summary,
      approval: fullReview.approval,
      authority: fullReview.authority,
    });
    expect(Object.isFrozen(semanticReview)).toBe(true);
    expect(Object.isFrozen(semanticReview.summary)).toBe(true);
  });

  it('builds one deterministic, deeply frozen, redacted App Terraform review', () => {
    const review = buildSavedPlanReview(reviewInput(), 'stark-dev/develop');

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
    expect(review.authority.appExecutionAuthoritySha256).toBe('1'.repeat(64));
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
    const review = buildSavedPlanReview(sourceApprovalInput(lane, gate), 'stark-dev/develop');

    expect(review.context).toMatchObject({ lane, gate, sourceSha: SOURCE_SHA });
    expect(review.summary.complete).toBe(gate === 'terraform');
    expect(review.approval).toEqual({
      sourceSha: SOURCE_SHA,
      accountId: TARGET.accountId,
      deploymentEnvironment: 'develop',
      reviewedPlanChecksum: TFPLAN_SHA256,
    });
    expect(review.authority).toEqual(lane === 'app' ? appVerifierPreflightAuthority() : null);
  });

  it('binds Foundation-impact classification into Bootstrap correspondence review only', () => {
    const bootstrap = sourceApprovalInput('bootstrap', 'terraform');
    const resourceChange = bootstrap.plan.planJson.resource_changes[0];
    if (resourceChange === undefined) {
      throw new Error('Bootstrap saved-plan fixture must contain one resource change.');
    }
    resourceChange.address = 'aws_codebuild_project.foundation_terraform_plan[0]';
    const bootstrapReview = buildSavedPlanReview(bootstrap, 'stark-dev/develop');

    expect(bootstrapReview.summary.foundationBootstrapImpact).toEqual({
      changedAddresses: ['aws_codebuild_project.foundation_terraform_plan[*]'],
      changedOutputNames: [],
      impactType: 'foundation-bootstrap-impact',
    });
    expect(
      buildSavedPlanReview(sourceApprovalInput('foundation', 'terraform'), 'stark-dev/develop').summary
        .foundationBootstrapImpact,
    ).toBeNull();
    expect(buildSavedPlanReview(reviewInput(), 'stark-dev/develop').summary.foundationBootstrapImpact).toBeNull();
  });

  it.each([
    ['bootstrap', 'terraform'],
    ['foundation', 'terraform'],
  ] as const)('admits the exact non-applyable semantic no-op for %s/%s', (lane, gate) => {
    const input = sourceApprovalInput(lane, gate);
    setSemanticNoOp(input.plan.planJson);

    const review = buildSavedPlanReview(input, 'stark-dev/develop');

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

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(/non-applyable.*selected gate/u);
  });

  it('rejects an applyable plan with no semantic changes', () => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson, true);

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(/applyable.*no semantic changes/u);
  });

  it.each(['action_invocations', 'deferred_action_invocations'] as const)(
    'rejects unsupported Terraform %s',
    (field) => {
      const input = reviewInput();
      Reflect.set(input.plan.planJson, field, [{ address: 'action.example.private' }]);

      expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(/action invocations/u);
    },
  );

  it('admits a non-applyable semantic no-op for an App rollback approval', () => {
    const input = reviewInput();
    setSemanticNoOp(input.plan.planJson);

    expect(buildSavedPlanReview(input, 'stark-dev/develop').summary.applyable).toBe(false);
  });

  it('rejects a non-applyable plan with only an output change', () => {
    const input = sourceApprovalInput('foundation', 'terraform');
    setSemanticNoOp(input.plan.planJson);
    Reflect.set(input.plan.planJson, 'output_changes', {
      changed: { actions: ['update'] },
    });

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(/non-applyable.*semantic changes/u);
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
    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(/non-applyable.*semantic changes/u);
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

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(error);
  });

  it('requires the exact gate-specific authority and binds it into the review digest', () => {
    const appReview = buildSavedPlanReview(reviewInput(), 'stark-dev/develop');
    const preflightReview = buildSavedPlanReview(sourceApprovalInput('app', 'verifier-preflight'), 'stark-dev/develop');
    const foundationReview = buildSavedPlanReview(sourceApprovalInput('foundation', 'terraform'), 'stark-dev/develop');

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

    const changedFoundation = sourceApprovalInput('app', 'verifier-preflight');
    if (changedFoundation.authority?.authorityType !== 'app-verifier-preflight') {
      throw new Error('Expected App verifier preflight authority fixture.');
    }
    changedFoundation.authority.foundationAcceptance.foundationContractHash = 'e'.repeat(64);
    expect(buildSavedPlanReview(changedFoundation, 'stark-dev/develop').reviewDigest).not.toBe(
      preflightReview.reviewDigest,
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
    const retiredDeploymentRecordBinding = reviewInput();
    const retiredAuthority = authorityRecord(retiredDeploymentRecordBinding);
    delete retiredAuthority['appExecutionAuthoritySha256'];
    retiredAuthority['appDeploymentRecord'] = {
      key: 'artifacts/app/deployments/retired.json',
      versionId: 'retired-version',
      sha256: '1'.repeat(64),
    };
    const malformedPreflight = sourceApprovalInput('app', 'verifier-preflight');
    if (malformedPreflight.authority === null) {
      throw new Error('Expected App verifier preflight authority fixture.');
    }
    malformedPreflight.authority.sourceCodeHash = 'private-invalid-source-code-hash';

    expect(() => buildInvalidSavedPlanReview(missingAuthority)).toThrow(/exact current shape/u);
    expect(() => buildSavedPlanReview(wrongNonAppAuthority, 'stark-dev/develop')).toThrow(/authority.*null/u);
    expect(() => buildSavedPlanReview(wrongDiscriminator, 'stark-dev/develop')).toThrow(/authority/u);
    expect(() => buildSavedPlanReview({ ...widened, authority: widenedAuthority }, 'stark-dev/develop')).toThrow(
      /exact current shape/u,
    );
    expect(() => buildSavedPlanReview(wrongMode, 'stark-dev/develop')).toThrow(/authority.*approval/u);
    expect(() => buildSavedPlanReview(wrongSelectedSource, 'stark-dev/develop')).toThrow(/authority.*approval/u);
    expect(() => buildSavedPlanReview(wrongLambdaSource, 'stark-dev/develop')).toThrow(/Lambda source/u);
    expect(() => buildSavedPlanReview(wrongLambdaCount, 'stark-dev/develop')).toThrow(/Lambda count/u);
    expect(() => buildSavedPlanReview(retiredDeploymentRecordBinding, 'stark-dev/develop')).toThrow(
      /exact current shape/u,
    );
    expect(() => buildSavedPlanReview(malformedPreflight, 'stark-dev/develop')).toThrow(/source code hash/u);
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

    expect(buildSavedPlanReview(input, 'stark-dev/develop').summary).toMatchObject({
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

    expect(buildSavedPlanReview(input, 'stark-dev/develop').summary.changedAddresses).toEqual([
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

  it.each(['create', 'update'] as const)('reports an unknown sensitive value for a resource %s', (action) => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_ssm_parameter.runtime_config["private-key"]',
          change: {
            actions: [action],
            before: action === 'create' ? null : { name: 'private-name', value: 'private-before-value' },
            after: { name: 'private-name' },
            before_sensitive: action === 'create' ? false : { value: true },
            after_sensitive: { value: true },
            after_unknown: { value: true },
          },
        },
      ];
      plan['resource_drift'] = [];
    });

    const review = buildSavedPlanReview(input, 'stark-dev/develop');
    expect(review.summary.changedAddresses).toEqual([
      {
        address: 'aws_ssm_parameter.runtime_config[*]',
        actionClasses: [action],
        changedAttributes: action === 'create' ? ['name'] : ['value'],
        sensitiveAttributes: ['value'],
        unknownAttributes: ['value'],
        replacementAttributes: [],
      },
    ]);
    expect(JSON.stringify(review)).not.toContain('private-');
    const { context, plan, approval, authority } = input;
    expect(buildSavedPlanSemanticReview({ context, plan, approval, authority }, 'stark-dev/develop').summary).toEqual(
      review.summary,
    );
  });

  it.each([{}, { private_missing_attribute: false }, { private_missing_attribute: {} }, { unrelated: true }])(
    'rejects sensitive metadata without a materialized value or true unknown flag: %j',
    (afterUnknown) => {
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
              after_unknown: afterUnknown,
            },
          },
        ];
        plan['resource_drift'] = [];
      });

      expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(
        /sensitive attribute metadata does not match/u,
      );
    },
  );

  it('does not use after-unknown metadata to admit missing before-sensitive values', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = [
        {
          address: 'aws_ssm_parameter.runtime_config',
          change: {
            actions: ['update'],
            before: { name: 'private-name' },
            after: { name: 'private-name' },
            before_sensitive: { value: true },
            after_sensitive: { value: true },
            after_unknown: { value: true },
          },
        },
      ];
    });
    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(
      /sensitive attribute metadata does not match/u,
    );
  });

  it.skipIf(!process.env['SBS_TERRAFORM_TEST_BINARY'])(
    'reviews native Terraform unknown sensitive inputs without retaining their values',
    () => {
      const binary = process.env['SBS_TERRAFORM_TEST_BINARY'];
      if (!binary) throw new Error('Native Terraform test binary is required.');
      const directory = mkdtempSync(path.join(tmpdir(), 'saved-plan-sensitive-'));
      try {
        writeFileSync(
          path.join(directory, 'main.tf'),
          `terraform { required_version = "= 1.15.8" }
resource "terraform_data" "source" { input = "private-native-source" }
resource "terraform_data" "dependent" { input = sensitive(terraform_data.source.output) }
`,
        );
        const run = (...args: string[]) =>
          execFileSync(binary, args, { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        run('init', '-backend=false', '-input=false', '-no-color');
        run('plan', '-input=false', '-no-color', '-out=tfplan');
        const nativePlan = JSON.parse(run('show', '-json', 'tfplan')) as Record<string, unknown>;
        const input = withPlanMutation((plan) => {
          Object.assign(plan, nativePlan);
          plan['resource_drift'] = [];
          plan['output_changes'] = {};
        });
        const review = buildSavedPlanReview(input, 'stark-dev/develop');
        expect(review.summary.changedAddresses).toContainEqual({
          address: 'terraform_data.dependent',
          actionClasses: ['create'],
          changedAttributes: ['triggers_replace'],
          sensitiveAttributes: ['input'],
          unknownAttributes: ['id', 'input', 'output'],
          replacementAttributes: [],
        });
        expect(JSON.stringify(review)).not.toContain('private-native-source');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([101, MAX_SAVED_PLAN_REVIEW_ADDRESSES])('shows all %i changes through the saved-plan limit', (count) => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = Array.from({ length: count }, (_, index) => ({
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

    const review = buildSavedPlanReview(input, 'stark-dev/develop');
    expect(review.summary.changedAddresses).toHaveLength(count);
    expect(review.summary.omittedChangedAddressCount).toBe(0);
    expect(review.summary.changedAddresses.at(-1)).toMatchObject({
      address: `aws_s3_bucket.changed_${String(count - 1).padStart(3, '0')}`,
      changedAttributes: ['force_destroy'],
    });
  });

  it('rejects changes beyond the bounded saved-plan address limit', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_changes'] = Array.from({ length: MAX_SAVED_PLAN_REVIEW_ADDRESSES + 1 }, (_, index) => ({
        address: `aws_s3_bucket.changed_${String(index).padStart(4, '0')}`,
        change: { actions: ['update'] },
      }));
      plan['resource_drift'] = [];
    });
    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(
      'Saved-plan review cannot omit changed resource addresses.',
    );
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

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(
      'Saved-plan review cannot omit changed output names.',
    );
  });

  it('rejects a plan whose drift addresses cannot all be shown', () => {
    const input = withPlanMutation((plan) => {
      plan['resource_drift'] = Array.from({ length: MAX_SAVED_PLAN_REVIEW_ADDRESSES + 1 }, (_, index) => ({
        address: `aws_iam_role.drifted_${String(index).padStart(3, '0')}`,
        change: { actions: ['update'] },
      }));
    });

    expect(() => buildSavedPlanReview(input, 'stark-dev/develop')).toThrow(
      'Saved-plan review cannot omit drift addresses.',
    );
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

    const review = buildSavedPlanReview(input, 'stark-dev/develop');

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

    expect(() => buildSavedPlanReview(dynamic, 'stark-dev/develop')).toThrow(/attribute metadata/u);
    expect(() => buildSavedPlanReview(proxied, 'stark-dev/develop')).toThrow(/attribute metadata/u);
    expect(() => buildSavedPlanReview(malformedUnknown, 'stark-dev/develop')).toThrow(/unknown attribute metadata/u);
    expect(() => buildSavedPlanReview(malformedReplacementPath, 'stark-dev/develop')).toThrow(/replacement path/u);
    expect(() => buildSavedPlanReview(overbound, 'stark-dev/develop')).toThrow(/attribute summary.*bound/u);
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
    expect(() => buildSavedPlanReview(withPlanMutation(mutate), 'stark-dev/develop')).toThrow(error);
  });

  it('requires targeted and complete gates to use their exact Terraform completion disposition', () => {
    const targeted = sourceApprovalInput('app', 'verifier-preflight');
    targeted.plan.planJson.complete = true;
    const full = reviewInput();
    full.plan.planJson.complete = false;

    expect(() => buildSavedPlanReview(targeted, 'stark-dev/develop')).toThrow(/execution disposition/u);
    expect(() => buildSavedPlanReview(full, 'stark-dev/develop')).toThrow(/execution disposition/u);
  });

  it('rejects unsupported lane/gate pairs and noncanonical state/backend coordinates', () => {
    const unsupported = sourceApprovalInput('bootstrap', 'terraform');
    unsupported.context.gate = 'verifier-preflight';
    unsupported.plan.planJson.complete = false;
    const wrongState = structuredClone(reviewInput());
    wrongState.context.stateIdentity = 'stark-dev/develop/foundation';
    const wrongBackend = structuredClone(reviewInput());
    wrongBackend.context.backendKey = 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate';

    expect(() => buildSavedPlanReview(unsupported, 'stark-dev/develop')).toThrow(/not supported/u);
    expect(() => buildSavedPlanReview(wrongState, 'stark-dev/develop')).toThrow(/state identity/u);
    expect(() => buildSavedPlanReview(wrongBackend, 'stark-dev/develop')).toThrow(/backend key/u);
  });

  it('binds an exact immutable artifact and rejects unknown input or approval fields', () => {
    const unversioned = structuredClone(reviewInput());
    unversioned.artifact.versionId = 'null';
    const extraInput = { ...reviewInput(), rawPlan: 'secret' };
    const extraApproval = reviewInput();
    const approvalWithNote = { ...extraApproval.approval, note: 'free form' };

    expect(() => buildSavedPlanReview(unversioned, 'stark-dev/develop')).toThrow(/VersionId/u);
    expect(() => buildSavedPlanReview(extraInput, 'stark-dev/develop')).toThrow(/exact current shape/u);
    expect(() => buildSavedPlanReview({ ...extraApproval, approval: approvalWithNote }, 'stark-dev/develop')).toThrow(
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

    expect(buildSavedPlanReview(reviewInput(), 'stark-dev/develop').state).toEqual(reviewInput().state);
    expect(() => buildSavedPlanReview(wrongKey, 'stark-dev/develop')).toThrow(/state key/u);
    expect(() => buildSavedPlanReview(unversioned, 'stark-dev/develop')).toThrow(/VersionId/u);
    expect(() => buildSavedPlanReview(invalidEtag, 'stark-dev/develop')).toThrow(/ETag/u);
  });

  it('rejects approval target, source, and checksum mismatches', () => {
    const wrongTarget = structuredClone(reviewInput());
    wrongTarget.approval.accountId = TARGET.accountId === '000000000000' ? '111111111111' : '000000000000';
    const wrongSource = structuredClone(reviewInput());
    wrongSource.approval.controlSourceSha = 'f'.repeat(40);
    const wrongChecksum = structuredClone(reviewInput());
    wrongChecksum.approval.reviewedPlanChecksum = 'f'.repeat(64);
    const invalidNormalSelection = structuredClone(reviewInput());
    invalidNormalSelection.approval.deploymentMode = 'normal';

    expect(() => buildSavedPlanReview(wrongTarget, 'stark-dev/develop')).toThrow(/approval does not match/u);
    expect(() => buildSavedPlanReview(wrongSource, 'stark-dev/develop')).toThrow(/source authority/u);
    expect(() => buildSavedPlanReview(wrongChecksum, 'stark-dev/develop')).toThrow(/approval does not match/u);
    expect(() => buildSavedPlanReview(invalidNormalSelection, 'stark-dev/develop')).toThrow(/source authority/u);
  });
});

it('requires an independently selected target for context, semantic review, and artifact review', () => {
  const input = reviewInput();
  const { context, plan, approval, authority } = input;
  for (const targetKey of [undefined, 'unreviewed/main']) {
    expect(() => admitSavedPlanReviewContext(context, targetKey)).toThrow();
    expect(() => buildSavedPlanSemanticReview({ context, plan, approval, authority }, targetKey)).toThrow();
    expect(() => buildSavedPlanReview(input, targetKey)).toThrow();
  }
});

it('binds production reviews to their exact account, lane, backend, and artifact buckets', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const reviews = await import('./saved-plan-review.js');
    const semantics = await import('./saved-plan-semantic-review.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    for (const [lane, gate] of [
      ['bootstrap', 'terraform'],
      ['foundation', 'terraform'],
      ['app', 'terraform'],
      ['app', 'verifier-preflight'],
    ] as const) {
      const selected = targets.resolveDeploymentLaneAuthority(production, lane);
      const base = lane === 'app' && gate === 'terraform' ? reviewInput() : sourceApprovalInput(lane, gate);
      const input = {
        ...base,
        context: {
          ...base.context,
          accountId: production.accountId,
          region: production.region,
          deploymentEnvironment: production.environmentId,
          stateIdentity: selected.stateIdentity,
          backendKey: selected.backendKey,
        },
        artifact: { ...base.artifact, bucket: selected.names.artifactBucket },
        state: { ...base.state, bucket: selected.names.terraformStateBucket, key: selected.backendKey },
        approval: {
          ...base.approval,
          accountId: production.accountId,
          deploymentEnvironment: production.environmentId,
        },
        authority:
          base.authority?.authorityType === 'app-verifier-preflight'
            ? {
                ...base.authority,
                foundationAcceptance: {
                  ...base.authority.foundationAcceptance,
                  foundationAcceptanceKey: base.authority.foundationAcceptance.foundationAcceptanceKey.replace(
                    'stark-dev/develop',
                    'stark-prod/main',
                  ),
                },
              }
            : base.authority,
      };
      const reviewed = reviews.buildSavedPlanReview(input, production.targetKey);
      expect(reviewed.context).toEqual(input.context);
      expect(reviewed.artifact).toEqual(input.artifact);
      expect(reviewed.state).toEqual(input.state);
      expect(reviewed.reviewDigest).toBe(
        canonicalJsonSha256({
          context: reviewed.context,
          artifact: reviewed.artifact,
          state: reviewed.state,
          summary: reviewed.summary,
          approval: reviewed.approval,
          authority: reviewed.authority,
        }),
      );
      expect(() => reviews.buildSavedPlanReview(input, TARGET.targetKey)).toThrow('expected target');
      const { context, plan, approval, authority } = input;
      const semantic = semantics.buildSavedPlanSemanticReview(
        { context, plan, approval, authority },
        production.targetKey,
      );
      expect(semantic.summary).toEqual(reviewed.summary);
      expect(() =>
        semantics.buildSavedPlanSemanticReview({ context, plan, approval, authority }, TARGET.targetKey),
      ).toThrow('expected target');
      for (const changedContext of [
        { ...context, accountId: TARGET.accountId },
        { ...context, region: 'us-east-1' },
        {
          ...context,
          deploymentEnvironment: 'develop',
          stateIdentity: base.context.stateIdentity,
          backendKey: base.context.backendKey,
        },
        { ...context, backendKey: `unreviewed/${context.stateIdentity}/terraform.tfstate` },
        {
          ...context,
          stateIdentity: `unreviewed/main/${lane}`,
          backendKey: `unreviewed/unreviewed/main/${lane}/terraform.tfstate`,
        },
      ]) {
        expect(() => semantics.admitSavedPlanReviewContext(changedContext, production.targetKey)).toThrow();
      }
      for (const changedInput of [
        { ...input, artifact: { ...input.artifact, bucket: base.artifact.bucket } },
        { ...input, state: { ...input.state, bucket: base.state.bucket } },
        { ...input, approval: base.approval },
      ])
        expect(() => reviews.buildSavedPlanReview(changedInput, production.targetKey)).toThrow();
      if (gate === 'verifier-preflight') {
        expect(() =>
          reviews.buildSavedPlanReview({ ...input, authority: base.authority }, production.targetKey),
        ).toThrow();
      }
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
