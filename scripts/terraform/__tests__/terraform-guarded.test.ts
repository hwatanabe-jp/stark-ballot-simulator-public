/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/terraform-guarded.sh');

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
    'TERRAFORM_AWS_ACCOUNT_ID',
    'AWS_ACCOUNT_ID',
    'MOCK_AWS_ACCOUNT',
    'MOCK_AWS_ARN',
    'MOCK_TERRAFORM_WORKSPACE',
    'MOCK_TERRAFORM_LOG',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    PATH: `${path.join(dir, 'bin')}:${env.PATH ?? ''}`,
    TERRAFORM_AWS_ACCOUNT_ID: '111122223333',
    MOCK_AWS_ACCOUNT: '111122223333',
    MOCK_AWS_ARN: 'arn:aws:sts::111122223333:assumed-role/terraform-admin/aws-vault-test',
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
if [ "$1" = "-chdir=terraform" ] && [ "$2" = "workspace" ] && [ "$3" = "show" ]; then
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

describe('terraform-guarded.sh', () => {
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
      expect(log).toContain('-chdir=terraform workspace show');
      expect(log).toContain(`-chdir=terraform plan -var-file=${tfvars}`);
    });
  });

  it('passes Terraform the same canonical tfvars path that the guard validated', () => {
    withTempDir((dir) => {
      installMocks(dir);
      mkdirSync(path.join(dir, 'terraform'), { recursive: true });
      writeFileSync(path.join(dir, 'develop.local.tfvars'), 'aws_region = "ap-northeast-1"\nenvironment = "main"\n');
      const checkedTfvars = path.join(dir, 'terraform/develop.local.tfvars');
      writeFileSync(checkedTfvars, 'aws_region = "ap-northeast-1"\nenvironment = "develop"\n');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', '-var-file=develop.local.tfvars'], {
        cwd: dir,
        encoding: 'utf8',
        env: testEnv(dir),
      });

      expect(result.status).toBe(0);
      const log = readFileSync(path.join(dir, 'terraform.log'), 'utf8');
      expect(log).toContain(`-chdir=terraform plan -var-file=${checkedTfvars}`);
      expect(log).not.toContain('-chdir=terraform plan -var-file=develop.local.tfvars');
    });
  });

  it('rejects a default IAM user before running Terraform', () => {
    withTempDir((dir) => {
      installMocks(dir);
      const tfvars = writeTfvars(dir, 'develop');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', 'plan', `-var-file=${tfvars}`], {
        encoding: 'utf8',
        env: testEnv(dir, {
          MOCK_AWS_ARN: 'arn:aws:iam::111122223333:user/user01',
        }),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Terraform must run as arn:aws:sts::111122223333:assumed-role/terraform-admin/*');
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
      expect(log).toContain('-chdir=terraform workspace show');
      expect(log).not.toContain(`-chdir=terraform plan -var-file=${developTfvars}`);
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
      expect(log).toContain('-chdir=terraform workspace show');
      expect(log).not.toContain(`-chdir=terraform plan -var-file=${tfvars}`);
    });
  });
});
