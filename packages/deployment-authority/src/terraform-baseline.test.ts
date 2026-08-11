import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
} from '@stark-ballot/deployment-authority';
import {
  bindAdmittedAppTerraformBaseline,
  buildTerraformBaselineSecretReferences,
  buildTerraformBaselineNonsecretInputs,
  decodeTerraformBaselineNonsecretInputValues,
  validateCodeBuildRuntimeEvidence,
  validateAcceptedTerraformBaseline,
  validateCurrentTerraformBaselinePointer,
  validateTerraformBaselineAcceptanceEvidence,
  validateTerraformBaselineIdentityEvidence,
  validateTerraformBaselineInputIdentity,
  validateTerraformBaselineInputManifest,
  validateTerraformBaselineNonsecretInputs,
  validateTerraformBaselineProviderLock,
  validateTerraformBaselineProviderSelections,
  validateTerraformBaselineProviderEvidence,
  validateTerraformBaselineSmokeAdmission,
} from '@stark-ballot/deployment-authority/terraform-baseline';

const controlSourceSha = 'a'.repeat(40);
const frameworkSourceSha = 'b'.repeat(40);
const pipelineExecutionId = '11111111-2222-3333-4444-555555555555';
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const mismatchedAccountId = `${target.accountId.startsWith('0') ? '1' : '0'}${target.accountId.slice(1)}`;
const stateKmsKeyId = '11111111-2222-3333-4444-555555555555';
const stateKmsKeyArn = `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${stateKmsKeyId}`;
const approverArn = `arn:${target.partition}:sts::${target.accountId}:assumed-role/operator/session`;

const roots = {
  bootstrap: {
    stateIdentity: 'stark-dev/develop/bootstrap',
    backendKey: 'stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate',
  },
  foundation: {
    stateIdentity: 'stark-dev/develop/foundation',
    backendKey: 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate',
  },
  app: {
    stateIdentity: 'stark-dev/develop/app',
    backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
  },
} as const;

type TerraformRoot = keyof typeof roots;

const bootstrapInputKeys = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'backend_principal_arns',
  'control_source_sha',
  'deployment_environment',
  'development_app_cloudfront_acm_certificate_arn',
  'development_app_public_hostname',
  'enable_development_app_pipeline',
  'enable_development_foundation_pipeline',
  'enable_development_pipeline',
  'github_full_repository_id',
  'project_name',
  'protected_production_aws_account_id',
  'source_branch',
  'state_backend_key',
  'state_bucket_name',
  'state_kms_alias',
  'state_kms_key_id',
  'state_scope',
  'terraform_version',
] as const;

const foundationInputKeys = [
  'account_alias',
  'aws_account_id',
  'aws_region',
  'deployment_environment',
  'project_name',
  'public_hostname_disposition',
  'state_backend_key',
  'state_scope',
] as const;

const appInputKeys = [
  'account_alias',
  'app_source_sha',
  'aws_account_id',
  'aws_region',
  'cloudfront_acm_certificate_arn',
  'deploy_mode',
  'deployment_environment',
  'deployment_id',
  'develop_operator_gate_enabled',
  'dynamodb_recovery_activation',
  'dynamodb_recovery_phase',
  'enable_dynamodb_deletion_protection',
  'expected_image_id',
  'fargate_vcpu_alarm_threshold',
  'image_id_mapping_evidence',
  'image_signature_preflight_prover_image_uri',
  'image_signature_status_attempt_timeout_ms',
  'image_signature_status_max_attempts',
  'image_signature_status_retry_delay_ms',
  'image_signature_verifier_base_prover_image_uri',
  'image_signature_verifier_handler_deadline_ms',
  'image_signature_verifier_lambda_timeout_seconds',
  'image_signature_verifier_permissions_boundary_arn',
  'image_signature_verifier_process_timeout_ms',
  'image_signature_verifier_selected_authority',
  'image_signature_verifier_step_timeout_seconds',
  'lambda_artifacts',
  'lambda_runtime',
  'project_name',
  'proof_artifact_lifecycle_days',
  'prover_cpu',
  'prover_image_uri',
  'prover_max_concurrent_provers',
  'prover_memory',
  'prover_security_group_ids',
  'prover_subnet_ids',
  'prover_task_timeout_seconds',
  'public_hostname',
  'public_hostname_disposition',
  'session_live_ttl_seconds',
  'state_backend_key',
  'state_scope',
  'verification_artifact_ttl_seconds',
  'verifier_public_base_url',
  'verifier_service_bin_path',
  'vote_duplicate_detector_ttl_seconds',
] as const;

function encodedInput(path: string, body: string) {
  return {
    path,
    sha256: createHash('sha256').update(body).digest('hex'),
    contentBase64: Buffer.from(body).toString('base64'),
  };
}

function nonsecretInputs(root: TerraformRoot) {
  let inputs: Record<string, unknown>;
  if (root === 'bootstrap') {
    inputs = Object.fromEntries(
      bootstrapInputKeys.map((key) => [
        key,
        key === 'backend_principal_arns'
          ? []
          : key.startsWith('enable_')
            ? true
            : key === 'protected_production_aws_account_id'
              ? null
              : key === 'development_app_cloudfront_acm_certificate_arn'
                ? null
                : 'fixture',
      ]),
    );
  } else if (root === 'foundation') {
    inputs = Object.fromEntries(foundationInputKeys.map((key) => [key, 'fixture']));
  } else {
    inputs = Object.fromEntries(appInputKeys.map((key) => [key, 'fixture']));
    inputs['cloudfront_acm_certificate_arn'] = null;
    inputs['develop_operator_gate_enabled'] = true;
    inputs['enable_dynamodb_deletion_protection'] = true;
    inputs['fargate_vcpu_alarm_threshold'] = 40;
    inputs['image_signature_preflight_prover_image_uri'] = null;
    inputs['image_signature_status_attempt_timeout_ms'] = 4000;
    inputs['image_signature_status_max_attempts'] = 4;
    inputs['image_signature_status_retry_delay_ms'] = 5000;
    inputs['image_signature_verifier_base_prover_image_uri'] = null;
    inputs['image_signature_verifier_handler_deadline_ms'] = 100000;
    inputs['image_signature_verifier_lambda_timeout_seconds'] = 120;
    inputs['image_signature_verifier_process_timeout_ms'] = 60000;
    inputs['image_signature_verifier_step_timeout_seconds'] = 130;
    inputs['image_signature_verifier_selected_authority'] = null;
    inputs['proof_artifact_lifecycle_days'] = 7;
    inputs['prover_cpu'] = 16384;
    inputs['prover_max_concurrent_provers'] = 2;
    inputs['prover_memory'] = 32768;
    inputs['prover_security_group_ids'] = ['sg-fixture'];
    inputs['prover_subnet_ids'] = ['subnet-fixture'];
    inputs['prover_task_timeout_seconds'] = 1800;
    inputs['session_live_ttl_seconds'] = 1800;
    inputs['verification_artifact_ttl_seconds'] = 7200;
    inputs['vote_duplicate_detector_ttl_seconds'] = 1800;
    inputs['image_id_mapping_evidence'] = {
      mapping_path: 'public/imageId-mapping.json',
      mapping_sha256: '1'.repeat(64),
      current_method_version: 1,
      current_method_version_key: '1',
      variant: 'default',
      expected_image_id: `0x${'2'.repeat(64)}`,
    };
    inputs['lambda_artifacts'] = Object.fromEntries(
      [
        'finalization_writer',
        'image_signature_verifier',
        'proof_dispatcher',
        'public_api',
        'semaphore_janitor',
        'verification_worker',
      ].map((name) => [
        name,
        {
          s3_bucket: 'fixture-bucket',
          s3_key: `${name}.zip`,
          s3_object_version: 'version-fixture',
          source_code_hash: `${'A'.repeat(43)}=`,
          asset_manifest_sha256: name === 'image_signature_verifier' ? '3'.repeat(64) : null,
          trust_root_sha256: name === 'image_signature_verifier' ? '4'.repeat(64) : null,
        },
      ]),
    );
    inputs['dynamodb_recovery_activation'] = null;
    inputs['dynamodb_recovery_phase'] = 'primary_active';
  }
  const body = canonicalRecordJson(inputs);
  return {
    evidenceType: 'terraform-baseline-nonsecret-inputs',
    root,
    files: [encodedInput('pipeline.auto.tfvars.json', body)],
    secretValuesIncluded: false,
  };
}

interface NonsecretInputCollection {
  readonly files: readonly { readonly contentBase64: string }[];
}

function firstInputFile<T extends NonsecretInputCollection>(value: T): T['files'][number] {
  const file = value.files[0];
  if (file === undefined) {
    throw new Error('Terraform baseline fixture is missing its input file.');
  }
  return file;
}

function parseInputVariables(value: NonsecretInputCollection): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(firstInputFile(value).contentBase64, 'base64').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Terraform baseline fixture inputs must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} fixture must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function laneContext(root: TerraformRoot) {
  return renderDeploymentLaneContext({
    target,
    lane: root,
    accountId: target.accountId,
    requestedControlSourceSha: controlSourceSha,
    selectedApplicationSourceSha: controlSourceSha,
    frameworkSourceSha: controlSourceSha,
  });
}

function contextBoundInputs(root: TerraformRoot) {
  const value = structuredClone(nonsecretInputs(root));
  const variables = parseInputVariables(value);
  const context = laneContext(root);
  Object.assign(variables, {
    account_alias: context.target.accountLabel,
    aws_account_id: context.target.accountId,
    aws_region: context.target.region,
    deployment_environment: context.target.environmentId,
    project_name: context.project.projectId,
    state_backend_key: context.root.backendKey,
    state_scope: context.root.scope,
  });
  if (root === 'bootstrap') {
    Object.assign(variables, {
      control_source_sha: context.source.requestedControlSourceSha,
      github_full_repository_id: context.source.repository,
      source_branch: context.source.branch,
      state_bucket_name: 'stark-ballot-simulator-terraform-state-stark-dev-develop',
      state_kms_alias: 'alias/stark-ballot-simulator-terraform-state-stark-dev-develop',
      state_kms_key_id: stateKmsKeyId,
      terraform_version: '1.15.5',
    });
  } else if (root === 'app') {
    Object.assign(variables, {
      app_source_sha: context.source.selectedApplicationSourceSha,
      deploy_mode: 'normal',
      deployment_id: `dep_${'1'.repeat(32)}`,
      image_signature_verifier_permissions_boundary_arn: `arn:${target.partition}:iam::${target.accountId}:policy/${context.names.signatureVerifierPermissionsBoundary}`,
    });
  }
  const body = canonicalRecordJson(variables);
  value.files[0] = encodedInput('pipeline.auto.tfvars.json', body);
  return value;
}

function terraformPlanDocument(root: TerraformRoot) {
  const inputs = contextBoundInputs(root);
  const variables = parseInputVariables(inputs);
  const evaluatedVariables: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [name, { value }]),
  );
  return {
    format_version: '1.2',
    variables: evaluatedVariables,
    resource_changes: [{ sensitive: 'sentinel-that-must-not-be-copied' }],
  };
}

function terraformIdentity() {
  return {
    terraform_version: '1.15.5',
    platform: 'linux_amd64',
    provider_selections: { 'registry.terraform.io/hashicorp/aws': '6.2.0' },
    terraform_outdated: false,
  };
}

function providerLock() {
  return Buffer.from(
    '# This file is maintained automatically by "terraform init".\n' +
      '# Manual edits may be lost in future updates.\n\n' +
      'provider "registry.terraform.io/hashicorp/aws" {\n' +
      '  version     = "6.2.0"\n' +
      '  constraints = "~> 6.0"\n' +
      '  hashes = [\n' +
      `    "zh:${'1'.repeat(64)}",\n` +
      '  ]\n' +
      '}\n',
  );
}

function runtimeEvidence(root: TerraformRoot) {
  const context = laneContext(root);
  return {
    evidenceType: 'codebuild-runtime',
    targetKey: 'stark-dev/develop',
    lane: root,
    stateIdentity: context.root.stateIdentity,
    sourceSha: context.source.frameworkSourceSha,
    project: {
      key: 'terraformPlanProject',
      name: context.names.terraformPlanProject,
      arn: `arn:${context.target.partition}:codebuild:${context.target.region}:${context.target.accountId}:project/${context.names.terraformPlanProject}`,
      buildId: `${context.names.terraformPlanProject}:11111111-2222-3333-4444-555555555555`,
    },
    runtime: {
      configuredImage: 'aws/codebuild/standard:8.0',
      observedImage: 'aws/codebuild/standard:8.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentType: 'LINUX_CONTAINER',
      privilegedMode: false,
    },
  } as const;
}

function immutableReference(root: TerraformRoot, suffix: string, shaCharacter = 'c') {
  return {
    key: `accepted-baselines/${roots[root].stateIdentity}/${suffix}`,
    versionId: `version-${shaCharacter}`,
    sha256: shaCharacter.repeat(64),
  };
}

function inputManifest(root: TerraformRoot) {
  return {
    evidenceType: 'terraform-baseline-input-manifest',
    root,
    ...roots[root],
    controlSourceSha,
    frameworkSourceSha,
    targetContext: immutableReference(root, 'context/deployment-context.json', 'c'),
    nonsecretInputs: immutableReference(root, 'inputs/nonsecret-inputs.json', 'd'),
    secretReferences: [
      {
        inputName: 'session_capability_secret_ref',
        source: 'secrets-manager-secret',
        reference: '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
      },
      {
        inputName: 'session_capability_ttl_seconds_ref',
        source: 'ssm-parameter',
        reference: '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds',
      },
    ],
    secretValuesIncluded: false,
  } as const;
}

function providerEvidence(root: TerraformRoot) {
  return {
    evidenceType: 'terraform-baseline-provider-evidence',
    root,
    ...roots[root],
    controlSourceSha,
    frameworkSourceSha,
    targetContext: immutableReference(root, 'context/deployment-context.json', 'c'),
    providerLock: immutableReference(root, 'providers/terraform.lock.hcl', 'e'),
    providerSelections: immutableReference(root, 'providers/provider-selections.json', 'f'),
    runtimeEvidence: immutableReference(root, 'providers/codebuild-runtime.json', '1'),
    terraformVersion: '1.12.2',
    platform: 'linux_amd64',
  } as const;
}

function smokeAdmission(root: TerraformRoot) {
  return {
    evidenceType: 'terraform-baseline-smoke-admission',
    root,
    ...roots[root],
    controlSourceSha,
    frameworkSourceSha,
    targetContext: immutableReference(root, 'context/deployment-context.json', 'c'),
    acceptedPlanChecksum: '4'.repeat(64),
    pipelineExecutionId,
    specializedSmokeType: {
      bootstrap: 'bootstrap-codebuild-log-group-state',
      foundation: 'foundation-smoke',
      app: 'app-smoke-report',
    }[root],
    specializedSmokeSha256: '6'.repeat(64),
    smokeResult: 'passed',
  } as const;
}

function acceptanceEvidence(root: 'bootstrap' | 'foundation') {
  return {
    evidenceType: 'terraform-baseline-acceptance',
    root,
    ...roots[root],
    controlSourceSha,
    frameworkSourceSha,
    acceptedPlanChecksum: '4'.repeat(64),
    pipelineExecutionId,
    stageName: 'ManualApproval',
    actionName: root === 'bootstrap' ? 'ApproveInitialDevelopmentApply' : 'ApproveFoundationApply',
    actionExecutionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sourceSha: frameworkSourceSha,
    accountId: target.accountId,
    deploymentEnvironment: 'develop',
    reviewedPlanChecksum: '4'.repeat(64),
    approver: approverArn,
    approvalTimestamp: '2026-08-01T03:04:05.000Z',
  } as const;
}

function baseline(root: TerraformRoot) {
  const context = laneContext(root);
  return {
    recordType: 'accepted-terraform-baseline',
    root,
    ...roots[root],
    backend: {
      bucketName: 'stark-ballot-simulator-terraform-state-stark-dev-develop',
      backendKey: context.root.backendKey,
      kmsKeyArn: stateKmsKeyArn,
      region: context.target.region,
    },
    controlSourceSha,
    frameworkSourceSha,
    targetContext: immutableReference(root, 'context/deployment-context.json', 'c'),
    inputManifest: immutableReference(root, 'inputs/input-manifest.json', '2'),
    providerEvidence: immutableReference(root, 'providers/provider-evidence.json', '3'),
    acceptedPlanChecksum: '4'.repeat(64),
    acceptanceEvidence: {
      key: `pipeline-executions/${root}/${pipelineExecutionId}/acceptance.json`,
      versionId: 'acceptance-version',
      sha256: '5'.repeat(64),
    },
    smokeEvidence: {
      key: `pipeline-executions/${root}/${pipelineExecutionId}/smoke.json`,
      versionId: 'smoke-version',
      sha256: '6'.repeat(64),
    },
    pipelineExecutionId,
    publishedAt: '2026-08-01T03:04:05.000Z',
  } as const;
}

function currentPointer(root: TerraformRoot) {
  return {
    pointerType: 'current-terraform-baseline',
    root,
    ...roots[root],
    baseline: immutableReference(root, `records/${controlSourceSha}.json`, '7'),
  } as const;
}

describe('Terraform baseline secret-reference projection', () => {
  it.each(['bootstrap', 'foundation'] as const)('returns no provider-read secrets for %s', (root) => {
    expect(buildTerraformBaselineSecretReferences(root, laneContext(root))).toEqual([]);
  });

  it('returns the exact ordered App provider-read authority without secret values', () => {
    const context = laneContext('app');

    const references = buildTerraformBaselineSecretReferences('app', context);

    expect(references).toEqual([
      {
        inputName: 'api_origin_verify_header',
        source: 'secrets-manager-secret',
        reference: `${context.names.runtimeSecretReferencePrefix}/expected-origin-verify-header`,
      },
      {
        inputName: 'verification_invariant_email',
        source: 'ssm-parameter',
        reference: `/${context.project.stateNamespace}/observability/invariant-email/endpoint`,
      },
      {
        inputName: 'ops_actionable_email',
        source: 'ssm-parameter',
        reference: `/${context.project.stateNamespace}/observability/ops-actionable-email/endpoint`,
      },
    ]);
    expect(Object.isFrozen(references)).toBe(true);
    expect(references.every((reference) => Object.isFrozen(reference))).toBe(true);
    expect(Object.keys(references[2] ?? {}).sort()).toEqual(['inputName', 'reference', 'source']);
  });

  it('rejects a root that does not match the admitted lane context', () => {
    expect(() => buildTerraformBaselineSecretReferences('app', laneContext('foundation'))).toThrow(
      'Terraform baseline secret-reference context does not match its root.',
    );
  });
});

describe('Terraform baseline input manifest', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits the exact secret-safe %s input authority', (root) => {
    const parsed = validateTerraformBaselineInputManifest(inputManifest(root));

    expect(parsed).toEqual(inputManifest(root));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.secretReferences)).toBe(true);
  });

  it('rejects a raw secret value disguised as a reference', () => {
    const original = inputManifest('app');
    const value = {
      ...original,
      secretReferences: [
        { ...original.secretReferences[0], reference: 'super-secret-value' },
        original.secretReferences[1],
      ],
    };

    expect(() => validateTerraformBaselineInputManifest(value)).toThrow(
      'Terraform baseline secret reference is invalid.',
    );
  });

  it('rejects any secret value field', () => {
    const value = structuredClone(inputManifest('app')) as Record<string, unknown>;
    value['secretValues'] = { session_capability_secret_ref: 'super-secret-value' };

    expect(() => validateTerraformBaselineInputManifest(value)).toThrow(
      'Terraform baseline input manifest must use the exact current shape.',
    );
  });

  it('requires the explicit no-secret-values assertion', () => {
    const value = { ...inputManifest('app'), secretValuesIncluded: true };

    expect(() => validateTerraformBaselineInputManifest(value)).toThrow(
      'Terraform baseline input manifest must exclude secret values.',
    );
  });

  it.each([
    'pipeline-executions/app/run/InputArtifact/input-manifest.json',
    'accepted-baselines/stark-dev/develop/app/inputs/tfplan',
    'accepted-baselines/stark-dev/develop/app/inputs/generated.tfvars.json',
    'accepted-baselines/stark-dev/develop/app/inputs/terraform.tfstate',
  ])('rejects an expiring or sensitive input dependency at %s', (key) => {
    const value = structuredClone(inputManifest('app'));
    value.nonsecretInputs.key = key;

    expect(() => validateTerraformBaselineInputManifest(value)).toThrow(
      'Terraform baseline nonsecret inputs must be durable and must not contain saved plans, state, or raw values.',
    );
  });
});

describe('Terraform baseline nonsecret input authority', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits exact reconstructable %s inputs', (root) => {
    const parsed = validateTerraformBaselineNonsecretInputs(nonsecretInputs(root));

    expect(parsed).toEqual(nonsecretInputs(root));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.files)).toBe(true);
  });

  it('rejects a secret-value field outside the exact authority shape', () => {
    expect(() =>
      validateTerraformBaselineNonsecretInputs({
        ...nonsecretInputs('bootstrap'),
        decryptedSecret: 'sentinel-secret-value',
      }),
    ).toThrow('Terraform baseline nonsecret inputs must use the exact current shape.');
  });

  it('rejects an unknown input inside an otherwise admitted file', () => {
    const value = structuredClone(nonsecretInputs('bootstrap'));
    const parsed = parseInputVariables(value);
    const body = canonicalRecordJson({ ...parsed, operator_token: 'sentinel-secret-value' });
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', body);

    expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
      'Bootstrap Terraform baseline inputs must use the exact current shape.',
    );
  });

  it('rejects duplicate JSON fields even when the effective final value is admitted', () => {
    const value = structuredClone(nonsecretInputs('bootstrap'));
    const canonical = Buffer.from(firstInputFile(value).contentBase64, 'base64').toString('utf8');
    const body = `{"aws_account_id":"sentinel-secret-value",${canonical.slice(1)}`;
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', body);

    expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
      'Bootstrap Terraform baseline inputs must use canonical JSON bytes.',
    );
  });

  it('rejects unknown nested App artifact fields', () => {
    const value = structuredClone(nonsecretInputs('app'));
    const parsed = parseInputVariables(value);
    const artifacts = requireRecord(parsed['lambda_artifacts'], 'App lambda artifacts');
    const publicApi = requireRecord(artifacts['public_api'], 'App public API artifact');
    publicApi['decryptedSecret'] = 'sentinel-secret-value';
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(parsed));

    expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
      'App Terraform baseline lambda_artifacts.public_api must use the exact current shape.',
    );
  });

  it('rejects content that does not match its admitted hash', () => {
    const value = structuredClone(nonsecretInputs('foundation'));
    firstInputFile(value).sha256 = 'f'.repeat(64);

    expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
      'Terraform baseline nonsecret input content hash is invalid.',
    );
  });

  it('rejects extra App reconstruction files', () => {
    const value = structuredClone(nonsecretInputs('app'));
    value.files.push(encodedInput('dynamodb-recovery.auto.tfvars.json', '{}\n'));

    expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
      'App Terraform baseline reconstruction file set is invalid.',
    );
  });
});

describe('Terraform baseline input identity', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('extracts only admitted %s variables from saved-plan JSON', (root) => {
    expect(buildTerraformBaselineNonsecretInputs(root, terraformPlanDocument(root))).toEqual(contextBoundInputs(root));
  });

  it('projects Terraform 1.15.5 omitted non-verifier artifact fields into the exact retained shape', () => {
    const plan = terraformPlanDocument('app');
    const lambdaArtifactsVariable = requireRecord(plan.variables['lambda_artifacts'], 'App lambda artifacts variable');
    const rawArtifacts = requireRecord(lambdaArtifactsVariable['value'], 'App lambda artifacts');
    for (const [name, value] of Object.entries(rawArtifacts)) {
      if (name !== 'image_signature_verifier') {
        const artifact = requireRecord(value, `App ${name} artifact`);
        delete artifact['asset_manifest_sha256'];
        delete artifact['trust_root_sha256'];
      }
    }

    const retained = buildTerraformBaselineNonsecretInputs('app', plan);
    const retainedVariables = parseInputVariables(retained);
    const retainedArtifacts = requireRecord(retainedVariables['lambda_artifacts'], 'Retained App lambda artifacts');
    const retainedArtifactKeys = [
      'asset_manifest_sha256',
      's3_bucket',
      's3_key',
      's3_object_version',
      'source_code_hash',
      'trust_root_sha256',
    ];
    for (const [name, value] of Object.entries(retainedArtifacts)) {
      const artifact = requireRecord(value, `Retained App ${name} artifact`);
      expect(Object.keys(artifact).sort()).toEqual(retainedArtifactKeys);
      if (name === 'image_signature_verifier') {
        expect(artifact['asset_manifest_sha256']).toBe('3'.repeat(64));
        expect(artifact['trust_root_sha256']).toBe('4'.repeat(64));
      } else {
        expect(artifact['asset_manifest_sha256']).toBeNull();
        expect(artifact['trust_root_sha256']).toBeNull();
      }
    }
    expect(Buffer.from(firstInputFile(retained).contentBase64, 'base64').toString('utf8')).toBe(
      canonicalRecordJson(retainedVariables),
    );
  });

  it('decodes only the validated canonical semantic input projection', () => {
    const retained = buildTerraformBaselineNonsecretInputs('app', terraformPlanDocument('app'));
    const decoded = decodeTerraformBaselineNonsecretInputValues(retained);

    expect(decoded).toEqual(parseInputVariables(retained));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded['lambda_artifacts'])).toBe(true);

    const invalid = {
      ...retained,
      files: [{ ...firstInputFile(retained), sha256: '0'.repeat(64) }],
    };
    expect(() => decodeTerraformBaselineNonsecretInputValues(invalid)).toThrow(
      'Terraform baseline nonsecret input content hash is invalid.',
    );
  });

  it('rejects unknown raw App artifact fields before semantic projection', () => {
    const plan = terraformPlanDocument('app');
    const lambdaArtifactsVariable = requireRecord(plan.variables['lambda_artifacts'], 'App lambda artifacts variable');
    const rawArtifacts = requireRecord(lambdaArtifactsVariable['value'], 'App lambda artifacts');
    const publicApi = requireRecord(rawArtifacts['public_api'], 'App public API artifact');
    delete publicApi['asset_manifest_sha256'];
    delete publicApi['trust_root_sha256'];
    publicApi['futureDiagnostic'] = 'must-fail-closed';

    expect(() => buildTerraformBaselineNonsecretInputs('app', plan)).toThrow(
      'App Terraform baseline lambda_artifacts.public_api must use the exact current shape.',
    );
  });

  it('rejects a missing or decorated evaluated variable', () => {
    const missing = terraformPlanDocument('foundation');
    delete missing.variables['aws_region'];
    expect(() => buildTerraformBaselineNonsecretInputs('foundation', missing)).toThrow(
      'Terraform saved plan is missing the admitted foundation variable aws_region.',
    );

    const decorated = terraformPlanDocument('foundation');
    decorated.variables['aws_region'] = { value: 'ap-northeast-1', decryptedSecret: 'sentinel-secret-value' };
    expect(() => buildTerraformBaselineNonsecretInputs('foundation', decorated)).toThrow(
      'Terraform saved-plan variable aws_region must use the exact current shape.',
    );
  });

  it.each(Object.keys(roots) as TerraformRoot[])('rejects an unreviewed extra %s root variable', (root) => {
    const plan = terraformPlanDocument(root);
    plan.variables['future_root_variable'] = { value: 'must-fail-closed' };

    expect(() => buildTerraformBaselineNonsecretInputs(root, plan)).toThrow(
      `Terraform saved-plan ${root} variables must use the exact current shape.`,
    );
  });

  it.each(Object.keys(roots) as TerraformRoot[])('binds exact %s inputs to the deployment context', (root) => {
    const options =
      root === 'bootstrap'
        ? {
            terraformVersion: '1.15.5',
            stateBucketName: 'stark-ballot-simulator-terraform-state-stark-dev-develop',
            stateKmsAlias: 'alias/stark-ballot-simulator-terraform-state-stark-dev-develop',
            stateKmsKeyArn,
          }
        : root === 'app'
          ? { deploymentMode: 'normal' as const }
          : undefined;

    expect(validateTerraformBaselineInputIdentity(contextBoundInputs(root), laneContext(root), options)).toEqual(
      contextBoundInputs(root),
    );
  });

  it.each(['aws_account_id', 'aws_region', 'deployment_environment', 'state_backend_key', 'project_name'])(
    'rejects a context mismatch in %s',
    (name) => {
      const value = contextBoundInputs('foundation');
      const variables = parseInputVariables(value);
      variables[name] = 'well-formed-but-wrong';
      value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(variables));

      expect(() => validateTerraformBaselineInputIdentity(value, laneContext('foundation'))).toThrow(
        `Terraform baseline input ${name} does not match the deployment context authority.`,
      );
    },
  );

  it('binds App source and deployment mode', () => {
    const value = contextBoundInputs('app');
    const variables = parseInputVariables(value);
    variables['deploy_mode'] = 'rollback';
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(variables));

    expect(() =>
      validateTerraformBaselineInputIdentity(value, laneContext('app'), { deploymentMode: 'normal' }),
    ).toThrow('App Terraform baseline deployment mode does not match the deployment context authority.');
  });
});

describe('Terraform baseline runtime and provider inputs', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits the exact %s Plan runtime', (root) => {
    expect(validateCodeBuildRuntimeEvidence(runtimeEvidence(root), laneContext(root))).toEqual(runtimeEvidence(root));
  });

  it('admits the exact App verifier-preflight Plan project only through its closed authority option', () => {
    const context = laneContext('app');
    const value = {
      ...runtimeEvidence('app'),
      project: {
        key: 'appSignaturePreflightPlanProject',
        name: context.names.appSignaturePreflightPlanProject,
        arn:
          `arn:${context.target.partition}:codebuild:${context.target.region}:${context.target.accountId}:project/` +
          context.names.appSignaturePreflightPlanProject,
        buildId: `${context.names.appSignaturePreflightPlanProject}:11111111-2222-3333-4444-555555555555`,
      },
    };

    expect(
      validateCodeBuildRuntimeEvidence(value, context, {
        projectKey: 'appSignaturePreflightPlanProject',
      }),
    ).toEqual(value);
    expect(() => validateCodeBuildRuntimeEvidence(value, context)).toThrow(
      'CodeBuild runtime evidence does not match the Terraform Plan project authority.',
    );
  });

  it('rejects the verifier-preflight Plan project outside the App lane', () => {
    const context = laneContext('bootstrap');
    const projectName = context.names.appSignaturePreflightPlanProject;
    const value = {
      ...runtimeEvidence('bootstrap'),
      project: {
        key: 'appSignaturePreflightPlanProject',
        name: projectName,
        arn:
          `arn:${context.target.partition}:codebuild:${context.target.region}:${context.target.accountId}:project/` +
          projectName,
        buildId: `${projectName}:11111111-2222-3333-4444-555555555555`,
      },
    };

    expect(() =>
      validateCodeBuildRuntimeEvidence(value, context, {
        projectKey: 'appSignaturePreflightPlanProject',
      }),
    ).toThrow('CodeBuild runtime project authority is invalid.');
  });

  it('rejects a Plan build ID whose suffix is not the exact CodeBuild attempt UUID', () => {
    const admitted = runtimeEvidence('bootstrap');
    const value = {
      ...admitted,
      project: {
        ...admitted.project,
        buildId: `${admitted.project.name}:not-a-codebuild-attempt`,
      },
    };

    expect(() => validateCodeBuildRuntimeEvidence(value, laneContext('bootstrap'))).toThrow(
      'CodeBuild runtime evidence does not match the Terraform Plan project authority.',
    );
  });

  it.each([
    ['configuredImage', 'aws/codebuild/standard:7.0'],
    ['computeType', 'BUILD_GENERAL1_MEDIUM'],
    ['environmentType', 'ARM_CONTAINER'],
    ['privilegedMode', true],
  ] as const)('rejects an unsupported runtime field %s', (name, replacement) => {
    const value = structuredClone(runtimeEvidence('bootstrap'));
    Object.assign(value.runtime, { [name]: replacement });

    expect(() => validateCodeBuildRuntimeEvidence(value, laneContext('bootstrap'))).toThrow(
      'CodeBuild runtime evidence does not match the admitted Terraform Plan runtime.',
    );
  });

  it('admits one exact Terraform/AWS-provider identity', () => {
    const identity = validateTerraformBaselineIdentityEvidence(terraformIdentity());

    expect(identity.providerSelections).toEqual({ 'registry.terraform.io/hashicorp/aws': '6.2.0' });
    expect(
      validateTerraformBaselineProviderSelections(terraformIdentity().provider_selections, terraformIdentity()),
    ).toEqual(identity.providerSelections);
    expect(validateTerraformBaselineProviderLock(providerLock(), terraformIdentity())).toEqual(providerLock());
  });

  it('rejects unknown provider selections and secret-bearing lock text', () => {
    expect(() =>
      validateTerraformBaselineProviderSelections(
        {
          ...terraformIdentity().provider_selections,
          'registry.terraform.io/example/sentinel-secret-value': '1.0.0',
        },
        terraformIdentity(),
      ),
    ).toThrow('Terraform baseline provider selections must use the exact current shape.');

    expect(() =>
      validateTerraformBaselineProviderLock(
        Buffer.concat([providerLock(), Buffer.from('# sentinel-secret-value\n')]),
        terraformIdentity(),
      ),
    ).toThrow('Terraform baseline provider lock does not use the exact generated AWS provider shape.');
  });
});

describe('Terraform baseline provider evidence', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits exact durable %s provider authority', (root) => {
    expect(validateTerraformBaselineProviderEvidence(providerEvidence(root))).toEqual(providerEvidence(root));
  });

  it.each(['toolchain', 'prover', 'static-fast'])('rejects the non-root %s lane', (root) => {
    const value = { ...providerEvidence('foundation'), root };

    expect(() => validateTerraformBaselineProviderEvidence(value)).toThrow(
      'Terraform baseline root must be bootstrap, foundation, or app.',
    );
  });

  it('rejects provider evidence for another root state', () => {
    const value = { ...providerEvidence('foundation'), ...roots.app };

    expect(() => validateTerraformBaselineProviderEvidence(value)).toThrow(
      'Terraform baseline state identity does not match the root.',
    );
  });

  it.each([
    'providers/tfplan',
    'providers/terraform.tfplan',
    'providers/archive.tfplan.json',
    'providers/terraform.tfstate',
    'providers/raw-plan.json',
  ])('rejects forbidden provider dependency %s', (suffix) => {
    const value = structuredClone(providerEvidence('bootstrap'));
    value.providerLock.key = `accepted-baselines/${roots.bootstrap.stateIdentity}/${suffix}`;

    expect(() => validateTerraformBaselineProviderEvidence(value)).toThrow(
      'Terraform baseline provider lock must be durable and must not contain saved plans, state, or raw values.',
    );
  });
});

describe('Terraform baseline saved-plan acceptance', () => {
  it.each(['bootstrap', 'foundation'] as const)('admits exact reviewed %s approval evidence', (root) => {
    expect(validateTerraformBaselineAcceptanceEvidence(acceptanceEvidence(root))).toEqual(acceptanceEvidence(root));
  });

  it('rejects unknown durable fields', () => {
    expect(() =>
      validateTerraformBaselineAcceptanceEvidence({
        ...acceptanceEvidence('bootstrap'),
        decryptedSecret: 'sentinel-secret-value',
      }),
    ).toThrow('Terraform baseline acceptance evidence must use the exact current shape.');
  });

  it('requires one checksum authority', () => {
    expect(() =>
      validateTerraformBaselineAcceptanceEvidence({
        ...acceptanceEvidence('foundation'),
        reviewedPlanChecksum: 'f'.repeat(64),
      }),
    ).toThrow('Terraform baseline acceptance checksums do not match.');
  });
});

describe('Terraform baseline smoke admission', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits exact passed %s smoke authority', (root) => {
    const parsed = validateTerraformBaselineSmokeAdmission(smokeAdmission(root));

    expect(parsed).toEqual(smokeAdmission(root));
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects an unknown success claim', () => {
    expect(() =>
      validateTerraformBaselineSmokeAdmission({
        ...smokeAdmission('bootstrap'),
        smokePassed: true,
      }),
    ).toThrow('Terraform baseline smoke admission must use the exact current shape.');
  });

  it('admits only a passed smoke result', () => {
    expect(() =>
      validateTerraformBaselineSmokeAdmission({
        ...smokeAdmission('foundation'),
        smokeResult: 'failed',
      }),
    ).toThrow('Terraform baseline smoke result is invalid.');
  });

  it('requires the root-specific smoke type', () => {
    const value = structuredClone(smokeAdmission('app')) as Record<string, unknown>;
    value['specializedSmokeType'] = 'foundation-smoke';

    expect(() => validateTerraformBaselineSmokeAdmission(value)).toThrow(
      'Terraform baseline specialized smoke type is invalid.',
    );
  });
});

describe('accepted Terraform baseline', () => {
  it.each(Object.keys(roots) as TerraformRoot[])('admits the exact semantic unversioned %s record', (root) => {
    const parsed = validateAcceptedTerraformBaseline(baseline(root));

    expect(parsed).toEqual(baseline(root));
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ['bucketName', 'INVALID_state_bucket'],
    ['backendKey', roots.foundation.backendKey],
    ['kmsKeyArn', `arn:${target.partition}:kms:${target.region}:${mismatchedAccountId}:key/${stateKmsKeyId}`],
    ['region', 'us-east-1'],
  ] as const)('rejects backend authority with mismatched %s', (field, replacement) => {
    const original = baseline('bootstrap');
    const value = { ...original, backend: { ...original.backend, [field]: replacement } };

    expect(() => validateAcceptedTerraformBaseline(value)).toThrow(
      'Accepted Terraform baseline backend authority does not match its deployment target and state.',
    );
  });

  it.each([
    ['schemaVersion', 1], // operational-versioning-allow: rejection-fixture
    ['contractVersion', 1],
  ])('rejects retired operational version field %s', (field, fieldValue) => {
    const value = { ...baseline('bootstrap'), [field]: fieldValue };

    expect(() => validateAcceptedTerraformBaseline(value)).toThrow(
      'Accepted Terraform baseline must use the exact current shape.',
    );
  });

  it('rejects a baseline that depends on an expiring input manifest', () => {
    const value = structuredClone(baseline('app'));
    value.inputManifest.key = `pipeline-executions/app/${pipelineExecutionId}/input-manifest.json`;

    expect(() => validateAcceptedTerraformBaseline(value)).toThrow(
      'Accepted Terraform baseline input manifest must be durable and must not contain saved plans, state, or raw values.',
    );
  });

  it.each(['tfplan', 'terraform.tfplan', 'archive.tfplan.json', 'terraform.tfstate', 'raw-plan.json'])(
    'rejects historical evidence backed by %s',
    (name) => {
      const original = baseline('app');
      const value = {
        ...original,
        acceptanceEvidence: {
          ...original.acceptanceEvidence,
          key: `pipeline-executions/app/${pipelineExecutionId}/${name}`,
        },
      };

      expect(() => validateAcceptedTerraformBaseline(value)).toThrow(
        'Accepted Terraform baseline acceptance evidence must not contain saved plans, state, or raw values.',
      );
    },
  );

  it('requires an exact pipeline execution identity', () => {
    const value = { ...baseline('app'), pipelineExecutionId: 'latest-successful' };

    expect(() => validateAcceptedTerraformBaseline(value)).toThrow(
      'Accepted Terraform baseline pipeline execution ID is invalid.',
    );
  });

  it.each(['2026-08-01', '2026-08-01T03:04:05Z', '2026-08-01T12:04:05.000+09:00'])(
    'rejects noncanonical publication timestamp %s',
    (publishedAt) => {
      expect(() => validateAcceptedTerraformBaseline({ ...baseline('app'), publishedAt })).toThrow(
        'Accepted Terraform baseline publication timestamp is invalid.',
      );
    },
  );

  it('binds an admitted retained App candidate without requiring it to be the current head', () => {
    const retainedPipelineExecutionId = '22222222-3333-4444-5555-666666666666';
    const retainedAcceptanceAttemptId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const retainedPlanChecksum = '8'.repeat(64);
    const retainedCandidate = {
      pipelineExecutionId: retainedPipelineExecutionId,
      acceptanceAttemptId: retainedAcceptanceAttemptId,
      planChecksum: retainedPlanChecksum,
      controlSourceSha,
    };
    const currentHead = {
      pipelineExecutionId: 'cccccccc-dddd-eeee-ffff-000000000000',
      acceptanceAttemptId: '11111111-2222-3333-4444-555555555555',
      planChecksum: '9'.repeat(64),
      controlSourceSha: 'c'.repeat(40),
    };
    const retainedManifest = {
      ...retainedCandidate,
      ...roots.app,
    };
    const retainedBaseline = validateAcceptedTerraformBaseline({
      ...baseline('app'),
      pipelineExecutionId: retainedPipelineExecutionId,
      acceptedPlanChecksum: retainedPlanChecksum,
    });
    const retainedReference = {
      key:
        `accepted-baselines/${roots.app.stateIdentity}/executions/${retainedPipelineExecutionId}/attempts/` +
        `${retainedAcceptanceAttemptId}/baseline.json`,
      versionId: 'retained-version',
      sha256: '7'.repeat(64),
    };

    expect(retainedCandidate).not.toMatchObject(currentHead);
    expect(
      bindAdmittedAppTerraformBaseline({
        baselinePrefix: 'accepted-baselines',
        configuration: roots.app,
        candidate: retainedCandidate,
        manifest: retainedManifest,
        baseline: retainedBaseline,
        baselineReference: retainedReference,
        fetchedBaselineSha256: retainedReference.sha256,
      }),
    ).toEqual(retainedReference);
  });
});

describe('current Terraform baseline pointer', () => {
  it.each(['bootstrap', 'foundation'] as const)('admits one exact durable %s baseline selection', (root) => {
    expect(validateCurrentTerraformBaselinePointer(currentPointer(root))).toEqual(currentPointer(root));
  });

  it('routes App baseline selection through the accepted App deployment authority', () => {
    expect(() => validateCurrentTerraformBaselinePointer(currentPointer('app'))).toThrow(
      'App Terraform baseline selection belongs to the accepted App deployment authority.',
    );
  });

  it('rejects an execution-artifact baseline selection', () => {
    const value = structuredClone(currentPointer('foundation'));
    value.baseline.key = `pipeline-executions/foundation/${pipelineExecutionId}/baseline.json`;

    expect(() => validateCurrentTerraformBaselinePointer(value)).toThrow(
      'Current Terraform baseline record must be durable and must not contain saved plans, state, or raw values.',
    );
  });

  it('rejects an unknown pointer key', () => {
    const value = { ...currentPointer('bootstrap'), previousBaseline: null };

    expect(() => validateCurrentTerraformBaselinePointer(value)).toThrow(
      'Current Terraform baseline pointer must use the exact current shape.',
    );
  });
});
