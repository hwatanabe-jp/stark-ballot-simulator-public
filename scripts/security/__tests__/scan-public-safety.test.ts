/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/security/scan-public-safety.sh');

function withTempFile(content: string, run: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-'));
  try {
    const filePath = path.join(dir, 'sample.txt');
    writeFileSync(filePath, content);
    run(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runScan(filePath: string) {
  return spawnSync('bash', [SCRIPT_PATH, '--files', filePath], {
    encoding: 'utf8',
  });
}

function runScanAll(cwd: string) {
  return spawnSync('bash', [SCRIPT_PATH, '--all'], {
    cwd,
    encoding: 'utf8',
  });
}

describe('scan-public-safety.sh', () => {
  it('allows placeholders and known fake AWS account IDs', () => {
    withTempFile(
      [
        'ecs_image_uri = "<AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/repo@sha256:<64_HEX_DIGEST>"',
        'fake_state_machine = "arn:aws:states:ap-northeast-1:111122223333:stateMachine:Example"',
        'origin = "https://develop.<AMPLIFY_APP_ID>.amplifyapp.com"',
        'identity_pool = "<COGNITO_IDENTITY_POOL_ID>"',
        'user_pool = "<COGNITO_USER_POOL_ID>"',
        'stack = "amplify-<AMPLIFY_APP_ID>-develop-branch-<BRANCH_STACK_SUFFIX>"',
        'role = "amplify-<APP_NAME>-<BRANCH>-<FUNCTION_NAME>-<GENERATED_SUFFIX>"',
        'logical_id = "amplifyAuthUserPool<GENERATED_SUFFIX>"',
        'mfa = "arn:aws:iam::<AWS_ACCOUNT_ID>:mfa/<MFA_DEVICE_NAME>"',
        'iam_user_id = "<IAM_USER_ID>"',
        'pass init <GPG_KEY_FINGERPRINT>',
        'develop_bucket = "stark-ballot-simulator-proof-bundles-develop"',
        'main_bucket = "stark-ballot-simulator-proof-bundles-main"',
      ].join('\n'),
      (filePath) => {
        const result = runScan(filePath);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Public safety scan passed');
      },
    );
  });

  it('fails on concrete AWS account IDs in publishable resource contexts without printing the value', () => {
    const accountId = ['5555', '4444', '3333'].join('');
    withTempFile(`role = "arn:aws:iam::${accountId}:role/example"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_arn');
      expect(result.stderr).not.toContain(accountId);
    });
  });

  it('fails on concrete Cognito resource IDs and IAM principal identifiers', () => {
    const identityPoolId = ['ap-northeast-1:', '12345678', '-1234-1234-1234-123456789abc'].join('');
    const userPoolId = ['ap-northeast-1_', 'AbCd', 'EfGhI'].join('');
    const iamUserId = ['AIDAEXAM', 'PLEID123456789'].join('');

    withTempFile(
      [`identity_pool = "${identityPoolId}"`, `user_pool = "${userPoolId}"`, `user_id = "${iamUserId}"`].join('\n'),
      (filePath) => {
        const result = runScan(filePath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('cognito_identity_pool_id');
        expect(result.stderr).toContain('cognito_user_pool_id');
        expect(result.stderr).toContain('aws_iam_unique_id');
        expect(result.stderr).not.toContain('12345678');
        expect(result.stderr).not.toContain('AbCdEfGhI');
        expect(result.stderr).not.toContain(iamUserId);
      },
    );
  });

  it('fails on concrete Amplify generated names and local MFA/GPG identifiers', () => {
    const branchStackSuffix = ['abc', '123def4'].join('');
    const roleSuffix = ['Sample', 'ABC123'].join('');
    const logicalIdSuffix = ['ABCD', 'EF12'].join('');
    const mfaDeviceName = ['smartphone', '_99'].join('');
    const gpgFingerprint = ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'].join('');

    withTempFile(
      [
        `stack = "amplify-<AMPLIFY_APP_ID>-develop-branch-${branchStackSuffix}"`,
        `role = "amplify-starkballotsimulator-user-sa-proverdispatchproxylambda-${roleSuffix}"`,
        `logical_id = "amplifyAuthUserPool${logicalIdSuffix}"`,
        `mfa = "arn:aws:iam::<AWS_ACCOUNT_ID>:mfa/${mfaDeviceName}"`,
        `pass init ${gpgFingerprint}`,
      ].join('\n'),
      (filePath) => {
        const result = runScan(filePath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('amplify_placeholder_stack_suffix');
        expect(result.stderr).toContain('amplify_generated_resource_name');
        expect(result.stderr).toContain('amplify_generated_logical_id');
        expect(result.stderr).toContain('personal_mfa_device_name');
        expect(result.stderr).toContain('gpg_fingerprint');
        expect(result.stderr).not.toContain(branchStackSuffix);
        expect(result.stderr).not.toContain(roleSuffix);
        expect(result.stderr).not.toContain(logicalIdSuffix);
        expect(result.stderr).not.toContain(mfaDeviceName);
        expect(result.stderr).not.toContain('AAAAAAAAAAAAAAAA');
      },
    );
  });

  it('fails on concrete Amplify app origins', () => {
    const appId = ['d2abc', 'de123', '456'].join('');
    withTempFile(`origin = "https://main.${appId}.amplifyapp.com"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('amplify_app_origin');
    });
  });

  it('fails on concrete Amplify stack names with 10-character branch suffixes', () => {
    const appId = ['d2abc', 'de123', '456'].join('');
    withTempFile(`stack = "amplify-${appId}-develop-branch-abc123def4"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('amplify_stack_name');
    });
  });

  it('fails on concrete AppSync GraphQL endpoints and API IDs', () => {
    const apiId = ['abcde', '12345', 'fghij', '67890', 'klmno', 'p'].join('');
    withTempFile(
      [
        `AMPLIFY_DATA_ENDPOINT=https://${apiId}.appsync-api.ap-northeast-1.amazonaws.com/graphql`,
        `AMPLIFY_DATA_API_ID=${apiId}`,
      ].join('\n'),
      (filePath) => {
        const result = runScan(filePath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('appsync_graphql_endpoint');
        expect(result.stderr).toContain('appsync_api_id');
        expect(result.stderr).not.toContain(apiId);
      },
    );
  });

  it('fails on concrete AWS resource IDs and project S3 bucket names', () => {
    const subnetId = ['subnet', '0abc1234def567890'].join('-');
    const bucketName = ['stark-ballot-simulator-proof', 'bundles-sandbox'].join('-');
    withTempFile(`subnet = "${subnetId}"\nbucket = "${bucketName}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_resource_id');
      expect(result.stderr).toContain('project_s3_bucket_name');
      expect(result.stderr).not.toContain(subnetId);
      expect(result.stderr).not.toContain(bucketName);
    });
  });

  it('fails on local Unix user paths without printing the concrete path', () => {
    const localPath = ['', 'home', 'user', '.password-store', 'example'].join('/');
    withTempFile(`example = "${localPath}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('local_user_path');
      expect(result.stderr).not.toContain(localPath);
    });
  });

  it('scans all files from a non-git directory instead of passing without coverage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-non-git-'));
    const accountId = ['5555', '4444', '3333'].join('');
    try {
      writeFileSync(path.join(dir, 'sample.txt'), `role = "arn:aws:iam::${accountId}:role/example"\n`);

      const result = runScanAll(dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_arn');
      expect(result.stderr).not.toContain(accountId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
