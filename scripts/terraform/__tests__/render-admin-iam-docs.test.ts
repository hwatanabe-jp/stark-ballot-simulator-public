/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/render-admin-iam-docs.sh');

function terraformIamTestEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'TERRAFORM_AWS_ACCOUNT_ID',
    'AWS_ACCOUNT_ID',
    'TERRAFORM_STATE_BUCKET',
    'TERRAFORM_STATE_BUCKET_NAME',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'render-admin-iam-docs-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('render-admin-iam-docs.sh', () => {
  it('renders local IAM policy documents without logging account or bucket values', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const policyOutput = path.join(dir, 'terraform-admin-policy.local.json');
      const trustOutput = path.join(dir, 'terraform-admin-trust-policy.local.json');
      writeFileSync(
        envFile,
        ['TERRAFORM_AWS_ACCOUNT_ID=111122223333', 'TERRAFORM_STATE_BUCKET=example-terraform-state'].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, '--env-file', envFile, '--policy-output', policyOutput, '--trust-output', trustOutput],
        {
          encoding: 'utf8',
          env: terraformIamTestEnv(),
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Wrote local Terraform admin IAM documents');
      expect(result.stdout).not.toContain('111122223333');
      expect(result.stdout).not.toContain('example-terraform-state');
      expect(result.stderr).toBe('');

      const policy = readFileSync(policyOutput, 'utf8');
      const trust = readFileSync(trustOutput, 'utf8');
      expect(policy).toContain('arn:aws:s3:::example-terraform-state');
      expect(policy).toContain('arn:aws:codebuild:ap-northeast-1:111122223333:project/stark-ballot-simulator-*');
      expect(policy).not.toContain('<AWS_ACCOUNT_ID>');
      expect(policy).not.toContain('<TERRAFORM_STATE_BUCKET>');
      expect(trust).toContain('arn:aws:iam::111122223333:root');
      expect(trust).not.toContain('<AWS_ACCOUNT_ID>');
    });
  });

  it('lets explicit shell environment values override .env defaults', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const policyOutput = path.join(dir, 'terraform-admin-policy.local.json');
      const trustOutput = path.join(dir, 'terraform-admin-trust-policy.local.json');
      writeFileSync(
        envFile,
        ['TERRAFORM_AWS_ACCOUNT_ID=111122223333', 'TERRAFORM_STATE_BUCKET=envfile-terraform-state'].join('\n'),
      );

      const result = spawnSync(
        'bash',
        [SCRIPT_PATH, '--env-file', envFile, '--policy-output', policyOutput, '--trust-output', trustOutput],
        {
          encoding: 'utf8',
          env: terraformIamTestEnv({
            TERRAFORM_AWS_ACCOUNT_ID: '999999999999',
            TERRAFORM_STATE_BUCKET: 'shell-terraform-state',
          }),
        },
      );

      expect(result.status).toBe(0);
      const policy = readFileSync(policyOutput, 'utf8');
      const trust = readFileSync(trustOutput, 'utf8');
      expect(policy).toContain('arn:aws:s3:::shell-terraform-state');
      expect(policy).toContain('arn:aws:codebuild:ap-northeast-1:999999999999:project/stark-ballot-simulator-*');
      expect(trust).toContain('arn:aws:iam::999999999999:root');
      expect(policy).not.toContain('envfile-terraform-state');
      expect(policy).not.toContain('111122223333');
    });
  });

  it('fails clearly when required values are missing', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      writeFileSync(envFile, 'TERRAFORM_AWS_ACCOUNT_ID=111122223333\n');

      const result = spawnSync('bash', [SCRIPT_PATH, '--env-file', envFile], {
        encoding: 'utf8',
        env: terraformIamTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Missing required Terraform admin IAM values');
      expect(result.stderr).toContain('TERRAFORM_STATE_BUCKET');
      expect(result.stderr).not.toContain('111122223333');
    });
  });
});
