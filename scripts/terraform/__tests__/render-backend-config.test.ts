/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/render-backend-config.sh');

function terraformBackendTestEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'TERRAFORM_STATE_BUCKET',
    'TERRAFORM_STATE_BUCKET_NAME',
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
});
