import { describe, expect, it } from 'vitest';
import {
  admitBootstrapRecoveryHandoff,
  admitBootstrapRecoveryMaterial,
  assertBootstrapRecoveryPlan,
  selectFailedBootstrapApplyActions,
} from './bootstrap-initialization-recovery.js';
import {
  admitBootstrapInitializationHandoff,
  observeBootstrapInitializationState,
} from './bootstrap-initialization.js';
import { createBootstrapRecoveryFixture } from './test-support/bootstrap-recovery-fixtures.js';

const target = 'stark-prod/main';
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture value.');
  return value;
}
function admit(fixture: ReturnType<typeof createBootstrapRecoveryFixture>) {
  return admitBootstrapRecoveryHandoff(
    fixture.request,
    fixture.stateBytes,
    fixture.seedBytes,
    fixture.planBytes,
    target,
  );
}

describe('Explicit partial initial Apply recovery', () => {
  it('binds a 182-object partial state to real approval/correspondence fixtures and changes only control source inputs', () => {
    const fixture = createBootstrapRecoveryFixture();
    const result = admit(fixture);
    expect(result.state.managedResourceCount).toBe(182);
    expect(result.state.observationType).toBe('bootstrap-initialization-recovery-state');
    expect(() => observeBootstrapInitializationState(fixture.stateBytes, 'control-plane', target)).toThrow();
    expect(() => admitBootstrapInitializationHandoff(fixture.request, fixture.stateBytes, target)).toThrow();
    const inputs = JSON.parse(
      Buffer.from(required(result.nonsecretInputs.files[0]).contentBase64, 'base64').toString(),
    ) as Record<string, unknown>;
    expect(inputs['control_source_sha']).toBe('b'.repeat(40));
    expect(inputs['enable_development_pipeline']).toBe(true);
  });

  it.each([
    'tainted',
    'deposed',
    'foreign-resource',
    'changed-seed-id',
    'changed-created-id',
    'changed-name',
    'changed-lineage',
    'old-serial',
    'missing-seed',
  ])('rejects %s state before publication', (mutation) => {
    const fixture = createBootstrapRecoveryFixture();
    const state = fixture.state;
    const resource = required(state.resources.find((item) => item.name === 'retained_log_0'));
    if (mutation === 'tainted') Object.assign(required(resource.instances[0]), { status: 'tainted' });
    if (mutation === 'deposed') Object.assign(required(resource.instances[0]), { deposed: '01234567' });
    if (mutation === 'foreign-resource') resource.name = 'unplanned_resource';
    if (mutation === 'changed-name') required(resource.instances[0]).attributes['name'] = 'foreign';
    if (mutation === 'changed-created-id') required(resource.instances[0]).attributes['id'] = 'foreign-resource-id';
    if (mutation === 'changed-seed-id')
      required(required(state.resources[0]).instances[0]).attributes['id'] = 'replacement';
    if (mutation === 'changed-lineage') state.lineage = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    if (mutation === 'old-serial') state.serial = 1;
    if (mutation === 'missing-seed') state.resources.shift();
    expect(() =>
      admitBootstrapRecoveryMaterial(
        fixture.material,
        Buffer.from(JSON.stringify(state)),
        fixture.seedBytes,
        fixture.planBytes,
        target,
      ),
    ).toThrow();
  });

  it.each([
    'state-version',
    'state-bytes',
    'plan-bytes',
    'seed-bytes',
    'approval-summary',
    'previous-source',
    'successful-execution',
    'implicit-selector',
    'changed-manifest',
  ])('rejects detached %s', (mutation) => {
    const fixture = createBootstrapRecoveryFixture();
    if (mutation === 'state-version') fixture.request.stateVersionId = 'another-version';
    if (mutation === 'state-bytes') fixture.stateBytes = Buffer.concat([fixture.stateBytes, Buffer.from('\n')]);
    if (mutation === 'plan-bytes') fixture.planBytes = Buffer.concat([fixture.planBytes, Buffer.from('\n')]);
    if (mutation === 'seed-bytes') fixture.seedBytes = Buffer.concat([fixture.seedBytes, Buffer.from('\n')]);
    if (mutation === 'approval-summary')
      required(
        fixture.request.previousActions.actionExecutionDetails[2],
      ).output.executionResult.externalExecutionSummary = '{}';
    if (mutation === 'previous-source')
      required(fixture.request.previousExecution.pipelineExecution.artifactRevisions[0]).revisionId = 'c'.repeat(40);
    if (mutation === 'successful-execution') fixture.request.previousExecution.pipelineExecution.status = 'Succeeded';
    if (mutation === 'implicit-selector')
      required(fixture.request.executionResponse.pipelineExecution.variables[0]).resolvedValue = 'initial';
    if (mutation === 'changed-manifest')
      fixture.request.manifest = { ...fixture.request.manifest, stateVersionId: 'another-version' };
    expect(() => admit(fixture)).toThrow();
  });

  it('rejects retried/truncated action histories and a missing or unsuccessful approval', () => {
    const fixture = createBootstrapRecoveryFixture();
    const id = fixture.material.previous.executionId;
    const actions = fixture.request.previousActions;
    expect(() => selectFailedBootstrapApplyActions({ ...actions, nextToken: 'more' }, id)).toThrow();
    expect(() =>
      selectFailedBootstrapApplyActions(
        { actionExecutionDetails: [...actions.actionExecutionDetails, actions.actionExecutionDetails[3]] },
        id,
      ),
    ).toThrow();
    required(actions.actionExecutionDetails[2]).status = 'Failed';
    expect(() => selectFailedBootstrapApplyActions(actions, id)).toThrow();
  });
});

describe('Fresh recovery saved-plan mutation boundary', () => {
  function plan(address: string, actions: string[], mode = 'managed') {
    return { resource_changes: [{ address, mode, change: { actions } }] };
  }
  it('permits remaining creates, the two reviewed policies and the internal propagation replacement', () => {
    for (const address of [
      'aws_iam_policy.bootstrap_apply_app_lane_pipeline_management[0]',
      'aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management[0]',
    ])
      expect(() => assertBootstrapRecoveryPlan(plan(address, ['update']))).not.toThrow();
    expect(() =>
      assertBootstrapRecoveryPlan(
        plan('terraform_data.bootstrap_apply_authorization_propagation[0]', ['delete', 'create']),
      ),
    ).not.toThrow();
    expect(() => assertBootstrapRecoveryPlan(plan('aws_s3_bucket.remaining', ['create']))).not.toThrow();
  });
  it.each([['delete'], ['delete', 'create'], ['create', 'delete'], ['update']].map((actions) => ({ actions })))(
    'rejects unreviewed AWS actions %j',
    ({ actions }) => {
      expect(() => assertBootstrapRecoveryPlan(plan('aws_kms_key.app_pipeline_artifacts[0]', actions))).toThrow();
    },
  );
});
