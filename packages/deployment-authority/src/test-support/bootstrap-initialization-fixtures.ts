import { createHash } from 'node:crypto';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '../index.js';
import {
  observeBootstrapInitializationState,
  resolveBootstrapInitializationScope,
} from '../bootstrap-initialization.js';
const TARGET_KEY = 'stark-prod/main';
const sourceSha = 'a'.repeat(40);
const initializationId = '11111111-2222-4333-8444-555555555555';
const executionId = '11111111-2222-3333-4444-555555555555';
function contextFixture() {
  const target = resolveAllowedDeploymentTarget(TARGET_KEY);
  return renderDeploymentLaneContext({
    target,
    lane: 'bootstrap',
    accountId: target.accountId,
    requestedControlSourceSha: sourceSha,
    selectedApplicationSourceSha: sourceSha,
    frameworkSourceSha: sourceSha,
  });
}
type StateFixture = {
  version: number;
  terraform_version: string;
  serial: number;
  lineage: string;
  outputs: Record<string, unknown>;
  resources: {
    module?: string;
    mode: string;
    type: string | undefined;
    name: string | undefined;
    provider: string;
    instances: { index_key?: unknown; attributes: Record<string, unknown> }[];
  }[];
  check_results: unknown[];
};
type ExecutionFixture = {
  pipelineExecution: {
    pipelineName: string;
    pipelineExecutionId: string;
    status: string;
    executionType: string;
    artifactRevisions: { name: string; revisionId: string }[];
    trigger: { triggerType: string; triggerDetail: string };
    variables: { name: string; resolvedValue: string }[];
  };
};
type HandoffFixture = {
  seedState: Buffer;
  request: {
    context: ReturnType<typeof contextFixture>;
    executionResponse: ExecutionFixture;
    pipelineExecutionId: string;
    stateVersionId: string;
    manifest: {
      kind: string;
      context: ReturnType<typeof contextFixture>;
      initializationId: string;
      administratorArn: string;
      backendPlanReviewSha256: string;
      controlPlanePlanReviewSha256: string;
      seedState: ReturnType<typeof observeBootstrapInitializationState>;
      seedStateVersionId: string;
      nonsecretInputs: {
        evidenceType: string;
        root: string;
        secretValuesIncluded: boolean;
        files: { path: string; contentBase64: string; sha256: string }[];
      };
    };
  };
};

export function createBootstrapInitializationStateFixture(
  phase: 'backend' | 'control-plane' = 'backend',
): StateFixture {
  const target = resolveAllowedDeploymentTarget(TARGET_KEY);
  const bootstrapNames = resolveDeploymentLaneAuthority(target, 'bootstrap').names;
  const scope = resolveBootstrapInitializationScope(phase, TARGET_KEY);
  const resources = scope.addresses.map((address) => {
    const match =
      /^(?:(module\.bootstrap_pipeline_codebuild_log_groups)\.)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)(?:\[(.*)\])?$/u.exec(
        address,
      );
    if (match === null) throw new Error('Invalid test resource address.');
    const [, moduleName, type, name, index] = match;
    const attributes: Record<string, unknown> = { id: 'created-resource' };
    if (address === 'aws_s3_bucket.state')
      Object.assign(attributes, {
        bucket: bootstrapNames.terraformStateBucket,
        id: bootstrapNames.terraformStateBucket,
      });
    const keyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    if (address === 'aws_kms_key.state')
      Object.assign(attributes, {
        key_id: keyId,
        id: keyId,
        arn: `arn:aws:kms:${target.region}:${target.accountId}:key/${keyId}`,
      });
    if (address === 'aws_kms_alias.state')
      Object.assign(attributes, { name: bootstrapNames.terraformStateKmsAlias, target_key_id: keyId });
    return {
      ...(moduleName === undefined ? {} : { module: moduleName }),
      mode: 'managed',
      type,
      name,
      provider:
        type === 'terraform_data'
          ? 'provider["terraform.io/builtin/terraform"]'
          : 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [{ ...(index === undefined ? {} : { index_key: JSON.parse(index) as unknown }), attributes }],
    };
  });
  return {
    version: 4,
    terraform_version: '1.15.8',
    serial: 1,
    lineage: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    outputs: {},
    resources,
    check_results: [],
  };
}
export function createBootstrapInitializationExecutionFixture(): ExecutionFixture {
  const context = contextFixture();
  const target = resolveAllowedDeploymentTarget(TARGET_KEY);
  return {
    pipelineExecution: {
      pipelineName: context.names.pipeline,
      pipelineExecutionId: executionId,
      status: 'InProgress',
      executionType: 'STANDARD',
      artifactRevisions: [{ name: 'SourceOutput', revisionId: sourceSha }],
      trigger: {
        triggerType: 'StartPipelineExecution',
        triggerDetail: `arn:aws:sts::${target.accountId}:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/reviewer`,
      },
      variables: [
        { name: 'BootstrapInputMode', resolvedValue: 'initial' },
        { name: 'BootstrapInitializationId', resolvedValue: initializationId },
        { name: 'BootstrapInitializationVersionId', resolvedValue: '+opaque.version/value' },
        { name: 'BootstrapInitializationSha256', resolvedValue: 'c'.repeat(64) },
      ],
    },
  };
}
export function createBootstrapInitializationHandoffFixture(): HandoffFixture {
  const context = contextFixture();
  const target = resolveAllowedDeploymentTarget(TARGET_KEY);
  const bootstrapNames = resolveDeploymentLaneAuthority(target, 'bootstrap').names;
  const seedState = Buffer.from(JSON.stringify(createBootstrapInitializationStateFixture('control-plane')));
  const body = canonicalRecordJson({
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    backend_principal_arns: [`arn:aws:iam::${target.accountId}:role/operator`],
    control_source_sha: sourceSha,
    deployment_environment: 'main',
    development_app_cloudfront_acm_certificate_arn: `arn:aws:acm:us-east-1:${target.accountId}:certificate/11111111-2222-3333-4444-555555555555`,
    development_app_public_hostname: 'production.example.invalid',
    enable_development_app_pipeline: true,
    enable_development_foundation_pipeline: true,
    enable_development_pipeline: true,
    github_full_repository_id: context.source.repository,
    project_name: context.project.projectId,
    protected_production_aws_account_id: null,
    source_branch: 'main',
    state_backend_key: context.root.backendKey,
    state_bucket_name: bootstrapNames.terraformStateBucket,
    state_kms_alias: bootstrapNames.terraformStateKmsAlias,
    state_kms_key_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    state_scope: 'bootstrap',
    terraform_version: '1.15.8',
  });
  const executionResponse = createBootstrapInitializationExecutionFixture();
  const manifest = {
    kind: 'bootstrap-initialization',
    context,
    initializationId: initializationId,
    administratorArn: executionResponse.pipelineExecution.trigger.triggerDetail,
    backendPlanReviewSha256: '1'.repeat(64),
    controlPlanePlanReviewSha256: '2'.repeat(64),
    seedState: observeBootstrapInitializationState(seedState, 'control-plane', TARGET_KEY),
    seedStateVersionId: '+seed-state-version',
    nonsecretInputs: {
      evidenceType: 'terraform-baseline-nonsecret-inputs',
      root: 'bootstrap',
      secretValuesIncluded: false,
      files: [
        {
          path: 'pipeline.auto.tfvars.json',
          contentBase64: Buffer.from(body).toString('base64'),
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ],
    },
  };
  executionResponse.pipelineExecution.variables[3] = {
    name: 'BootstrapInitializationSha256',
    resolvedValue: createHash('sha256').update(canonicalRecordJson(manifest)).digest('hex'),
  };
  return {
    seedState,
    request: {
      context,
      executionResponse,
      manifest,
      pipelineExecutionId: executionId,
      stateVersionId: manifest.seedStateVersionId,
    },
  };
}
