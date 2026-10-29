import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/security/scan-public-safety.sh');

function s3ObjectUrl(hostParts: string[], objectPath: string): string {
  return `https://${hostParts.join('.')}/${objectPath}`;
}

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

function runScanRoot(root: string) {
  return spawnSync('bash', [SCRIPT_PATH, '--root', root, '--all'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('scan-public-safety.sh', () => {
  it('allows placeholder AWS account IDs', () => {
    withTempFile(
      [
        'ecs_image_uri = "<AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/repo@sha256:<64_HEX_DIGEST>"',
        'fake_state_machine = "arn:aws:states:ap-northeast-1:<AWS_ACCOUNT_ID>:stateMachine:Example"',
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
        'AWS_ACCOUNT_ID=000000000000',
        'aws_account_id = "000000000000"',
        'accountId: "000000000000"',
      ].join('\n'),
      (filePath) => {
        const result = runScan(filePath);
        expect(result.status).toBe(0);
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

  it('fails on concrete AWS account IDs in explicit labels without printing the value', () => {
    const accountId = ['5555', '4444', '3333'].join('');
    withTempFile(`AWS_ACCOUNT_ID=${accountId}\naccountId: "${accountId}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).not.toContain(accountId);
    });
  });

  it('fails on concrete AWS account IDs in prose and bucket-owner labels without printing the value', () => {
    const accountId = ['5555', '4444', '3333'].join('');
    withTempFile(`AWS account ID: ${accountId}\nexpectedBucketOwner: "${accountId}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).not.toContain(accountId);
    });
  });

  it('allows canonical demo-shaped AWS account IDs outside tfvars and public-exported docs', () => {
    withTempFile(['AWS account ID: 123456789012', 'ExpectedBucketOwner: "111122223333"'].join('\n'), (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(0);
    });
  });

  it('fails on real-shaped account IDs planted in tracked tfvars and public-exported docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-account-id-hygiene-'));
    const accountId = '123456789012';
    try {
      const tfvarsPath = path.join(dir, 'infra/terraform/app/develop.auto.tfvars');
      const tfvarsExamplePath = path.join(dir, 'infra/terraform/legacy/terraform.tfvars.example');
      const publicDocPath = path.join(dir, 'public-book/src/account-hygiene.md');
      mkdirSync(path.dirname(tfvarsPath), { recursive: true });
      mkdirSync(path.dirname(tfvarsExamplePath), { recursive: true });
      mkdirSync(path.dirname(publicDocPath), { recursive: true });
      writeFileSync(tfvarsPath, `aws_account_id = "${accountId}"\n`);
      writeFileSync(tfvarsExamplePath, `aws_account_id = "${accountId}"\n`);
      writeFileSync(publicDocPath, `AWS account ID: ${accountId}\n`);

      const result = runScanRoot(dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('infra/terraform/app/develop.auto.tfvars');
      expect(result.stderr).toContain('infra/terraform/legacy/terraform.tfvars.example');
      expect(result.stderr).toContain('public-book/src/account-hygiene.md');
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).not.toContain(accountId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strict-scans every docs area except the private internal and archive prefixes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-doc-scope-'));
    const accountId = '123456789012';
    const unpublishedDocPath = path.join(dir, 'docs/new-area/account-hygiene.md');
    const internalDocPath = path.join(dir, 'docs/internal/account-hygiene.md');
    const archivedDocPath = path.join(dir, 'docs/archive/account-hygiene.md');

    try {
      for (const filePath of [unpublishedDocPath, internalDocPath, archivedDocPath]) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `historical account number: ${accountId}\n`);
      }

      const publicResult = runScanRoot(dir);
      expect(publicResult.status).toBe(1);
      expect(publicResult.stderr).toContain('docs/new-area/account-hygiene.md');
      expect(publicResult.stderr).not.toContain('docs/internal/account-hygiene.md');
      expect(publicResult.stderr).not.toContain('docs/archive/account-hygiene.md');
      expect(publicResult.stderr).not.toContain(accountId);

      rmSync(unpublishedDocPath);
      const privateOnlyResult = runScanRoot(dir);
      expect(privateOnlyResult.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strict-scans the public catalog, OpenAPI reference, and TechDocs source', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-developer-portal-'));
    const accountId = '123456789012';
    const paths = [
      'catalog-info.yaml',
      'openapi/stark-ballot-api.openapi.json',
      'techdocs/mkdocs.yml',
      'techdocs/docs/index.md',
    ];

    try {
      for (const relativePath of paths) {
        const filePath = path.join(dir, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `example: ${accountId}\n`);
      }

      const result = runScanRoot(dir);

      expect(result.status).toBe(1);
      for (const relativePath of paths) {
        expect(result.stderr).toContain(relativePath);
      }
      expect(result.stderr).not.toContain(accountId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the zero account placeholder in tracked tfvars and public-exported docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-account-id-placeholder-'));
    try {
      const tfvarsPath = path.join(dir, 'infra/terraform/app/develop.auto.tfvars');
      const publicDocPath = path.join(dir, 'public-book/src/account-hygiene.md');
      mkdirSync(path.dirname(tfvarsPath), { recursive: true });
      mkdirSync(path.dirname(publicDocPath), { recursive: true });
      writeFileSync(tfvarsPath, 'aws_account_id = "000000000000"\n');
      writeFileSync(publicDocPath, 'AWS account ID: 000000000000\n');

      const result = runScanRoot(dir);

      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows the zero account placeholder in developer-portal artifacts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-developer-portal-placeholder-'));
    try {
      for (const relativePath of [
        'catalog-info.yaml',
        'openapi/stark-ballot-api.openapi.json',
        'techdocs/mkdocs.yml',
        'techdocs/docs/index.md',
      ]) {
        const filePath = path.join(dir, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'example: 000000000000\n');
      }

      expect(runScanRoot(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a concrete account ID only at the private source deployment-target configuration path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-private-target-config-'));
    const accountId = ['9672', '8327', '8943'].join('');
    const configurationPath = path.join(dir, 'packages/deployment-authority/deployment-targets.json');
    const adjacentPath = path.join(dir, 'packages/deployment-authority/copied-targets.json');
    try {
      mkdirSync(path.dirname(configurationPath), { recursive: true });
      writeFileSync(configurationPath, `${JSON.stringify({ accountId }, null, 2)}\n`);

      const privateSourceResult = runScanRoot(dir);
      expect(privateSourceResult.status).toBe(0);

      writeFileSync(adjacentPath, `${JSON.stringify({ accountId }, null, 2)}\n`);
      const adjacentResult = runScanRoot(dir);
      expect(adjacentResult.status).toBe(1);
      expect(adjacentResult.stderr).toContain('packages/deployment-authority/copied-targets.json');
      expect(adjacentResult.stderr).toContain('aws_account_id_label');
      expect(adjacentResult.stderr).not.toContain(accountId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsanitized account ID at the deployment-target path in a generated snapshot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-generated-target-config-'));
    const accountId = ['9672', '8327', '8943'].join('');
    const configurationPath = path.join(dir, 'packages/deployment-authority/deployment-targets.json');
    try {
      mkdirSync(path.dirname(configurationPath), { recursive: true });
      writeFileSync(path.join(dir, '.public-repository'), 'PUBLIC_REPOSITORY_SNAPSHOT=1\n');
      writeFileSync(configurationPath, `${JSON.stringify({ accountId }, null, 2)}\n`);

      const result = runScanRoot(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/deployment-authority/deployment-targets.json');
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).not.toContain(accountId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects concrete Terraform backend bucket identifiers only in publishable source documentation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-terraform-backend-source-'));
    const backendBucket = ['example', 'terraform', 'state', 'a7c9'].join('-');
    const publicDocPath = path.join(dir, 'docs/infrastructure/terraform.md');
    const privateDocPath = path.join(dir, 'docs/internal/deployment/terraform.md');

    try {
      for (const filePath of [publicDocPath, privateDocPath]) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(
          filePath,
          ['```hcl', 'terraform {', '  backend "s3" {', `    bucket = "${backendBucket}"`, '  }', '}', '```', ''].join(
            '\n',
          ),
        );
      }

      const publicResult = runScanRoot(dir);
      expect(publicResult.status).toBe(1);
      expect(publicResult.stderr).toContain('docs/infrastructure/terraform.md:4');
      expect(publicResult.stderr).toContain('terraform_backend_bucket_identifier');
      expect(publicResult.stderr).not.toContain('docs/internal/deployment/terraform.md');
      expect(publicResult.stderr).not.toContain(backendBucket);

      rmSync(publicDocPath);
      const privateOnlyResult = runScanRoot(dir);
      expect(privateOnlyResult.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a concrete Terraform backend bucket passed through the standard CLI option', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-terraform-backend-cli-'));
    const backendBucket = ['example', 'terraform', 'state', 'c9e1'].join('-');
    const publicDocPath = path.join(dir, 'docs/infrastructure/terraform.md');

    try {
      mkdirSync(path.dirname(publicDocPath), { recursive: true });
      writeFileSync(publicDocPath, `terraform init -backend-config="bucket=${backendBucket}"\n`);

      const result = runScanRoot(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docs/infrastructure/terraform.md:1');
      expect(result.stderr).toContain('terraform_backend_bucket_identifier');
      expect(result.stderr).not.toContain(backendBucket);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows an ordinary aws_s3_bucket assignment outside a Terraform backend block', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-ordinary-s3-bucket-'));
    const ordinaryBucket = ['example', 'public', 'artifacts', 'd2f4'].join('-');
    const publicDocPath = path.join(dir, 'docs/infrastructure/storage.md');

    try {
      mkdirSync(path.dirname(publicDocPath), { recursive: true });
      writeFileSync(
        publicDocPath,
        [
          '```hcl',
          'terraform {',
          '  backend "s3" {',
          '    bucket = "<TERRAFORM_STATE_BUCKET>"',
          '  }',
          '}',
          '',
          'resource "aws_s3_bucket" "artifacts" {',
          `  bucket = "${ordinaryBucket}"`,
          '}',
          '```',
          '',
        ].join('\n'),
      );

      const result = runScanRoot(dir);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('terraform_backend_bucket_identifier');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows Terraform backend placeholders and generic backend-bucket prose', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-terraform-backend-placeholder-'));
    const publicDocPath = path.join(dir, 'docs/infrastructure/terraform.md');

    try {
      mkdirSync(path.dirname(publicDocPath), { recursive: true });
      writeFileSync(
        publicDocPath,
        [
          '```hcl',
          'terraform {',
          '  backend "s3" {',
          '    bucket = "<TERRAFORM_STATE_BUCKET>"',
          '  }',
          '}',
          '```',
          '',
          'TERRAFORM_STATE_BUCKET="${TERRAFORM_STATE_BUCKET}"',
          '',
          'The Terraform backend bucket is supplied through backend.local.hcl.',
          '',
        ].join('\n'),
      );

      const result = runScanRoot(dir);
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects concrete Terraform backend bucket identifiers in a generated public snapshot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-terraform-backend-snapshot-'));
    const backendBucket = ['generated', 'terraform', 'state', 'b8d2'].join('-');
    const generatedDocPath = path.join(dir, 'docs/PUBLIC_REPOSITORY.md');

    try {
      mkdirSync(path.dirname(generatedDocPath), { recursive: true });
      writeFileSync(path.join(dir, '.public-repository'), 'PUBLIC_REPOSITORY_SNAPSHOT=1\n');
      writeFileSync(generatedDocPath, `Terraform backend bucket: \`${backendBucket}\`\n`);

      const result = runScanRoot(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docs/PUBLIC_REPOSITORY.md:1');
      expect(result.stderr).toContain('terraform_backend_bucket_identifier');
      expect(result.stderr).not.toContain(backendBucket);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on concrete AWS account IDs in account-owner labels without printing the value', () => {
    const accountId = ['5555', '4444', '3333'].join('');
    withTempFile(`ownerAccountId: "${accountId}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).not.toContain(accountId);
    });
  });

  it('fails on raw presigned URL values under --files without printing URL material', () => {
    const credential = 'AKIAEXAMPLE%2F20260613%2Fap-northeast-1%2Fs3%2Faws4_request';
    const presignedUrl = [
      s3ObjectUrl(['example-bucket', 's3', 'amazonaws', 'com'], 'private/report'),
      '?',
      'X-Amz-Credential=',
      credential,
    ].join('');

    withTempFile(`report_url = "${presignedUrl}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_presigned_url');
      expect(result.stderr).not.toContain('example-bucket');
      expect(result.stderr).not.toContain(credential);
    });
  });

  it('fails on CloudFront signed-cookie values without printing cookie material', () => {
    const policy = 'eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9kZXZlbG9wLmV4YW1wbGUuY29tLyoifV19';
    const signature = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_';
    const keyPairId = 'K1234567890ABC';
    const cookie = `CloudFront-Policy=${policy}; CloudFront-Signature=${signature}; CloudFront-Key-Pair-Id=${keyPairId}`;

    withTempFile(`STARK_BALLOT_OPERATOR_AUTH_VALUE='${cookie}'`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cloudfront_signed_cookie');
      expect(result.stderr).not.toContain(policy);
      expect(result.stderr).not.toContain(signature);
      expect(result.stderr).not.toContain(keyPairId);
    });
  });

  it('fails on plain HTTPS S3 object URLs without printing URL material', () => {
    const urls = [
      s3ObjectUrl(['bucket', 's3', 'amazonaws', 'com'], 'private/report.json'),
      s3ObjectUrl(['bucket', 's3', 'ap-northeast-1', 'amazonaws', 'com'], 'private/report.json'),
      s3ObjectUrl(['s3', 'ap-northeast-1', 'amazonaws', 'com'], 'bucket/private/report.json'),
      s3ObjectUrl(['bucket', 's3', 'dualstack', 'ap-northeast-1', 'amazonaws', 'com'], 'private/report.json'),
      s3ObjectUrl(['s3', 'dualstack', 'ap-northeast-1', 'amazonaws', 'com'], 'bucket/private/report.json'),
    ];

    withTempFile(urls.map((url) => `report_url = "${url}"`).join('\n'), (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('raw_s3_object_url');
      expect(result.stderr).not.toContain('bucket.s3');
      expect(result.stderr).not.toContain('s3.ap-northeast-1.amazonaws.com');
      expect(result.stderr).not.toContain('private/report.json');
    });
  });

  it('allows plain HTTPS S3 endpoints without an object path', () => {
    withTempFile('endpoint = "https://bucket.s3.amazonaws.com"', (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(0);
    });
  });

  it('allows only the pinned public ECR credential-helper distribution objects', () => {
    const releaseHost = ['amazon-ecr-credential-helper-releases', 's3', 'us-east-2', 'amazonaws', 'com'];
    const pinnedUrl = s3ObjectUrl(releaseHost, '0.12.0/linux-amd64/docker-credential-ecr-login');
    const unpinnedUrl = s3ObjectUrl(releaseHost, 'latest/linux-amd64/docker-credential-ecr-login');

    withTempFile(`asset_url = "${pinnedUrl}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(0);
    });
    withTempFile(`asset_url = "${unpinnedUrl}"`, (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('raw_s3_object_url');
    });
  });

  it('allows bare presigned URL marker strings that are not serialized URL values', () => {
    withTempFile(['marker = "X-Amz-Signature"', 'pattern = "X-Amz-Signature=[0-9a-f]{16,}"'].join('\n'), (filePath) => {
      const result = runScan(filePath);
      expect(result.status).toBe(0);
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

  it('skips CodeBuild-generated private evidence and nested dependency trees in non-git source artifacts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-codebuild-source-'));
    const accountId = ['5555', '4444', '3333'].join('');
    const subnetId = ['subnet', '0abc1234def567890'].join('-');

    try {
      const evidencePath = path.join(dir, 'infra/terraform/app/evidence/source-preflight.json');
      const nestedDependencyPath = path.join(dir, 'apps/api/node_modules/private-package/index.js');
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      mkdirSync(path.dirname(nestedDependencyPath), { recursive: true });
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            imageUri: `${accountId}.dkr.ecr.ap-northeast-1.amazonaws.com/example@sha256:${'a'.repeat(64)}`,
            subnetId,
          },
          null,
          2,
        ),
      );
      writeFileSync(nestedDependencyPath, `role = "arn:aws:iam::${accountId}:role/example"\n`);

      const result = runScanAll(dir);

      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans a generated tree through --root without printing the matched value', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'public-safety-scan-root-'));
    const relativeFile = path.join('generated-public-repo', 'deploy-manifest.txt');
    const accountId = ['5555', '4444', '3333'].join('');
    const signature = 'b'.repeat(64);
    const presignedUrl = [
      s3ObjectUrl(['example-bucket', 's3', 'amazonaws', 'com'], 'private/report'),
      '?',
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      '&X-Amz-Signature=',
      signature,
    ].join('');

    try {
      const filePath = path.join(dir, relativeFile);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        [
          `role = "arn:aws:iam::${accountId}:role/example"`,
          `aws_account_id = "${accountId}"`,
          `expectedBucketOwner: "${accountId}"`,
          `report_url = "${presignedUrl}"`,
        ].join('\n'),
      );

      const result = runScanRoot(dir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('aws_account_arn');
      expect(result.stderr).toContain('aws_account_id_label');
      expect(result.stderr).toContain('aws_presigned_url');
      expect(result.stderr).toContain(relativeFile);
      expect(result.stderr).not.toContain(accountId);
      expect(result.stderr).not.toContain('example-bucket');
      expect(result.stderr).not.toContain(signature);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
