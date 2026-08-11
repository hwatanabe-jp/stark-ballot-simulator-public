import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDeploymentTargetConfiguration } from '@stark-ballot/deployment-authority';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/render-backend-config.sh');
const REVIEWED_TARGET = parseDeploymentTargetConfiguration(
  JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'packages/deployment-authority/deployment-targets.json'), 'utf8'),
  ),
).allowedTargets['stark-dev/develop'];
const REVIEWED_STATE_BUCKET = REVIEWED_TARGET.sharedNames.terraformStateBucket;
const REVIEWED_STATE_KMS_ALIAS = REVIEWED_TARGET.sharedNames.terraformStateKmsAlias;

function terraformBackendTestEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'TERRAFORM_STATE_BUCKET',
    'TERRAFORM_STATE_BUCKET_NAME',
    'TERRAFORM_ACCOUNT_ALIAS',
    'TERRAFORM_DEPLOYMENT_ENVIRONMENT',
    'TERRAFORM_STATE_SCOPE',
    'TERRAFORM_STATE_KMS_KEY_ID',
    'TERRAFORM_STATE_KMS_ALIAS',
    'TERRAFORM_AWS_REGION',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'render-backend-config-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('render-backend-config.sh', () => {
  it('renders a local backend config without logging the bucket name', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        ['TERRAFORM_STATE_BUCKET=example-terraform-state', 'TERRAFORM_AWS_REGION=ap-northeast-1'].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Wrote local Terraform backend config');
      expect(result.stdout).not.toContain('example-terraform-state');
      expect(result.stderr).toBe('');

      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain('bucket       = "example-terraform-state"');
      expect(rendered).toContain('key          = "terraform.tfstate"');
      expect(rendered).toContain('region       = "ap-northeast-1"');
      expect(rendered).toContain('use_lockfile = true');
      expect(rendered).toContain('encrypt      = true');
    });
  });

  it('renders an account-aware target account backend key when state identity is supplied', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        [
          `TERRAFORM_STATE_BUCKET=${REVIEWED_STATE_BUCKET}`,
          'TERRAFORM_ACCOUNT_ALIAS=stark-dev',
          'TERRAFORM_DEPLOYMENT_ENVIRONMENT=develop',
          'TERRAFORM_STATE_SCOPE=bootstrap',
          `TERRAFORM_STATE_KMS_ALIAS=${REVIEWED_STATE_KMS_ALIAS}`,
          'TERRAFORM_AWS_REGION=ap-northeast-1',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(REVIEWED_STATE_BUCKET);
      expect(result.stdout).not.toContain('stark-dev');

      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain(`bucket       = "${REVIEWED_STATE_BUCKET}"`);
      expect(rendered).toContain(
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
      );
      expect(rendered).toContain(`kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`);
      expect(rendered).not.toContain('key          = "terraform.tfstate"');
    });
  });

  it.each([
    ['bootstrap', 'stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate'],
    ['foundation', 'stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate'],
    ['app', 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate'],
  ] as const)('derives the reviewed development %s backend values from target identity', (scope, backendKey) => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_ACCOUNT_ALIAS=stark-dev',
          'TERRAFORM_DEPLOYMENT_ENVIRONMENT=develop',
          `TERRAFORM_STATE_SCOPE=${scope}`,
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(REVIEWED_STATE_BUCKET);

      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain(`bucket       = "${REVIEWED_STATE_BUCKET}"`);
      expect(rendered).toContain(`key          = "${backendKey}"`);
      expect(rendered).toContain('region       = "ap-northeast-1"');
      expect(rendered).toContain(`kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`);
      expect(rendered).toContain('use_lockfile = true');
      expect(rendered).toContain('encrypt      = true');
    });
  });

  it.each([
    {
      label: 'state bucket',
      stateBucket: 'wrong-terraform-state',
      stateKmsAlias: REVIEWED_STATE_KMS_ALIAS,
      expected: 'Terraform target state bucket does not match the reviewed deployment configuration.',
    },
    {
      label: 'state KMS key',
      stateBucket: REVIEWED_STATE_BUCKET,
      stateKmsAlias: 'alias/wrong-terraform-state',
      expected: 'Terraform target state KMS key does not match the reviewed deployment configuration.',
    },
  ])('rejects a target backend with the wrong reviewed $label', ({ expected, stateBucket, stateKmsAlias }) => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        [
          `TERRAFORM_STATE_BUCKET=${stateBucket}`,
          'TERRAFORM_ACCOUNT_ALIAS=stark-dev',
          'TERRAFORM_DEPLOYMENT_ENVIRONMENT=develop',
          'TERRAFORM_STATE_SCOPE=bootstrap',
          `TERRAFORM_STATE_KMS_ALIAS=${stateKmsAlias}`,
          'TERRAFORM_AWS_REGION=ap-northeast-1',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
      expect(() => readFileSync(outputFile, 'utf8')).toThrow();
    });
  });

  it('rejects a well-formed target region that differs from the reviewed deployment configuration', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_STATE_BUCKET=example-terraform-state',
          'TERRAFORM_ACCOUNT_ALIAS=stark-dev',
          'TERRAFORM_DEPLOYMENT_ENVIRONMENT=develop',
          'TERRAFORM_STATE_SCOPE=app',
          'TERRAFORM_AWS_REGION=us-east-1',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Reviewed target region: ap-northeast-1');
      expect(() => readFileSync(outputFile, 'utf8')).toThrow();
    });
  });

  it('lets explicit shell environment values override .env defaults', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        ['TERRAFORM_STATE_BUCKET=envfile-terraform-state', 'TERRAFORM_AWS_REGION=ap-northeast-1'].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv({
          TERRAFORM_STATE_BUCKET: 'shell-terraform-state',
          TERRAFORM_AWS_REGION: 'us-east-1',
        }),
      });

      expect(result.status).toBe(0);
      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain('bucket       = "shell-terraform-state"');
      expect(rendered).toContain('region       = "us-east-1"');
      expect(rendered).not.toContain('envfile-terraform-state');
    });
  });

  it('fails clearly when the state bucket is missing', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      writeFileSync(envFile, 'TERRAFORM_AWS_REGION=ap-northeast-1\n');

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Missing required Terraform backend values');
      expect(result.stderr).toContain('TERRAFORM_STATE_BUCKET');
    });
  });

  it('rejects partial target account state identity values', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_STATE_BUCKET=example-terraform-state',
          'TERRAFORM_ACCOUNT_ALIAS=stark-dev',
          'TERRAFORM_DEPLOYMENT_ENVIRONMENT=develop',
          'TERRAFORM_AWS_REGION=ap-northeast-1',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Target account backend mode requires all state identity values');
      expect(result.stderr).toContain('TERRAFORM_STATE_SCOPE');
    });
  });

  it.each([
    ['stark-prod', 'main', 'bootstrap'],
    ['stark-prod', 'main', 'app'],
  ])('rejects unauthorized bootstrap backend identity %s/%s/%s', (accountAlias, deploymentEnvironment, stateScope) => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'backend.local.hcl');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_STATE_BUCKET=example-terraform-state',
          `TERRAFORM_ACCOUNT_ALIAS=${accountAlias}`,
          `TERRAFORM_DEPLOYMENT_ENVIRONMENT=${deploymentEnvironment}`,
          `TERRAFORM_STATE_SCOPE=${stateScope}`,
          'TERRAFORM_AWS_REGION=ap-northeast-1',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformBackendTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        `Terraform target ${accountAlias}/${deploymentEnvironment}/${stateScope} is not authorized by the reviewed deployment configuration.`,
      );
      expect(result.stdout).not.toContain('example-terraform-state');
      expect(() => readFileSync(outputFile, 'utf8')).toThrow();
    });
  });
});
