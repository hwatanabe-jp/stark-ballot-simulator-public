import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
} from '@stark-ballot/deployment-authority';
import {
  buildTerraformBaselineNonsecretInputs,
  decodeTerraformBaselineNonsecretInputValues,
  validateTerraformBaselineIdentityEvidence,
  validateTerraformBaselineInputIdentity,
  validateTerraformBaselineNonsecretInputs,
  validateTerraformBaselineProviderLock,
  validateTerraformBaselineProviderSelections,
} from '@stark-ballot/deployment-authority/terraform-authority';

const controlSourceSha = 'a'.repeat(40);
const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const foreignAccountId = target.accountId === '000000000000' ? '111111111111' : '000000000000';
const stateKmsKeyId = '11111111-2222-3333-4444-555555555555';
const stateKmsKeyArn = `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${stateKmsKeyId}`;

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

  'enable_dynamodb_deletion_protection',
  'expected_image_id',
  'fargate_vcpu_alarm_threshold',
  'image_id_mapping_evidence',
  'image_signature_status_attempt_timeout_ms',
  'image_signature_status_max_attempts',
  'image_signature_status_retry_delay_ms',
  'image_signature_verifier_handler_deadline_ms',
  'image_signature_verifier_lambda_timeout_seconds',
  'image_signature_verifier_permissions_boundary_arn',
  'image_signature_verifier_process_timeout_ms',
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
          ? [`arn:aws:iam::${target.accountId}:role/operator`]
          : key.startsWith('enable_')
            ? true
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
    inputs['image_signature_status_attempt_timeout_ms'] = 4000;
    inputs['image_signature_status_max_attempts'] = 4;
    inputs['image_signature_status_retry_delay_ms'] = 5000;
    inputs['image_signature_verifier_handler_deadline_ms'] = 100000;
    inputs['image_signature_verifier_lambda_timeout_seconds'] = 120;
    inputs['image_signature_verifier_process_timeout_ms'] = 60000;
    inputs['image_signature_verifier_step_timeout_seconds'] = 130;
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

function contextBoundInputs(root: TerraformRoot, context = laneContext(root)) {
  const value = structuredClone(nonsecretInputs(root));
  const variables = parseInputVariables(value);
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
      backend_principal_arns: [`arn:aws:iam::${context.target.accountId}:role/operator`],
      control_source_sha: context.source.requestedControlSourceSha,
      github_full_repository_id: context.source.repository,
      source_branch: context.source.branch,
      state_bucket_name: context.names.terraformStateBucket,
      state_kms_alias: context.names.terraformStateKmsAlias,
      state_kms_key_id: stateKmsKeyId,
      terraform_version: '1.15.5',
    });
  } else if (root === 'app') {
    Object.assign(variables, {
      app_source_sha: context.source.selectedApplicationSourceSha,
      deploy_mode: 'normal',
      deployment_id: `dep_${'1'.repeat(32)}`,
      image_signature_verifier_permissions_boundary_arn: `arn:${context.target.partition}:iam::${context.target.accountId}:policy/${context.names.signatureVerifierPermissionsBoundary}`,
    });
  }
  if (context.target.environmentId === 'main' && root !== 'foundation') {
    if (root === 'app') {
      variables['public_hostname_disposition'] = 'external-dns-acm';
      variables['verifier_public_base_url'] = 'https://production.example.invalid';
    }
    variables[root === 'bootstrap' ? 'development_app_public_hostname' : 'public_hostname'] =
      'production.example.invalid';
    variables[
      root === 'bootstrap' ? 'development_app_cloudfront_acm_certificate_arn' : 'cloudfront_acm_certificate_arn'
    ] = `arn:aws:acm:us-east-1:${context.target.accountId}:certificate/11111111-2222-3333-4444-555555555555`;
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

  it.each(['operator_token', 'protected_production_aws_account_id'])(
    'rejects unsupported Bootstrap input %s inside an otherwise admitted file',
    (key) => {
      const value = structuredClone(nonsecretInputs('bootstrap'));
      const parsed = parseInputVariables(value);
      const body = canonicalRecordJson({ ...parsed, [key]: 'sentinel-secret-value' });
      value.files[0] = encodedInput('pipeline.auto.tfvars.json', body);

      expect(() => validateTerraformBaselineNonsecretInputs(value)).toThrow(
        'Bootstrap Terraform baseline inputs must use the exact current shape.',
      );
    },
  );

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
            stateBucketName: laneContext(root).names.terraformStateBucket,
            stateKmsAlias: laneContext(root).names.terraformStateKmsAlias,
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

  it.each([
    { principals: [] },
    { principals: [`arn:aws:iam::${foreignAccountId}:role/operator`] },
    { principals: [`arn:aws:iam::${target.accountId}:root`] },
    { principals: [`arn:aws:sts::${target.accountId}:assumed-role/operator/session`] },
    { principals: [`arn:aws:iam::${target.accountId}:role/*`] },
  ])('rejects non-target backend principals $principals', ({ principals }) => {
    const value = contextBoundInputs('bootstrap');
    const variables = parseInputVariables(value);
    variables['backend_principal_arns'] = principals;
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(variables));
    expect(() => validateTerraformBaselineInputIdentity(value, laneContext('bootstrap'))).toThrow();
  });

  it.each(['bootstrap', 'app'] as const)('rejects cross-account and wrong-region ACM in %s', (root) => {
    for (const certificate of [
      `arn:aws:acm:us-east-1:${foreignAccountId}:certificate/11111111-2222-3333-4444-555555555555`,
      `arn:aws:acm:ap-northeast-1:${target.accountId}:certificate/11111111-2222-3333-4444-555555555555`,
    ]) {
      const value = contextBoundInputs(root);
      const variables = parseInputVariables(value);
      variables[
        root === 'bootstrap' ? 'development_app_cloudfront_acm_certificate_arn' : 'cloudfront_acm_certificate_arn'
      ] = certificate;
      value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(variables));
      expect(() => validateTerraformBaselineInputIdentity(value, laneContext(root))).toThrow(
        'CloudFront ACM certificate',
      );
    }
  });

  it('binds App source and deployment mode', () => {
    const value = contextBoundInputs('app');
    const variables = parseInputVariables(value);
    variables['deploy_mode'] = 'rollback';
    value.files[0] = encodedInput('pipeline.auto.tfvars.json', canonicalRecordJson(variables));

    expect(() =>
      validateTerraformBaselineInputIdentity(value, laneContext('app'), { deploymentMode: 'normal' }),
    ).toThrow('App Terraform baseline deployment mode is invalid.');
  });
});

describe('Terraform provider inputs', () => {
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

describe('Terraform authority target separation', () => {
  it('binds each configured target backend without changing development evidence', async () => {
    const { configuration } = productionConfigurationFixture();
    vi.resetModules();
    vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
    try {
      const configuredTargets = await import('./index.js');
      const configuredAuthority = await import('./terraform-authority.js');
      const production = configuredTargets.resolveAllowedDeploymentTarget('stark-prod/main');
      for (const root of ['bootstrap', 'foundation', 'app'] as const) {
        const context = configuredTargets.renderDeploymentLaneContext({
          target: production,
          lane: root,
          accountId: production.accountId,
          requestedControlSourceSha: controlSourceSha,
          selectedApplicationSourceSha: controlSourceSha,
          frameworkSourceSha: controlSourceSha,
        });
        const backend = {
          bucketName: context.names.terraformStateBucket,
          backendKey: context.root.backendKey,
          kmsKeyArn: `arn:${production.partition}:kms:${production.region}:${production.accountId}:key/${stateKmsKeyId}`,
          region: production.region,
        };
        expect(configuredAuthority.validateTerraformBackendAuthority(backend, root, production.targetKey)).toEqual(
          backend,
        );
        for (const invalid of [
          { ...backend, backendKey: laneContext(root).root.backendKey },
          { ...backend, kmsKeyArn: stateKmsKeyArn },
          { ...backend, region: 'us-west-2' },
        ]) {
          expect(() =>
            configuredAuthority.validateTerraformBackendAuthority(invalid, root, production.targetKey),
          ).toThrow();
        }
        for (const invalidTarget of ['stark-dev/develop', 'unreviewed/main', undefined]) {
          expect(() => configuredAuthority.validateTerraformBackendAuthority(backend, root, invalidTarget)).toThrow();
        }
      }
    } finally {
      vi.doUnmock('../deployment-targets.json');
      vi.resetModules();
    }
  });
});

it('requires every App Lambda package in the immutable drift recipe and binds checkpoint image identity', async () => {
  const { admitTerraformRecipe, PLAN_TERRAFORM_RUNTIME, deriveFrontendArtifactCoordinates } =
    await import('./plan-package.js');
  const { admitRootCheckpoint } = await import('./root-checkpoint.js');
  const { resolveDeploymentLaneAuthority } = await import('./index.js');
  const { createAppReleaseSelectionFixture } = await import('./test-support/app-release-selection-fixture');
  const foundation = createAppReleaseSelectionFixture().foundation.checkpoint;
  const lane = resolveDeploymentLaneAuthority(target, 'app');
  const values = parseInputVariables(nonsecretInputs('app'));
  Object.assign(values, {
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    deployment_environment: target.environmentId,
    project_name: target.projectId,
    state_backend_key: lane.backendKey,
    state_scope: lane.scope,
    app_source_sha: foundation.sourceSha,
    deployment_id: `dep_${'c'.repeat(32)}`,
    expected_image_id: `0x${'2'.repeat(64)}`,
    prover_image_uri: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${lane.names.proverRepository}@sha256:${'b'.repeat(64)}`,
  });
  const lambdas = values['lambda_artifacts'] as Record<
    string,
    { s3_bucket: string; s3_key: string; s3_object_version: string; source_code_hash: string }
  >;
  for (const artifact of Object.values(lambdas)) artifact.s3_bucket = lane.names.appRetainedArtifactBucket;
  const recipe = {
    runtime: PLAN_TERRAFORM_RUNTIME,
    providerLock: foundation.recipe.providerLock,
    nonsecretInputs: buildTerraformBaselineNonsecretInputs('app', {
      variables: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
    }),
    artifacts: Object.entries(lambdas).map(([name, artifact]) => ({
      path: `.artifacts/${name}.zip`,
      bucket: artifact.s3_bucket,
      reference: {
        key: artifact.s3_key,
        versionId: artifact.s3_object_version,
        sha256: Buffer.from(artifact.source_code_hash, 'base64').toString('hex'),
      },
    })),
  };
  recipe.artifacts.push(
    ...deriveFrontendArtifactCoordinates(target.targetKey, values['app_source_sha'], values['deployment_id']).map(
      ({ path, bucket, key }) => ({
        path,
        bucket,
        reference: { key, versionId: 'frontend-version', sha256: 'f'.repeat(64) },
      }),
    ),
  );
  expect(admitTerraformRecipe(recipe, target.targetKey, 'app').artifacts).toHaveLength(9);
  expect(() =>
    admitTerraformRecipe({ ...recipe, artifacts: recipe.artifacts.slice(0, 6) }, target.targetKey, 'app'),
  ).toThrow('omits');
  const wrongFrontendBucket = structuredClone(recipe);
  const frontendEntry = wrongFrontendBucket.artifacts.at(-1);
  if (!frontendEntry) throw new Error('Missing frontend fixture');
  frontendEntry.bucket = lane.names.artifactBucket;
  expect(() => admitTerraformRecipe(wrongFrontendBucket, target.targetKey, 'app')).toThrow(
    'reviewed source/deployment',
  );
  for (const field of ['key', 'versionId', 'sha256'] as const) {
    const tampered = structuredClone(recipe);
    const entry = tampered.artifacts.at(-1);
    if (!entry) throw new Error('Missing frontend fixture');
    entry.reference[field] = field === 'key' ? 'unrelated/config.json' : '';
    expect(() => admitTerraformRecipe(tampered, target.targetKey, 'app')).toThrow();
  }
  expect(() => admitTerraformRecipe({ ...recipe, artifacts: [] }, target.targetKey, 'app')).toThrow('omits');
  expect(() =>
    admitTerraformRecipe(
      {
        ...recipe,
        artifacts: recipe.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, reference: { ...artifact.reference, versionId: 'changed' } } : artifact,
        ),
      },
      target.targetKey,
      'app',
    ),
  ).toThrow('immutable Terraform Lambda input');
  const checkpoint = {
    ...foundation,
    root: 'app',
    backend: { ...foundation.backend, backendKey: lane.backendKey },
    execution: {
      ...foundation.execution,
      kind: 'pipeline',
      pipelineName: lane.names.pipeline,
      planActionExecutionId: foundation.execution.executionId,
      buildId: `${lane.names.terraformPlanProject}:${foundation.execution.executionId}`,
    },
    planPackage: {
      ...foundation.planPackage,
      key: `deployment/${target.targetKey}/app/plan-packages/${foundation.execution.executionId}.json`,
    },
    recipe,
    outputs: {
      deploymentId: `dep_${'c'.repeat(32)}`,
      proverImageDigest: `sha256:${'b'.repeat(64)}`,
      imageId: `0x${'2'.repeat(64)}`,
      methodVersion: 1,
      planDisposition: 'changed',
      runtimeIdentity: { outputsSha256: 'd'.repeat(64), frontendManifestSha256: 'e'.repeat(64) },
    },
  };
  expect(admitRootCheckpoint(checkpoint, target.targetKey, 'app').root).toBe('app');
  // Exercise delivery against the real admitted App checkpoint/recipe, including
  // delayed notifications, duplicate delivery and both independent CAS races.
  const { publishCurrentAppDeploymentStatus } = await import('./app-deployment-status-publication.js');
  const { assertObjectPrecondition } = await import('./mutation-owner.js');
  type Stored = { body: string; observation: import('./plan-package.js').ObjectObservation };
  const stored = (key: string, body: string, versionId = 'opaque-version'): Stored => ({
    body,
    observation: { key, versionId, etag: `"${versionId}"`, sha256: createHash('sha256').update(body).digest('hex') },
  });
  const checkpointObject = stored(
    `deployment/${target.targetKey}/app/checkpoint.json`,
    canonicalRecordJson(admitRootCheckpoint(checkpoint, target.targetKey, 'app')),
  );
  const objects = new Map<string, Stored>([[checkpointObject.observation.key, checkpointObject]]);
  const store = {
    read: (key: string) => objects.get(key) ?? null,
    write: vi.fn((key: string, body: string, expected: Stored['observation'] | null) => {
      assertObjectPrecondition(expected, objects.get(key)?.observation ?? null);
      const result = stored(key, body, 'status-version');
      objects.set(key, result);
      return result;
    }),
  };
  const expected = {
    targetKey: target.targetKey,
    sourceSha: checkpoint.sourceSha,
    executionId: checkpoint.execution.executionId,
  };
  await expect(publishCurrentAppDeploymentStatus(store, expected)).resolves.toMatchObject({ status: 'published' });
  const statusBytes = objects.get('status/current.json')?.body;
  await expect(publishCurrentAppDeploymentStatus(store, expected)).resolves.toMatchObject({ status: 'unchanged' });
  await expect(
    publishCurrentAppDeploymentStatus(store, { ...expected, executionId: '99999999-2222-3333-4444-555555555555' }),
  ).resolves.toMatchObject({ status: 'superseded' });
  expect(store.write).toHaveBeenCalledTimes(1);
  expect(objects.get('status/current.json')?.body).toBe(statusBytes);
  objects.delete('status/current.json');
  let checkpointReads = 0;
  await expect(
    publishCurrentAppDeploymentStatus(
      {
        ...store,
        read(key) {
          if (key === checkpointObject.observation.key && ++checkpointReads === 2)
            return stored(key, checkpointObject.body, 'advanced-checkpoint');
          return store.read(key);
        },
      },
      expected,
    ),
  ).rejects.toThrow();
  expect(store.write).toHaveBeenCalledTimes(1);
  await expect(
    publishCurrentAppDeploymentStatus(
      {
        ...store,
        write(key, body, previous) {
          objects.set(key, stored(key, body, 'concurrent-status'));
          return store.write(key, body, previous);
        },
      },
      expected,
    ),
  ).rejects.toThrow();
  objects.delete('status/current.json');
  await expect(
    publishCurrentAppDeploymentStatus(
      {
        ...store,
        write() {
          throw new Error('publication denied');
        },
      },
      expected,
    ),
  ).rejects.toThrow('publication denied');
  expect(objects.has('status/current.json')).toBe(false);

  expect(() =>
    admitRootCheckpoint(
      { ...checkpoint, outputs: { ...checkpoint.outputs, imageId: `0x${'f'.repeat(64)}` } },
      target.targetKey,
      'app',
    ),
  ).toThrow('approved inputs');
});
