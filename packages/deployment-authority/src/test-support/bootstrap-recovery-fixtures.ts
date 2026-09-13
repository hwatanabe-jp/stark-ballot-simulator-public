import { createHash } from 'node:crypto';
import { canonicalRecordJson, renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from '../index.js';
import { buildBootstrapRecoveryManifest } from '../bootstrap-initialization-recovery.js';
import { decodeTerraformBaselineNonsecretInputValues } from '../terraform-authority.js';
import { buildSavedPlanReview } from '../saved-plan-review.js';
import { buildSavedPlanCorrespondence } from '../saved-plan-correspondence.js';
import {
  buildExpandedSavedPlanApprovalEvidence,
  deriveSavedPlanApprovalEvidenceKey,
  renderCompactSavedPlanApprovalSummary,
} from '../saved-plan-approval-evidence.js';
import { buildSavedPlanFixture } from '../testdata/saved-plan-fixture.js';
import {
  createBootstrapInitializationHandoffFixture,
  createBootstrapInitializationStateFixture,
} from './bootstrap-initialization-fixtures.js';

const targetKey = 'stark-prod/main';
const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');

function createBootstrapRecoveryFixtureValue() {
  const initial = createBootstrapInitializationHandoffFixture();
  const prepared = buildSavedPlanFixture({ targetKey });
  const previousExecution = structuredClone(initial.request.executionResponse);
  previousExecution.pipelineExecution.pipelineExecutionId = prepared.pendingAction.pipelineExecutionId;
  previousExecution.pipelineExecution.status = 'Failed';
  const seed = createBootstrapInitializationStateFixture('control-plane');
  const state = structuredClone(seed);
  state.serial += 3;
  const resourceChanges: Record<string, unknown>[] = seed.resources.flatMap((resource) =>
    resource.instances.map((instance) => ({
      address: `${resource.module === undefined ? '' : `${resource.module}.`}${resource.type}.${resource.name}${instance.index_key === undefined ? '' : `[${JSON.stringify(instance.index_key)}]`}`,
      mode: 'managed',
      type: resource.type,
      change: {
        actions: ['no-op'],
        before: instance.attributes,
        after: instance.attributes,
        after_unknown: {},
        before_sensitive: false,
        after_sensitive: {},
      },
    })),
  );
  for (let index = 0; index < 172; index += 1) {
    const name = `retained_log_${index}`;
    const attributes = { id: `/aws/codebuild/fixture-${index}`, name: `/aws/codebuild/fixture-${index}` };
    if (index < 101)
      state.resources.push({
        mode: 'managed',
        type: 'aws_cloudwatch_log_group',
        name,
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes }],
      });
    resourceChanges.push({
      address: `aws_cloudwatch_log_group.${name}`,
      mode: 'managed',
      type: 'aws_cloudwatch_log_group',
      change: {
        actions: ['create'],
        before: null,
        after: { id: null, name: attributes.name },
        after_unknown: { id: true },
        before_sensitive: false,
        after_sensitive: {},
      },
    });
  }
  // A real partial full Apply can exceed the initializer's 256-resource bound
  // because evaluated IAM data documents are retained alongside managed objects.
  for (let index = 0; index < 100; index += 1)
    state.resources.push({
      mode: 'data',
      type: 'aws_iam_policy_document',
      name: `evaluated_policy_${index}`,
      provider: 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [],
    });
  const plan: Record<string, unknown> = {
    format_version: '1.2',
    terraform_version: '1.15.8',
    applyable: true,
    complete: true,
    errored: false,
    variables: Object.fromEntries(
      Object.entries(decodeTerraformBaselineNonsecretInputValues(initial.request.manifest.nonsecretInputs)).map(
        ([key, value]) => [key, { value }],
      ),
    ),
    resource_changes: resourceChanges,
    resource_drift: [],
    output_changes: {},
    checks: [],
  };
  const planBytes = Buffer.from(JSON.stringify(plan));
  const review = buildSavedPlanReview(
    {
      context: prepared.review.context,
      artifact: prepared.review.artifact,
      state: { ...prepared.review.state, etag: `"${'1'.repeat(32)}"`, versionId: initial.request.stateVersionId },
      plan: {
        planJson: plan,
        planJsonSha256: hash(planBytes),
        tfplanSha256: hash(prepared.correspondence.files.tfplan),
      },
      approval: prepared.review.approval,
      authority: prepared.review.authority,
    },
    targetKey,
  );
  const files = { ...prepared.correspondence.files, tfplanJson: planBytes };
  const expected = {
    ...prepared.correspondence.expected,
    contract: {
      disposition: 'REVIEWABLE',
      review: {
        reviewType: 'saved-plan-semantic-review',
        context: review.context,
        summary: review.summary,
        approval: review.approval,
        authority: review.authority,
      },
    },
  };
  const correspondence = {
    expected,
    files,
    manifestBody: Buffer.from(canonicalRecordJson(buildSavedPlanCorrespondence({ ...expected, files }, targetKey))),
  };
  const approvalEvidence = buildExpandedSavedPlanApprovalEvidence(
    {
      correspondence,
      review,
      artifactObservation: prepared.artifactObservation,
      pendingAction: prepared.pendingAction,
      reviewerIdentity: prepared.reviewerIdentity,
    },
    targetKey,
  );
  const approvalReference = {
    key: deriveSavedPlanApprovalEvidenceKey(
      {
        targetKey,
        lane: 'bootstrap',
        gate: 'terraform',
        pipelineExecutionId: prepared.pendingAction.pipelineExecutionId,
        actionExecutionId: prepared.pendingAction.actionExecutionId,
      },
      targetKey,
    ),
    versionId: 'approved-evidence-version',
    sha256: hash(canonicalRecordJson(approvalEvidence)),
  };
  const compactSummary = renderCompactSavedPlanApprovalSummary(
    { evidence: approvalEvidence, evidenceReference: approvalReference },
    targetKey,
  );
  const previousActions = {
    actionExecutionDetails: [
      ['Source', 'Source', 'Succeeded'],
      ['TerraformPlan', 'Plan', 'Succeeded'],
      ['ManualApproval', 'ApproveBootstrapApply', 'Succeeded'],
      ['TerraformApply', 'ApplySavedPlan', 'Failed'],
    ].map(([stageName, actionName, status]) => ({
      stageName,
      actionName,
      status,
      pipelineExecutionId: prepared.pendingAction.pipelineExecutionId,
      actionExecutionId:
        stageName === 'ManualApproval'
          ? prepared.pendingAction.actionExecutionId
          : stageName === 'Source'
            ? 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
            : stageName === 'TerraformPlan'
              ? 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
              : 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
      output: {
        executionResult: {
          externalExecutionId: prepared.pendingAction.actionExecutionId,
          externalExecutionSummary: compactSummary,
        },
      },
    })),
  };
  const context = renderDeploymentLaneContext({
    target: resolveAllowedDeploymentTarget(targetKey),
    lane: 'bootstrap',
    accountId: initial.request.context.target.accountId,
    requestedControlSourceSha: 'b'.repeat(40),
    frameworkSourceSha: 'b'.repeat(40),
    selectedApplicationSourceSha: 'b'.repeat(40),
  });
  const material = {
    context,
    previous: {
      initialManifest: initial.request.manifest,
      executionId: prepared.pendingAction.pipelineExecutionId,
      approvalEvidence,
      approvalReference,
    },
    previousExecution,
    previousActions,
  };
  const stateBytes = Buffer.from(JSON.stringify(state));
  const initializationId = '33333333-4444-4555-8666-777777777777';
  const stateVersionId = 'reviewed-partial-state-version';
  const administratorIdentity = { Account: context.target.accountId, Arn: initial.request.manifest.administratorArn };
  const manifest = buildBootstrapRecoveryManifest(
    { administratorIdentity, initializationId, material, stateVersionId },
    stateBytes,
    initial.seedState,
    planBytes,
    targetKey,
  );
  const executionResponse = structuredClone(initial.request.executionResponse);
  executionResponse.pipelineExecution.artifactRevisions = [{ name: 'SourceOutput', revisionId: 'b'.repeat(40) }];
  executionResponse.pipelineExecution.variables = [
    { name: 'BootstrapInputMode', resolvedValue: 'recovery' },
    { name: 'BootstrapInitializationId', resolvedValue: initializationId },
    { name: 'BootstrapInitializationVersionId', resolvedValue: 'recovery-manifest-version' },
    { name: 'BootstrapInitializationSha256', resolvedValue: hash(canonicalRecordJson(manifest)) },
  ];
  return {
    material,
    state,
    stateBytes,
    seedBytes: initial.seedState,
    plan,
    planBytes,
    manifest,
    request: {
      context,
      executionResponse,
      pipelineExecutionId: executionResponse.pipelineExecution.pipelineExecutionId,
      manifest,
      previousExecution,
      previousActions,
      stateVersionId,
    },
  };
}

export function createBootstrapRecoveryFixture(): ReturnType<typeof createBootstrapRecoveryFixtureValue> {
  return createBootstrapRecoveryFixtureValue();
}
