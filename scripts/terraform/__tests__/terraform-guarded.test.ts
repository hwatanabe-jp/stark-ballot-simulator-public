import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDeploymentTargetConfiguration, resolveAllowedDeploymentTarget } from '@stark-ballot/deployment-authority';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/terraform-guarded.sh');
const REVIEWED_DEVELOP_ACCOUNT_ID = resolveAllowedDeploymentTarget('stark-dev/develop').accountId;
const REVIEWED_TARGET = parseDeploymentTargetConfiguration(
  JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'packages/deployment-authority/deployment-targets.json'), 'utf8'),
  ),
).allowedTargets['stark-dev/develop'];
const REVIEWED_STATE_BUCKET = REVIEWED_TARGET.sharedNames.terraformStateBucket;
const REVIEWED_STATE_KMS_ALIAS = REVIEWED_TARGET.sharedNames.terraformStateKmsAlias;
const APP_SIGNATURE_PREFLIGHT_PLAN_ROLE = `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-sig-preflight-plan-stark-dev-develop-app/codebuild-test`;
const APP_SIGNATURE_PREFLIGHT_APPLY_ROLE = `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-sig-preflight-apply-stark-dev-develop-app/codebuild-test`;
const APP_SIGNATURE_STATE_REFRESH_APPLY_ROLE = `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-sig-state-refresh-apply-stark-dev-develop-app/codebuild-test`;
const APP_SIGNATURE_PREFLIGHT_TARGET_ARGS = [
  '-target=terraform_data.image_signature_verifier_permissions_boundary_authority',
  '-target=aws_cloudwatch_log_group.image_signature_verifier',
  '-target=aws_iam_role.image_signature_verifier',
  '-target=aws_iam_role_policy.image_signature_verifier',
  '-target=aws_lambda_function.image_signature_verifier',
  '-target=aws_lambda_alias.image_signature_verifier_preflight',
] as const;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'terraform-guarded-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMockBin(dir: string, name: string, body: string): string {
  const binDir = path.join(dir, 'bin');
  const file = path.join(binDir, name);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return binDir;
}

function testEnv(dir: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'TERRAFORM_AWS_ACCOUNT_ID_DEVELOP',
    'TERRAFORM_AWS_ACCOUNT_ID_MAIN',
    'TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV',
    'TERRAFORM_AWS_ACCOUNT_ID_STARK_PROD',
    'TERRAFORM_ALLOWED_PRINCIPAL_ARN_PATTERN',
    'TERRAFORM_AWS_ACCOUNT_ID',
    'AWS_ACCOUNT_ID',
    'MOCK_AWS_ACCOUNT',
    'MOCK_AWS_ARN',
    'MOCK_TERRAFORM_WORKSPACE',
    'MOCK_TERRAFORM_LOG',
    'TERRAFORM_WORKING_DIR',
    'TERRAFORM_APP_BACKEND_BUCKET',
    'TERRAFORM_APP_BACKEND_REGION',
    'TERRAFORM_APP_BACKEND_KMS_KEY_ID',
    'TERRAFORM_STATE_BUCKET',
    'TERRAFORM_STATE_BUCKET_NAME',
    'TERRAFORM_STATE_KMS_ALIAS',
    'TERRAFORM_STATE_KMS_KEY_ID',
    'TERRAFORM_AWS_REGION',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    PATH: `${path.join(dir, 'bin')}:${env['PATH'] ?? ''}`,
    TERRAFORM_AWS_ACCOUNT_ID: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
    MOCK_AWS_ACCOUNT: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
    MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/terraform-admin/aws-vault-test`,
    MOCK_TERRAFORM_WORKSPACE: 'develop',
    MOCK_TERRAFORM_LOG: path.join(dir, 'terraform.log'),
    ...extra,
  };
}

function installMocks(dir: string): void {
  writeMockBin(
    dir,
    'aws',
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "sts" ] && [ "$2" = "get-caller-identity" ]; then
  printf '%s\\t%s\\n' "\${MOCK_AWS_ACCOUNT}" "\${MOCK_AWS_ARN}"
  exit 0
fi
echo "unexpected aws command: $*" >&2
exit 99
`,
  );

  writeMockBin(
    dir,
    'terraform',
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${MOCK_TERRAFORM_LOG}"
if { [ "$1" = "-chdir=infra/terraform/legacy" ] || [ "$1" = "-chdir=infra/terraform/bootstrap" ] || [ "$1" = "-chdir=infra/terraform/app" ]; } && [ "$2" = "workspace" ] && [ "$3" = "show" ]; then
  printf '%s\\n' "\${MOCK_TERRAFORM_WORKSPACE}"
  exit 0
fi
exit 0
`,
  );
}

function writeTfvars(dir: string, environment: 'develop' | 'main'): string {
  const file = path.join(dir, `${environment}.local.tfvars`);
  writeFileSync(file, `aws_region = "ap-northeast-1"\nenvironment = "${environment}"\n`);
  return file;
}

function writeBootstrapTfvars(
  dir: string,
  environment: 'develop' | 'main',
  overrides: Record<string, string> = {},
): string {
  const file = path.join(dir, `${environment}.local.tfvars`);
  const values = {
    aws_region: 'ap-northeast-1',
    aws_account_id: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
    account_alias: 'stark-dev',
    deployment_environment: environment,
    state_scope: 'bootstrap',
    state_backend_key: `stark-ballot-simulator/stark-dev/${environment}/bootstrap/terraform.tfstate`,
    ...overrides,
  };
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key} = "${value}"`)
      .join('\n') + '\n',
  );
  return file;
}

function writeAppTfvars(dir: string, overrides: Record<string, string> = {}): string {
  const file = path.join(dir, 'pipeline.auto.tfvars');
  const values = {
    aws_region: 'ap-northeast-1',
    aws_account_id: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
    account_alias: 'stark-dev',
    deployment_environment: 'develop',
    state_scope: 'app',
    state_backend_key: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
    ...overrides,
  };
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key} = "${value}"`)
      .join('\n') + '\n',
  );
  return file;
}

function appBackendEnv(): Record<string, string> {
  return {
    TERRAFORM_APP_BACKEND_BUCKET: 'example-terraform-state',
    TERRAFORM_APP_BACKEND_REGION: 'ap-northeast-1',
    TERRAFORM_APP_BACKEND_KMS_KEY_ID: 'alias/example-terraform-state',
  };
}

function writeAppBackendConfig(
  dir: string,
  options: {
    filename?: 'backend.local.hcl' | 'backend.pipeline.hcl';
    overrides?: Record<string, string>;
    omit?: string[];
  } = {},
): void {
  const filename = options.filename ?? 'backend.pipeline.hcl';
  const values = {
    bucket: 'example-terraform-state',
    key: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
    region: 'ap-northeast-1',
    kms_key_id: 'alias/example-terraform-state',
    use_lockfile: 'true',
    encrypt: 'true',
    ...options.overrides,
  };
  const omitted = new Set(options.omit ?? []);

  mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
  writeFileSync(
    path.join(dir, 'infra/terraform/app', filename),
    Object.entries(values)
      .filter(([key]) => !omitted.has(key))
      .map(([key, value]) => `${key} = "${value}"`)
      .join('\n') + '\n',
  );
}

type AppBackendConfigOptions = NonNullable<Parameters<typeof writeAppBackendConfig>[1]>;

describe('terraform-guarded.sh', () => {
  it('consumes reviewed target root and role values instead of reconstructing them in shell', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');

    expect(source).toContain('.allowedTargets[$target_key] as $target');
    expect(source).toContain('$target.lanes[$lane] as $root');
    expect(source).toContain('$root.backendKey');
    expect(source).toContain('$root.names.terraformPlanRole');
    expect(source).not.toContain("printf 'stark-ballot-sim-tf-plan-%s-%s-app'");
    expect(source).not.toContain('expected_key="stark-ballot-simulator/${identity}/terraform.tfstate"');
  });

  it('rejects a well-formed target account that is absent from the reviewed deployment configuration', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      writeFileSync(path.join(dir, 'reviewed.tfplan'), 'mock saved plan');

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'apply', path.join(dir, 'reviewed.tfplan')],
        {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: '111122223333',
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ACCOUNT: '111122223333',
            MOCK_AWS_ARN: 'arn:aws:sts::111122223333:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00',
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Reviewed target account: ${REVIEWED_DEVELOP_ACCOUNT_ID}`);
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('rejects target execution when canonical deployment configuration admission fails', () => {
    withTempDir((dir) => {
      installMocks(dir);
      writeMockBin(dir, 'node', '#!/usr/bin/env bash\nexit 7\n');

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'validate'], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: REVIEWED_DEVELOP_ACCOUNT_ID,
          TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
          MOCK_AWS_ACCOUNT: REVIEWED_DEVELOP_ACCOUNT_ID,
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Reviewed deployment target configuration failed canonical admission.');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('runs Terraform only after caller, workspace, and tfvars environment checks pass', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for develop.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/legacy workspace show');
      expect(log).toContain(`-chdir=infra/terraform/legacy plan -var-file=${tfvars}`);
    });
  });

  it('passes Terraform the same canonical tfvars path that the guard validated', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/legacy'), { recursive: true });
      writeFileSync(path.join(dir, 'develop.local.tfvars'), 'aws_region = "ap-northeast-1"\nenvironment = "main"\n');
      const checkedTfvars = path.join(dir, 'infra/terraform/legacy/develop.local.tfvars');
      writeFileSync(checkedTfvars, 'aws_region = "ap-northeast-1"\nenvironment = "develop"\n');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', '-var-file=develop.local.tfvars'], {
        cwd: dir,
        encoding: 'utf8',
        env: testEnv(dir),
      });

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(`-chdir=infra/terraform/legacy plan -var-file=${checkedTfvars}`);
      expect(log).not.toContain('-chdir=infra/terraform/legacy plan -var-file=develop.local.tfvars');
    });
  });

  it('rejects a default IAM user before running Terraform', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          MOCK_AWS_ARN: `arn:aws:iam::${REVIEWED_DEVELOP_ACCOUNT_ID}:user/user01`,
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        `Terraform must run as arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/terraform-admin/*`,
      );
      expect(result.stderr).not.toContain('user01');
      expect(result.stderr).toContain('Current caller ARN did not match the required role.');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('rejects a terraform-admin role in the wrong AWS account', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          MOCK_AWS_ACCOUNT: '999999999999',
          MOCK_AWS_ARN: 'arn:aws:sts::999999999999:assumed-role/terraform-admin/aws-vault-test',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('AWS account mismatch');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('rejects a workspace that does not match the requested environment', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          MOCK_TERRAFORM_WORKSPACE: 'main',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform workspace mismatch');
      expect(result.stderr).toContain('Expected workspace: develop');
      expect(result.stderr).toContain('Current workspace: main');
    });
  });

  it('rejects a tfvars file whose environment does not match the requested environment', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = path.join(dir, 'develop.local.tfvars');
      writeFileSync(tfvars, 'aws_region = "ap-northeast-1"\nenvironment = "main"\n');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('tfvars environment mismatch');
      expect(result.stderr).toContain('Expected environment: develop');
      expect(result.stderr).toContain('tfvars environment: main');
    });
  });

  it('requires a var-file for plan, apply, and destroy', () => {
    withTempDir((dir) => {
      installMocks(dir);

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan'], {
        encoding: 'utf8',
        env: testEnv(dir),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('plan requires -var-file=<env>.local.tfvars');
    });
  });

  it('allows applying a saved target Terraform plan without a var-file', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      writeFileSync(path.join(dir, 'reviewed.tfplan'), 'mock saved plan');

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'apply', path.join(dir, 'reviewed.tfplan')],
        {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(`-chdir=infra/terraform/bootstrap apply ${path.join(dir, 'reviewed.tfplan')}`);
    });
  });

  it('rejects multiple var-files because later files can override environment', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const developTfvars = writeTfvars(dir, 'develop');
      const mainTfvars = writeTfvars(dir, 'main');

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'develop', 'plan', `-var-file=${developTfvars}`, `-var-file=${mainTfvars}`],
        {
          encoding: 'utf8',
          env: testEnv(dir),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('plan accepts exactly one -var-file');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/legacy workspace show');
      expect(log).not.toContain(`-chdir=infra/terraform/legacy plan -var-file=${developTfvars}`);
    });
  });

  it('rejects CLI environment overrides', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`, '-var', 'environment=main'],
        {
          encoding: 'utf8',
          env: testEnv(dir),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Do not pass environment through -var');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/legacy workspace show');
      expect(log).not.toContain(`-chdir=infra/terraform/legacy plan -var-file=${tfvars}`);
    });
  });

  it('rejects target account terraform init against the legacy Terraform root', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/legacy'), { recursive: true });
      const backendConfig = path.join(dir, 'infra/terraform/legacy/backend.local.hcl');
      writeFileSync(
        backendConfig,
        [
          'bucket       = "example-terraform-state"',
          'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
          'region       = "ap-northeast-1"',
          'use_lockfile = true',
          'encrypt      = true',
        ].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'init', '-backend-config=backend.local.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform working directory mismatch for target account mode.');
      expect(result.stderr).toContain('Expected TERRAFORM_WORKING_DIR: infra/terraform/bootstrap');
      expect(result.stderr).toContain('Current TERRAFORM_WORKING_DIR: infra/terraform/legacy');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('runs target account terraform init after caller, root, and backend identity checks pass', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      writeFileSync(
        path.join(dir, 'infra/terraform/bootstrap/backend.local.hcl'),
        [
          `bucket       = "${REVIEWED_STATE_BUCKET}"`,
          'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
          'region       = "ap-northeast-1"',
          `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
          'use_lockfile = true',
          'encrypt      = true',
        ].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'init', '-backend-config=backend.local.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/bootstrap.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).not.toContain('-chdir=infra/terraform/legacy workspace show');
      expect(log).toContain('-chdir=infra/terraform/bootstrap init -backend-config=backend.local.hcl');
    });
  });

  it('rejects target account terraform init when backend key does not match the state identity', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      writeFileSync(
        path.join(dir, 'infra/terraform/bootstrap/backend.local.hcl'),
        [
          `bucket       = "${REVIEWED_STATE_BUCKET}"`,
          'key          = "terraform.tfstate"',
          'region       = "ap-northeast-1"',
          `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
          'use_lockfile = true',
          'encrypt      = true',
        ].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'init', '-backend-config=backend.local.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform backend key mismatch');
      expect(result.stderr).toContain(
        'Expected key: stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([
    {
      label: 'missing bucket',
      lines: [
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend config must include bucket.',
    },
    {
      label: 'wrong bucket',
      lines: [
        'bucket       = "wrong-terraform-state"',
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend bucket mismatch.',
    },
    {
      label: 'missing KMS',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend config must include kms_key_id.',
    },
    {
      label: 'wrong KMS',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        'kms_key_id   = "alias/wrong-terraform-state"',
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend kms_key_id mismatch.',
    },
    {
      label: 'missing region',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend config must include region.',
    },
    {
      label: 'wrong region',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "us-east-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend region mismatch.',
    },
    {
      label: 'missing lockfile control',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'encrypt      = true',
      ],
      expected: 'Terraform target backend config must include use_lockfile.',
    },
    {
      label: 'disabled lockfile control',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = false',
        'encrypt      = true',
      ],
      expected: 'Terraform target backend use_lockfile mismatch.',
    },
    {
      label: 'missing encryption control',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
      ],
      expected: 'Terraform target backend config must include encrypt.',
    },
    {
      label: 'disabled encryption',
      lines: [
        `bucket       = "${REVIEWED_STATE_BUCKET}"`,
        'key          = "stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate"',
        'region       = "ap-northeast-1"',
        `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
        'use_lockfile = true',
        'encrypt      = false',
      ],
      expected: 'Terraform target backend encrypt mismatch.',
    },
  ])('rejects target account init with $label', ({ expected, lines }) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      writeFileSync(path.join(dir, 'infra/terraform/bootstrap/backend.local.hcl'), lines.join('\n'));

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'init', '-backend-config=backend.local.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('applies the exact target backend validator to Foundation init', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/foundation'), { recursive: true });
      writeFileSync(
        path.join(dir, 'infra/terraform/foundation/backend.pipeline.hcl'),
        [
          `bucket       = "${REVIEWED_STATE_BUCKET}"`,
          'key          = "stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate"',
          'region       = "ap-northeast-1"',
          `kms_key_id   = "${REVIEWED_STATE_KMS_ALIAS}"`,
          'use_lockfile = true',
          'encrypt      = true',
        ].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/foundation', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/foundation',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/${REVIEWED_TARGET.lanes.foundation.names.terraformPlanRole}/codebuild-test`,
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/foundation.');
      expect(readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toContain(
        '-chdir=infra/terraform/foundation init -backend-config=backend.pipeline.hcl',
      );
    });
  });

  it('requires the default workspace for target account plan/apply commands', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      const tfvars = writeBootstrapTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          MOCK_TERRAFORM_WORKSPACE: 'develop',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform workspace mismatch');
      expect(result.stderr).toContain('Expected workspace: default');
      expect(result.stderr).toContain('Current workspace: develop');
    });
  });

  it('allows target account plan to pass the development pipeline toggle through -var', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      const tfvars = writeBootstrapTfvars(dir, 'develop');

      const result = spawnSync(
        'bash',
        [
          SCRIPT_PATH,
          'stark-dev/develop/bootstrap',
          'plan',
          `-var-file=${tfvars}`,
          '-var=enable_development_pipeline=true',
        ],
        {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/bootstrap.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(
        `-chdir=infra/terraform/bootstrap plan -var-file=${tfvars} -var=enable_development_pipeline=true`,
      );
    });
  });

  it.each([
    [['-var=account_alias=stark-prod'], 'account_alias'],
    [['-var', 'source_branch=main'], 'source_branch'],
  ])('rejects target account CLI override for protected %s', (overrideArgs, protectedKey) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      const tfvars = writeBootstrapTfvars(dir, 'develop');

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'plan', `-var-file=${tfvars}`, ...overrideArgs],
        {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Do not pass ${protectedKey} through -var in target account mode`);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/bootstrap workspace show');
      expect(log).not.toContain(`-chdir=infra/terraform/bootstrap plan -var-file=${tfvars}`);
    });
  });

  it.each([
    ['account_alias', 'stark-prod'],
    ['state_backend_key', 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate'],
    ['source_branch', 'main'],
  ])('rejects target account tfvars mismatch for %s', (key, value) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/bootstrap'), { recursive: true });
      const tfvars = writeBootstrapTfvars(dir, 'develop', { [key]: value });

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/bootstrap', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/bootstrap',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`target account tfvars ${key} mismatch`);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/bootstrap workspace show');
      expect(log).not.toContain(`-chdir=infra/terraform/bootstrap plan -var-file=${tfvars}`);
    });
  });

  it('rejects app target scope when the app Terraform root is not selected', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform working directory mismatch for target account mode.');
      expect(result.stderr).toContain('Expected TERRAFORM_WORKING_DIR: infra/terraform/app');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([['stark-prod/main/bootstrap']])(
    'rejects unauthorized target bootstrap identity %s before running Terraform',
    (identity) => {
      withTempDir((dir) => {
        installMocks(dir);
        const tfvars = writeBootstrapTfvars(dir, identity.includes('/main/') ? 'main' : 'develop');

        const result = spawnSync('bash', [SCRIPT_PATH, identity, 'plan', `-var-file=${tfvars}`], {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_AWS_ACCOUNT_ID_STARK_PROD: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_ALLOWED_PRINCIPAL_ARN_PATTERN: `^arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_[A-Za-z0-9]+/.+$`,
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          'Terraform target stark-prod/main/bootstrap is not authorized by the reviewed deployment configuration.',
        );
        expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
      });
    },
  );

  it('rejects executing the repository-only protected-production app contract', () => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir, {
        overrides: {
          key: 'stark-ballot-simulator/stark-prod/main/app/terraform.tfstate',
        },
      });

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-prod/main/app', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_PROD: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-prod-main-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'Terraform target stark-prod/main/app is not authorized by the reviewed deployment configuration.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('allows app plan role to initialize the app backend after caller, root, and backend identity checks pass', () => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/app.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app init -backend-config=backend.pipeline.hcl');
    });
  });

  it('allows app apply role to run only the guarded backend init needed before saved-plan apply', () => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/app.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app init -backend-config=backend.pipeline.hcl');
    });
  });

  it.each([
    ['plan', APP_SIGNATURE_PREFLIGHT_PLAN_ROLE],
    ['apply', APP_SIGNATURE_PREFLIGHT_APPLY_ROLE],
    ['state refresh apply', APP_SIGNATURE_STATE_REFRESH_APPLY_ROLE],
  ])('allows current signature-preflight %s role to run guarded backend init', (_roleType, roleArn) => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: roleArn,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terraform guard passed for stark-dev/develop/app.');
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app init -backend-config=backend.pipeline.hcl');
    });
  });

  it('allows the current signature-preflight plan role to validate app Terraform', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'validate'], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: APP_SIGNATURE_PREFLIGHT_PLAN_ROLE,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app validate');
    });
  });

  it.each([
    ['-migrate-state'],
    ['-force-copy'],
    ['-input=false'],
    ['-backend-config=backend.local.hcl', '-backend-config=backend.pipeline.hcl'],
  ])('rejects unsafe app init arguments %s', (...unsafeArgs) => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.pipeline.hcl', ...unsafeArgs],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'app init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('rejects local backend files for app CodeBuild init', () => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir, { filename: 'backend.local.hcl' });

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.local.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'app init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  const invalidAppBackendCases: Array<{
    label: string;
    options: AppBackendConfigOptions;
    expected: string;
  }> = [
    {
      label: 'wrong bucket',
      options: { overrides: { bucket: 'wrong-terraform-state' } },
      expected: 'Terraform app backend bucket mismatch.',
    },
    {
      label: 'wrong KMS',
      options: { overrides: { kms_key_id: 'alias/wrong-terraform-state' } },
      expected: 'Terraform app backend kms_key_id mismatch.',
    },
    {
      label: 'wrong region',
      options: { overrides: { region: 'us-east-1' } },
      expected: 'Terraform app backend region mismatch.',
    },
    {
      label: 'missing encrypt',
      options: { omit: ['encrypt'] },
      expected: 'Terraform app backend config must include encrypt.',
    },
    {
      label: 'wrong encrypt',
      options: { overrides: { encrypt: 'false' } },
      expected: 'Terraform app backend encrypt mismatch.',
    },
    {
      label: 'missing use_lockfile',
      options: { omit: ['use_lockfile'] },
      expected: 'Terraform app backend config must include use_lockfile.',
    },
  ];

  it.each(invalidAppBackendCases)('rejects app init when backend.pipeline.hcl has $label', ({ expected, options }) => {
    withTempDir((dir) => {
      installMocks(dir);
      writeAppBackendConfig(dir, options);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'init', '-backend-config=backend.pipeline.hcl'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            ...appBackendEnv(),
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('does not let the app apply role validate or plan app Terraform', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      const tfvars = writeAppTfvars(dir);

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform app guard requires the app plan CodeBuild role for plan.');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([
    {
      label: 'signature-preflight apply role planning',
      roleArn: APP_SIGNATURE_PREFLIGHT_APPLY_ROLE,
      args: ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars'],
      expected: 'Terraform app guard requires the app plan CodeBuild role for plan.',
    },
    {
      label: 'signature-preflight plan role applying',
      roleArn: APP_SIGNATURE_PREFLIGHT_PLAN_ROLE,
      args: ['apply', '-auto-approve', 'tfplan'],
      expected: 'Terraform app guard requires the app apply CodeBuild role for apply.',
    },
    {
      label: 'signature state-refresh apply role planning',
      roleArn: APP_SIGNATURE_STATE_REFRESH_APPLY_ROLE,
      args: [
        'plan',
        '-refresh-only',
        '-out=tfplan',
        '-var-file=pipeline.auto.tfvars',
        ...APP_SIGNATURE_PREFLIGHT_TARGET_ARGS,
      ],
      expected: 'Terraform app guard requires the app plan CodeBuild role for plan.',
    },
  ])('rejects $label before invoking Terraform', ({ args, expected, roleArn }) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      writeAppTfvars(dir);

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', ...args], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: roleArn,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it('allows app plan role to run only the exact reviewed pipeline plan shape', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      const tfvars = writeAppTfvars(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars'],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(`-chdir=infra/terraform/app plan -out=tfplan -var-file=${tfvars}`);
    });
  });

  it('allows the current signature-preflight plan role to run only the exact verifier-only plan', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      const tfvars = writeAppTfvars(dir);

      const result = spawnSync(
        'bash',
        [
          SCRIPT_PATH,
          'stark-dev/develop/app',
          'plan',
          '-out=tfplan',
          '-var-file=pipeline.auto.tfvars',
          ...APP_SIGNATURE_PREFLIGHT_TARGET_ARGS,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: APP_SIGNATURE_PREFLIGHT_PLAN_ROLE,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(
        `-chdir=infra/terraform/app plan -out=tfplan -var-file=${tfvars} ${APP_SIGNATURE_PREFLIGHT_TARGET_ARGS.join(' ')}`,
      );
    });
  });

  it('allows the current signature-preflight plan role to run the exact verifier refresh-only plan', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      const tfvars = writeAppTfvars(dir);

      const result = spawnSync(
        'bash',
        [
          SCRIPT_PATH,
          'stark-dev/develop/app',
          'plan',
          '-refresh-only',
          '-out=tfplan',
          '-var-file=pipeline.auto.tfvars',
          ...APP_SIGNATURE_PREFLIGHT_TARGET_ARGS,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: APP_SIGNATURE_PREFLIGHT_PLAN_ROLE,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(
        `-chdir=infra/terraform/app plan -refresh-only -out=tfplan -var-file=${tfvars} ${APP_SIGNATURE_PREFLIGHT_TARGET_ARGS.join(' ')}`,
      );
    });
  });

  it.each([
    ['missing target', APP_SIGNATURE_PREFLIGHT_TARGET_ARGS.slice(0, -1)],
    ['extra target', [...APP_SIGNATURE_PREFLIGHT_TARGET_ARGS, '-target=aws_s3_bucket.example']],
    [
      'different target order',
      [
        APP_SIGNATURE_PREFLIGHT_TARGET_ARGS[1],
        APP_SIGNATURE_PREFLIGHT_TARGET_ARGS[0],
        ...APP_SIGNATURE_PREFLIGHT_TARGET_ARGS.slice(2),
      ],
    ],
  ])('rejects a signature-preflight plan with an inexact verifier target set: %s', (_label, targetArgs) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      writeAppTfvars(dir);

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, 'stark-dev/develop/app', 'plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', ...targetArgs],
        {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: APP_SIGNATURE_PREFLIGHT_PLAN_ROLE,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'signature preflight plan accepts only the exact verifier-only saved-plan target set.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([
    ['destroy mode', ['plan', '-destroy', '-out=tfplan', '-var-file=pipeline.auto.tfvars']],
    ['refresh-only mode', ['plan', '-refresh-only', '-out=tfplan', '-var-file=pipeline.auto.tfvars']],
    ['targeted plan', ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', '-target=aws_s3_bucket.example']],
    [
      'resource replacement',
      ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', '-replace=aws_s3_bucket.example'],
    ],
    ['missing output path', ['plan', '-var-file=pipeline.auto.tfvars']],
    ['alternate output path', ['plan', '-out=reviewed.tfplan', '-var-file=pipeline.auto.tfvars']],
    ['extra positional argument', ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', 'extra.tfplan']],
    ['extra input flag', ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', '-input=false']],
    ['extra lock flag', ['plan', '-out=tfplan', '-var-file=pipeline.auto.tfvars', '-lock=false']],
  ])('rejects app plan role ad hoc plan arguments: %s', (_label, args) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      writeAppTfvars(dir);

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-plan-stark-dev-develop-app/codebuild-test`,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'app plan accepts only the reviewed pipeline plan command shape: plan -out=tfplan -var-file=pipeline.auto.tfvars.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([
    {
      command: 'init',
      args: ['init', '-backend-config=backend.local.hcl'],
      expectedRoleLabel: 'plan or apply',
      prepare: writeAppBackendConfig,
    },
    {
      command: 'validate',
      args: ['validate'],
      expectedRoleLabel: 'plan',
      prepare: (dir: string) => mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true }),
    },
    {
      command: 'plan',
      args: (dir: string) => ['plan', `-var-file=${writeAppTfvars(dir)}`],
      expectedRoleLabel: 'plan',
      prepare: (dir: string) => mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true }),
    },
    {
      command: 'apply',
      args: ['apply', '-auto-approve', 'tfplan'],
      expectedRoleLabel: 'apply',
      prepare: (dir: string) => mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true }),
    },
    {
      command: 'smoke',
      args: ['smoke'],
      expectedRoleLabel: 'smoke',
      prepare: (dir: string) => mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true }),
    },
  ])(
    'rejects local app $command execution even when CODEBUILD metadata and caller-pattern overrides are spoofed',
    ({ args, command, expectedRoleLabel, prepare }) => {
      withTempDir((dir) => {
        installMocks(dir);
        prepare(dir);
        const commandArgs = typeof args === 'function' ? args(dir) : args;

        const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', ...commandArgs], {
          cwd: dir,
          encoding: 'utf8',
          env: testEnv(dir, {
            CODEBUILD_BUILD_ID: 'spoofed',
            CODEBUILD_BUILD_ARN: `arn:aws:codebuild:ap-northeast-1:${REVIEWED_DEVELOP_ACCOUNT_ID}:build/spoofed`,
            TERRAFORM_ALLOWED_PRINCIPAL_ARN_PATTERN: `^arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/.+$`,
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/user00`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          `Terraform app guard requires the app ${expectedRoleLabel} CodeBuild role for ${command}.`,
        );
        expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
      });
    },
  );

  it('rejects app apply unless the app apply role applies one reviewed saved plan', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });
      writeFileSync(path.join(dir, 'reviewed.tfplan'), 'mock saved plan');

      const result = spawnSync(
        'bash',
        [
          SCRIPT_PATH,
          'stark-dev/develop/app',
          'apply',
          '-auto-approve',
          path.join(dir, 'reviewed.tfplan'),
          '-var-file=pipeline.auto.tfvars',
        ],
        {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'app apply accepts only the reviewed pipeline saved plan command shape: apply -auto-approve tfplan.',
      );
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });

  it.each([['/tmp/reviewed.tfplan'], ['reviewed.tfplan'], ['plans/tfplan']])(
    'rejects app apply saved-plan path outside the exact pipeline tfplan name: %s',
    (tfplan) => {
      withTempDir((dir) => {
        installMocks(dir);
        mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });

        const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'apply', '-auto-approve', tfplan], {
          encoding: 'utf8',
          env: testEnv(dir, {
            TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
            TERRAFORM_WORKING_DIR: 'infra/terraform/app',
            MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
            MOCK_TERRAFORM_WORKSPACE: 'default',
          }),
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          'app apply accepts only the reviewed pipeline saved plan command shape: apply -auto-approve tfplan.',
        );
        expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
      });
    },
  );

  it('allows app apply role to apply the pipeline tfplan without replanning', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'apply', '-auto-approve', 'tfplan'], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-apply-stark-dev-develop-app/codebuild-test`,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app apply -auto-approve tfplan');
    });
  });

  it.each([
    ['signature-preflight', APP_SIGNATURE_PREFLIGHT_APPLY_ROLE],
    ['signature state-refresh', APP_SIGNATURE_STATE_REFRESH_APPLY_ROLE],
  ])('allows the current %s apply role to apply only the reviewed pipeline tfplan', (_label, roleArn) => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'apply', '-auto-approve', 'tfplan'], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: roleArn,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain('-chdir=infra/terraform/app apply -auto-approve tfplan');
    });
  });

  it('allows app smoke role to run the non-mutating skeletal smoke guard without Terraform', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'infra/terraform/app'), { recursive: true });

      const result = spawnSync('bash', [SCRIPT_PATH, 'stark-dev/develop/app', 'smoke'], {
        encoding: 'utf8',
        env: testEnv(dir, {
          TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV: `${REVIEWED_DEVELOP_ACCOUNT_ID}`,
          TERRAFORM_WORKING_DIR: 'infra/terraform/app',
          MOCK_AWS_ARN: `arn:aws:sts::${REVIEWED_DEVELOP_ACCOUNT_ID}:assumed-role/stark-ballot-sim-tf-smoke-stark-dev-develop-app/codebuild-test`,
          MOCK_TERRAFORM_WORKSPACE: 'default',
        }),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('App smoke guard passed for stark-dev/develop/app.');
      expect(() => readFileSync(path.join(dir, 'terraform.log'), 'utf8')).toThrow();
    });
  });
});
