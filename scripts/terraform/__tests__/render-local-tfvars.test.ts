/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/terraform/render-local-tfvars.sh');

function terraformTfvarsTestEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'TERRAFORM_AWS_REGION_DEVELOP',
    'TERRAFORM_AWS_REGION_MAIN',
    'TERRAFORM_AWS_REGION',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'TERRAFORM_AWS_PROFILE_DEVELOP',
    'TERRAFORM_AWS_PROFILE_MAIN',
    'TERRAFORM_AWS_PROFILE',
    'AWS_PROFILE',
    'TERRAFORM_PROJECT_NAME_DEVELOP',
    'TERRAFORM_PROJECT_NAME_MAIN',
    'TERRAFORM_PROJECT_NAME',
    'PROJECT_NAME',
    'TERRAFORM_AWS_ACCOUNT_ID_DEVELOP',
    'TERRAFORM_AWS_ACCOUNT_ID_MAIN',
    'TERRAFORM_AWS_ACCOUNT_ID',
    'AWS_ACCOUNT_ID',
    'TERRAFORM_ECS_IMAGE_URI_DEVELOP',
    'TERRAFORM_ECS_IMAGE_URI_MAIN',
    'TERRAFORM_ECS_IMAGE_URI',
    'TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP',
    'TERRAFORM_ZKVM_PROVER_DIGEST_MAIN',
    'TERRAFORM_ZKVM_PROVER_DIGEST',
    'TERRAFORM_ECR_SIGNING_PROFILE_ARN_DEVELOP',
    'TERRAFORM_ECR_SIGNING_PROFILE_ARN_MAIN',
    'TERRAFORM_ECR_SIGNING_PROFILE_ARN',
    'TERRAFORM_ECR_SIGNING_PROFILE_NAME_DEVELOP',
    'TERRAFORM_ECR_SIGNING_PROFILE_NAME_MAIN',
    'TERRAFORM_ECR_SIGNING_PROFILE_NAME',
    'TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_DEVELOP',
    'TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_MAIN',
    'TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN',
    'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP',
    'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_MAIN',
    'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME',
    'TERRAFORM_CODESTAR_CONNECTION_ARN_DEVELOP',
    'TERRAFORM_CODESTAR_CONNECTION_ARN_MAIN',
    'TERRAFORM_CODESTAR_CONNECTION_ARN',
    'TERRAFORM_CODESTAR_CONNECTION_ID_DEVELOP',
    'TERRAFORM_CODESTAR_CONNECTION_ID_MAIN',
    'TERRAFORM_CODESTAR_CONNECTION_ID',
    'TERRAFORM_CODEBUILD_SOURCE_LOCATION_DEVELOP',
    'TERRAFORM_CODEBUILD_SOURCE_LOCATION_MAIN',
    'TERRAFORM_CODEBUILD_SOURCE_LOCATION',
    'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP',
    'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_MAIN',
    'TERRAFORM_S3_CORS_ALLOWED_ORIGINS',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'render-local-tfvars-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('render-local-tfvars.sh', () => {
  it('can render from shell environment values when the default .env.local file is absent', () => {
    withTempDir((dir) => {
      const outputFile = path.join(dir, 'develop.local.tfvars');
      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--output', outputFile], {
        cwd: dir,
        encoding: 'utf8',
        env: terraformTfvarsTestEnv({
          TERRAFORM_AWS_ACCOUNT_ID: '111122223333',
          TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          TERRAFORM_ECR_SIGNING_PROFILE_NAME: 'stark_ballot_simulator_ecr_signing',
          TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP: 'amplify-example-de-finalizecallbackrunnerla-ABC123',
          TERRAFORM_CODESTAR_CONNECTION_ID: '00000000-1111-2222-3333-444444444444',
          TERRAFORM_CODEBUILD_SOURCE_LOCATION: 'https://github.com/example/stark-ballot-simulator.git',
          TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP: 'https://develop.example.test',
        }),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Wrote local Terraform variables');
      expect(result.stderr).toBe('');
      expect(readFileSync(outputFile, 'utf8')).toMatch(/environment\s+= "develop"/);
    });
  });

  it('renders environment-specific tfvars from .env-style values without logging resource IDs', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'develop.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_AWS_ACCOUNT_ID=111122223333',
          'TERRAFORM_AWS_REGION=ap-northeast-1',
          'TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'TERRAFORM_ECR_SIGNING_PROFILE_NAME=stark_ballot_simulator_ecr_signing',
          'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP=amplify-example-de-finalizecallbackrunnerla-ABC123',
          'TERRAFORM_CODESTAR_CONNECTION_ID=00000000-1111-2222-3333-444444444444',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/example/stark-ballot-simulator.git',
          'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP=https://develop.example.test, https://preview.example.test',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv(),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Wrote local Terraform variables');
      expect(result.stdout).not.toContain('111122223333');
      expect(result.stderr).toBe('');

      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain('aws_account_id = "111122223333"');
      expect(rendered).toMatch(/environment\s+= "develop"/);
      expect(rendered).toContain(
        'ecs_image_uri           = "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-develop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      );
      expect(rendered).toContain(
        'ecr_signing_profile_arn = "arn:aws:signer:ap-northeast-1:111122223333:/signing-profiles/stark_ballot_simulator_ecr_signing"',
      );
      expect(rendered).toContain(
        'finalize_callback_lambda_arn = "arn:aws:lambda:ap-northeast-1:111122223333:function:amplify-example-de-finalizecallbackrunnerla-ABC123"',
      );
      expect(rendered).toContain(
        'codestar_connection_arn      = "arn:aws:codestar-connections:ap-northeast-1:111122223333:connection/00000000-1111-2222-3333-444444444444"',
      );
      expect(rendered).toContain('codebuild_source_location = "https://github.com/example/stark-ballot-simulator.git"');
      expect(rendered).toContain('"https://develop.example.test"');
      expect(rendered).toContain('"https://preview.example.test"');
    });
  });

  it('lets explicit shell environment values override .env defaults', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'develop.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_AWS_ACCOUNT_ID=111122223333',
          'TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'TERRAFORM_ECR_SIGNING_PROFILE_NAME=envfile_profile',
          'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP=envfile-callback',
          'TERRAFORM_CODESTAR_CONNECTION_ID=00000000-1111-2222-3333-444444444444',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/envfile/stark-ballot-simulator.git',
          'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP=https://envfile.example.test',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv({
          TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP:
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          TERRAFORM_CODEBUILD_SOURCE_LOCATION_DEVELOP: 'https://github.com/shell/stark-ballot-simulator.git',
          TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP: 'https://shell.example.test',
        }),
      });

      expect(result.status).toBe(0);
      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain(
        'ecs_image_uri           = "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-develop@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
      );
      expect(rendered).toContain('codebuild_source_location = "https://github.com/shell/stark-ballot-simulator.git"');
      expect(rendered).toContain('"https://shell.example.test"');
      expect(rendered).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(rendered).not.toContain('https://envfile.example.test');
    });
  });

  it('accepts fully specified ARNs and image URIs for main', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'main.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_AWS_ACCOUNT_ID=111122223333',
          'TERRAFORM_ECS_IMAGE_URI_MAIN=111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-main@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'TERRAFORM_ECR_SIGNING_PROFILE_ARN=arn:aws:signer:ap-northeast-1:111122223333:/signing-profiles/example',
          'TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_MAIN=arn:aws:lambda:ap-northeast-1:111122223333:function:callback-main',
          'TERRAFORM_CODESTAR_CONNECTION_ARN=arn:aws:codestar-connections:ap-northeast-1:111122223333:connection/example',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/example/stark-ballot-simulator.git',
          'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_MAIN=https://main.example.test,https://example.test',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'main', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv(),
      });

      expect(result.status).toBe(0);
      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).toContain('aws_account_id = "111122223333"');
      expect(rendered).toMatch(/environment\s+= "main"/);
      expect(rendered).toContain('"https://main.example.test"');
      expect(rendered).toContain('"https://example.test"');
    });
  });

  it('fails rather than silently disabling S3 CORS when origins are missing', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'main.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_ECS_IMAGE_URI_MAIN=111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-main@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'TERRAFORM_ECR_SIGNING_PROFILE_ARN=arn:aws:signer:ap-northeast-1:111122223333:/signing-profiles/example',
          'TERRAFORM_FINALIZE_CALLBACK_LAMBDA_ARN_MAIN=arn:aws:lambda:ap-northeast-1:111122223333:function:callback-main',
          'TERRAFORM_CODESTAR_CONNECTION_ARN=arn:aws:codestar-connections:ap-northeast-1:111122223333:connection/example',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/example/stark-ballot-simulator.git',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'main', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('TERRAFORM_S3_CORS_ALLOWED_ORIGINS_MAIN');
      expect(result.stderr).not.toContain('111122223333');
    });
  });

  it('fails clearly when required deployment values are missing', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'develop.local.tfvars');
      writeFileSync(envFile, 'TERRAFORM_AWS_ACCOUNT_ID=111122223333\n');

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Missing required Terraform deployment values');
      expect(result.stderr).toContain('TERRAFORM_ECS_IMAGE_URI_DEVELOP');
      expect(result.stderr).toContain('TERRAFORM_CODEBUILD_SOURCE_LOCATION_DEVELOP');
      expect(result.stderr).toContain('TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP');
      expect(result.stderr).not.toContain('111122223333');
    });
  });

  it('does not write ambient AWS profiles into local tfvars', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'develop.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_AWS_ACCOUNT_ID=111122223333',
          'TERRAFORM_AWS_PROFILE=default',
          'TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'TERRAFORM_ECR_SIGNING_PROFILE_NAME=stark_ballot_simulator_ecr_signing',
          'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP=amplify-example-de-finalizecallbackrunnerla-ABC123',
          'TERRAFORM_CODESTAR_CONNECTION_ID=00000000-1111-2222-3333-444444444444',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/example/stark-ballot-simulator.git',
          'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP=https://develop.example.test',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv({
          AWS_PROFILE: 'default',
        }),
      });

      expect(result.status).toBe(0);
      const rendered = readFileSync(outputFile, 'utf8');
      expect(rendered).not.toContain('aws_profile');
      expect(rendered).not.toContain('default');
      expect(result.stderr).not.toContain('111122223333');
    });
  });

  it('rejects placeholder CodeBuild source locations', () => {
    withTempDir((dir) => {
      const envFile = path.join(dir, '.env.local');
      const outputFile = path.join(dir, 'develop.local.tfvars');
      writeFileSync(
        envFile,
        [
          'TERRAFORM_AWS_ACCOUNT_ID=111122223333',
          'TERRAFORM_ZKVM_PROVER_DIGEST_DEVELOP=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'TERRAFORM_ECR_SIGNING_PROFILE_NAME=stark_ballot_simulator_ecr_signing',
          'TERRAFORM_FINALIZE_CALLBACK_FUNCTION_NAME_DEVELOP=amplify-example-de-finalizecallbackrunnerla-ABC123',
          'TERRAFORM_CODESTAR_CONNECTION_ID=00000000-1111-2222-3333-444444444444',
          'TERRAFORM_CODEBUILD_SOURCE_LOCATION=https://github.com/hwatanabe-jp/<REPO_NAME>.git',
          'TERRAFORM_S3_CORS_ALLOWED_ORIGINS_DEVELOP=https://develop.example.test',
        ].join('\n'),
      );

      const result = spawnSync('bash', [SCRIPT_PATH, 'develop', '--env-file', envFile, '--output', outputFile], {
        encoding: 'utf8',
        env: terraformTfvarsTestEnv(),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('codebuild_source_location');
      expect(result.stderr).not.toContain('REPO_NAME');
    });
  });
});
