import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures';
import { canonicalJson, canonicalRecordJson } from './index.js';
import {
  APP_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitAppAcceptance,
  admitAppAcceptanceRecordKey,
  admitAppCurrentAcceptancePointer,
  admitRetainedAppAcceptance,
  bindAppAcceptanceSelection,
  deriveAppAcceptanceRecordKey,
  projectAppAcceptancePointerTransition,
  projectInitialAppAcceptancePointer,
} from './app-acceptance-ledger.js';
import {
  APP_ACCEPTANCE_RECORD_PREFIX,
  APP_SOURCE_SHA,
  DEPLOYMENT_ID,
  canonicalSha256,
  createAppAcceptanceProviderLockFixture,
  createAppAcceptanceFixture,
  createBoundSelectionFixture,
} from './testdata/app-acceptance-ledger-fixture.js';

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} fixture is not a record`);
  }
  return value as Record<string, unknown>;
}

function nestedRecord(root: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of path) {
    current = mutableRecord(current, path.join('.'))[key];
  }
  return mutableRecord(current, path.join('.'));
}

function withRetainedProvider(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const retained = structuredClone(record) as Record<string, unknown>;
  retained['provider'] = {
    ...nestedRecord(retained, 'provider'),
    lock: createAppAcceptanceProviderLockFixture('6.57.1'),
    selections: { 'registry.terraform.io/hashicorp/aws': '6.57.1' },
    terraformVersion: '1.15.5',
  };
  return retained;
}

function firstNonsecretInputFile(record: Record<string, unknown>): Record<string, unknown> {
  const inputs = nestedRecord(record, 'nonsecretInputs');
  const files = inputs['files'];
  if (!Array.isArray(files) || files.length !== 1) {
    throw new Error('nonsecret input fixture does not have one file');
  }
  return mutableRecord(files[0], 'nonsecret input file');
}

function rewriteAppInputValues(
  record: Record<string, unknown>,
  rewrite: (values: Record<string, unknown>) => void,
): void {
  const file = firstNonsecretInputFile(record);
  if (typeof file['contentBase64'] !== 'string') {
    throw new Error('nonsecret input fixture body is missing');
  }
  const values = mutableRecord(
    JSON.parse(Buffer.from(file['contentBase64'], 'base64').toString('utf8')),
    'nonsecret input values',
  );
  rewrite(values);
  const body = canonicalRecordJson(values);
  file['sha256'] = createHash('sha256').update(body).digest('hex');
  file['contentBase64'] = Buffer.from(body).toString('base64');
}

function selectRecoveryManifest(
  record: Record<string, unknown>,
  inputManifestSha256: string,
  retainedManifestSha256: string,
): void {
  const recoveryId = '8'.repeat(64);
  rewriteAppInputValues(record, (values) => {
    const accountId = String(values['aws_account_id']);
    const region = String(values['aws_region']);
    values['dynamodb_recovery_phase'] = 'replacement_quiesced';
    values['dynamodb_recovery_activation'] = {
      account_alias: values['account_alias'],
      account_id: values['aws_account_id'],
      deployment_environment: values['deployment_environment'],
      kms_key_arn: `arn:aws:kms:${region}:${accountId}:key/recovery-fixture`,
      manifest_sha256: inputManifestSha256,
      manifest_type: 'dynamodb-recovery-activation',
      recovery_id: recoveryId,
      recovery_point: '2026-08-14T00:00:00.000Z',
      region: values['aws_region'],
      sessions: {
        key_schema: 'sessionId:S:HASH',
        source_table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/sessions`,
        table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/sessions-replacement`,
        table_name: 'sessions-replacement',
      },
      validation_status: 'validated',
      votes: {
        key_schema: 'sessionId:S:HASH,voteIndex:N:RANGE',
        source_table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/votes`,
        table_arn: `arn:aws:dynamodb:${region}:${accountId}:table/votes-replacement`,
        table_name: 'votes-replacement',
        vote_id_index_schema: 'voteId-index:voteId:S:HASH:KEYS_ONLY',
      },
    };
  });
  nestedRecord(record, 'runtime')['dynamodbRecovery'] = {
    phase: 'replacement_quiesced',
    manifest: {
      key: `recovery-manifests/stark-dev/develop/${recoveryId}.json`,
      versionId: 'recovery-manifest-version',
      sha256: retainedManifestSha256,
    },
  };
}

function selectRollbackVerifierAuthority(record: Record<string, unknown>, packageVersionId?: string): void {
  const contextTarget = nestedRecord(record, 'targetContext', 'target');
  const contextNames = nestedRecord(record, 'targetContext', 'names');
  const proverImage = nestedRecord(record, 'releaseAuthority', 'proverImage');
  const verifierArtifact = nestedRecord(
    record,
    'deployables',
    'lambdaArtifacts',
    'artifacts',
    'image_signature_verifier',
  );
  const partition = String(contextTarget['partition']);
  const region = String(contextTarget['region']);
  const accountId = String(contextTarget['accountId']);
  const functionName = String(contextNames['signatureVerifierFunction']);
  const functionArn = `arn:${partition}:lambda:${region}:${accountId}:function:${functionName}`;
  const selectedAuthority = {
    architecture: 'x86_64',
    environment_sha256: '8'.repeat(64),
    execution_role_arn: `arn:${partition}:iam::${accountId}:role/${String(contextNames['signatureVerifierRole'])}`,
    execution_role_assume_policy_sha256: '9'.repeat(64),
    execution_role_permissions_boundary_arn: `arn:${partition}:iam::${accountId}:policy/${String(contextNames['signatureVerifierPermissionsBoundary'])}`,
    execution_role_permissions_boundary_policy_sha256: 'a'.repeat(64),
    execution_role_policy_sha256: 'b'.repeat(64),
    function_arn: functionArn,
    function_configuration_sha256: 'c'.repeat(64),
    function_version: '42',
    package: {
      asset_manifest_sha256: verifierArtifact['assetManifestSha256'],
      s3_bucket: verifierArtifact['bucket'],
      s3_key: verifierArtifact['key'],
      s3_object_version: packageVersionId ?? verifierArtifact['versionId'],
      source_code_hash: verifierArtifact['sourceCodeHash'],
      trust_root_sha256: verifierArtifact['trustRootSha256'],
    },
    preflight_alias_arn: `${functionArn}:preflight`,
    runtime: 'nodejs24.x',
    runtime_alias_arn: `${functionArn}:runtime`,
    timeout_seconds: 120,
  };
  record['deploymentMode'] = 'rollback';
  rewriteAppInputValues(record, (values) => {
    values['deploy_mode'] = 'rollback';
    values['image_signature_preflight_prover_image_uri'] = null;
    values['image_signature_verifier_base_prover_image_uri'] = proverImage['imageUri'];
    values['image_signature_verifier_reconciliation_desired_json'] = null;
    values['image_signature_verifier_reconciliation_desired_sha256'] = null;
    values['image_signature_verifier_reconciled_function_version'] = null;
    values['image_signature_verifier_selected_authority'] = selectedAuthority;
  });
}

function selectFreshRollback(
  record: Record<string, unknown>,
  options: {
    packageVersionId?: string;
    retained?: Readonly<Record<string, unknown>>;
    deploymentIdentityAuthoritySha256?: string;
  } = {},
): void {
  const retained = options.retained ?? createAppAcceptanceFixture();
  const deploymentIdentityAuthoritySha256 = options.deploymentIdentityAuthoritySha256 ?? '0'.repeat(64);
  const freshDeploymentId = `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`;
  const retainedRollback = retained['rollbackSelection'] as Readonly<Record<string, unknown>> | null;
  record['deploymentId'] = freshDeploymentId;
  record['rollbackSelection'] = {
    acceptanceKey: deriveAppAcceptanceRecordKey(retained, 'stark-dev/develop'),
    selectedDeploymentId: retained['deploymentId'],
    staticArtifactDeploymentId: retainedRollback?.['staticArtifactDeploymentId'] ?? retained['deploymentId'],
  };
  nestedRecord(record, 'runtime')['deploymentIdentityAuthoritySha256'] = deploymentIdentityAuthoritySha256;
  nestedRecord(record, 'smoke')['deploymentId'] = freshDeploymentId;
  rewriteAppInputValues(record, (values) => {
    values['deployment_id'] = freshDeploymentId;
  });
  selectRollbackVerifierAuthority(record, options.packageVersionId);
}

type AppAcceptanceCorruption = {
  readonly name: string;
  readonly corrupt: (record: Record<string, unknown>) => void;
};

const appAcceptanceCorruptions: readonly AppAcceptanceCorruption[] = [
  {
    name: 'target key',
    corrupt: (record) => {
      record['targetKey'] = 'stark-prod/main';
    },
  },
  {
    name: 'target context',
    corrupt: (record) => {
      nestedRecord(record, 'targetContext')['unexpected'] = true;
    },
  },
  {
    name: 'framework source',
    corrupt: (record) => {
      nestedRecord(record, 'targetContext', 'source')['frameworkSourceSha'] = 'b'.repeat(40);
    },
  },
  {
    name: 'backend',
    corrupt: (record) => {
      nestedRecord(record, 'backend')['bucketName'] = 'detached-state-bucket';
    },
  },
  {
    name: 'selected source',
    corrupt: (record) => {
      record['selectedApplicationSourceSha'] = 'b'.repeat(40);
    },
  },
  {
    name: 'nonsecret input hash',
    corrupt: (record) => {
      firstNonsecretInputFile(record)['sha256'] = '0'.repeat(64);
    },
  },
  {
    name: 'secret references',
    corrupt: (record) => {
      record['secretReferences'] = [];
    },
  },
  {
    name: 'provider lock',
    corrupt: (record) => {
      nestedRecord(record, 'provider')['lock'] = '';
    },
  },
  {
    name: 'provider selections',
    corrupt: (record) => {
      nestedRecord(record, 'provider', 'selections')['registry.terraform.io/hashicorp/aws'] = '6.57.0';
    },
  },
  {
    name: 'provider runtime',
    corrupt: (record) => {
      nestedRecord(record, 'provider', 'runtime')['sourceSha'] = 'b'.repeat(40);
    },
  },
  {
    name: 'approval timestamp',
    corrupt: (record) => {
      nestedRecord(record, 'approval')['approvedAt'] = '2026-08-14T01:05:05.000Z';
    },
  },
  {
    name: 'acceptance timestamp',
    corrupt: (record) => {
      record['acceptedAt'] = '2026-08-14T01:04:05Z';
    },
  },
  {
    name: 'approval evidence',
    corrupt: (record) => {
      nestedRecord(record, 'approval', 'evidence')['sha256'] = 'not-a-sha256';
    },
  },
  {
    name: 'approval evidence execution',
    corrupt: (record) => {
      nestedRecord(record, 'approval', 'evidence')['key'] = 'approval-evidence/detached.json';
    },
  },
  {
    name: 'smoke evidence',
    corrupt: (record) => {
      nestedRecord(record, 'smoke', 'evidence')['versionId'] = '';
    },
  },
  {
    name: 'smoke evidence attempt',
    corrupt: (record) => {
      nestedRecord(record, 'smoke', 'evidence')['key'] = 'app-smoke/detached.json';
    },
  },
  {
    name: 'smoke execution',
    corrupt: (record) => {
      nestedRecord(record, 'smoke')['pipelineExecutionId'] = '22222222-3333-4444-5555-666666666666';
    },
  },
  {
    name: 'smoke deployment',
    corrupt: (record) => {
      nestedRecord(record, 'smoke')['deploymentId'] = `dep_${'0'.repeat(32)}`;
    },
  },
  {
    name: 'Foundation acceptance key',
    corrupt: (record) => {
      const authority = nestedRecord(record, 'releaseAuthority');
      authority['foundationAcceptanceKey'] = authority['toolchainReleaseKey'];
    },
  },
  {
    name: 'Foundation contract hash',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority')['foundationContractHash'] = 'not-a-sha256';
    },
  },
  {
    name: 'Toolchain release key',
    corrupt: (record) => {
      const authority = nestedRecord(record, 'releaseAuthority');
      authority['toolchainReleaseKey'] = authority['proverReleaseKey'];
    },
  },
  {
    name: 'Prover release closure',
    corrupt: (record) => {
      const authority = nestedRecord(record, 'releaseAuthority');
      if (typeof authority['proverReleaseKey'] !== 'string') {
        throw new Error('Prover release key fixture is missing');
      }
      authority['proverReleaseKey'] = authority['proverReleaseKey'].replace(
        /[0-9a-f]{64}\.json$/u,
        `${'0'.repeat(64)}.json`,
      );
    },
  },
  {
    name: 'Toolchain image closure',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'toolchainImage')['imageDigest'] = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    name: 'Prover image closure',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'proverImage')['imageDigest'] = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    name: 'zkVM contract closure',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'zkvm')['applicationZkvmContractHash'] = '0'.repeat(64);
    },
  },
  {
    name: 'expected ImageID closure',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'zkvm')['expectedImageId'] = `0x${'0'.repeat(64)}`;
    },
  },
  {
    name: 'ImageID mapping hash closure',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'zkvm')['imageIdMappingSha256'] = '0'.repeat(64);
    },
  },
  {
    name: 'ImageID mapping path',
    corrupt: (record) => {
      rewriteAppInputValues(record, (values) => {
        nestedRecord(values, 'image_id_mapping_evidence')['mapping_path'] = 'public/detached-imageId-mapping.json';
      });
    },
  },
  {
    name: 'failure-marker contract',
    corrupt: (record) => {
      nestedRecord(record, 'releaseAuthority', 'zkvm')['failureMarkerContractSha256'] = 'not-a-sha256';
    },
  },
  {
    name: 'verifier confirmed mapping',
    corrupt: (record) => {
      nestedRecord(record, 'verifier', 'confirmedImageIdMapping')['methodVersion'] = 15;
    },
  },
  {
    name: 'verifier signing result',
    corrupt: (record) => {
      nestedRecord(record, 'verifier', 'signaturePreflight')['managedSigningStatus'] = 'IN_PROGRESS';
    },
  },
  {
    name: 'normal verifier base authority',
    corrupt: (record) => {
      rewriteAppInputValues(record, (values) => {
        values['image_signature_verifier_base_prover_image_uri'] = values['prover_image_uri'];
      });
    },
  },
  {
    name: 'normal verifier preflight image',
    corrupt: (record) => {
      rewriteAppInputValues(record, (values) => {
        values['image_signature_preflight_prover_image_uri'] = String(values['prover_image_uri']).replace(
          /[0-9a-f]{64}$/u,
          '0'.repeat(64),
        );
      });
    },
  },
  {
    name: 'verifier package',
    corrupt: (record) => {
      nestedRecord(record, 'verifier', 'signaturePreflight', 'verifierPackage')['versionId'] = 'detached-version';
    },
  },
  {
    name: 'static deployable',
    corrupt: (record) => {
      nestedRecord(record, 'deployables', 'staticFrontend')['key'] = 'detached/static.tar.gz';
    },
  },
  {
    name: 'recovery manifest',
    corrupt: (record) => {
      nestedRecord(record, 'runtime', 'dynamodbRecovery')['manifest'] = {
        key: 'recovery/manifest.json',
        versionId: 'manifest-version',
        sha256: '6'.repeat(64),
      };
    },
  },
  {
    name: 'Apply outputs',
    corrupt: (record) => {
      nestedRecord(record, 'runtime')['applyOutputsSha256'] = 'not-a-sha256';
    },
  },
  {
    name: 'deployment identity',
    corrupt: (record) => {
      nestedRecord(record, 'runtime')['deploymentIdentityAuthoritySha256'] = '0'.repeat(64);
    },
  },
];

describe('App acceptance ledger record', () => {
  it('admits one exact descriptor-safe record and derives a content-addressed key', () => {
    const source = createAppAcceptanceFixture();
    let propertyReads = 0;
    const proxied = new Proxy(source, {
      get() {
        propertyReads += 1;
        return 'swapped';
      },
    });

    const admitted = admitAppAcceptance(proxied, 'stark-dev/develop');
    const key = deriveAppAcceptanceRecordKey(proxied, 'stark-dev/develop');

    expect(propertyReads).toBe(0);
    expect(admitted).toEqual(source);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.releaseAuthority)).toBe(true);
    expect(key).toMatch(new RegExp(`^${APP_ACCEPTANCE_RECORD_PREFIX}[0-9a-f]{64}\\.json$`, 'u'));
    expect(admitAppAcceptanceRecordKey(key, 'stark-dev/develop')).toBe(key);
    expect(key.endsWith(`${canonicalSha256(admitted)}.json`)).toBe(true);
  });

  it('preserves exact supported retained provider identities while fresh publication stays current-only', () => {
    const identities = [
      { terraformVersion: '1.15.8', awsProviderVersion: '6.58.0', current: true },
      { terraformVersion: '1.15.5', awsProviderVersion: '6.58.0', current: false },
      { terraformVersion: '1.15.5', awsProviderVersion: '6.57.1', current: false },
    ] as const;

    for (const identity of identities) {
      const fixture = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
      fixture['provider'] = {
        ...nestedRecord(fixture, 'provider'),
        lock: createAppAcceptanceProviderLockFixture(identity.awsProviderVersion),
        selections: { 'registry.terraform.io/hashicorp/aws': identity.awsProviderVersion },
        terraformVersion: identity.terraformVersion,
      };

      expect(() => admitRetainedAppAcceptance(fixture, 'stark-dev/develop')).not.toThrow();
      if (identity.current) {
        expect(() => admitAppAcceptance(fixture, 'stark-dev/develop')).not.toThrow();
      } else {
        expect(() => admitAppAcceptance(fixture, 'stark-dev/develop')).toThrow(/Terraform runtime/iu);
      }
    }

    const unsupported = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    unsupported['provider'] = {
      ...nestedRecord(unsupported, 'provider'),
      lock: createAppAcceptanceProviderLockFixture('6.57.1'),
      selections: { 'registry.terraform.io/hashicorp/aws': '6.57.1' },
      terraformVersion: '1.15.8',
    };
    expect(() => admitRetainedAppAcceptance(unsupported, 'stark-dev/develop')).toThrow(/retained.*provider identity/iu);
  });

  it('rejects unknown nested fields, accessors, and detached cross-bindings', () => {
    const fixture = createAppAcceptanceFixture();
    const approval = fixture['approval'] as Readonly<Record<string, unknown>>;
    expect(() =>
      admitAppAcceptance({ ...fixture, approval: { ...approval, unexpected: true } }, 'stark-dev/develop'),
    ).toThrow(/exact current shape/u);

    let accessorCalls = 0;
    const hostile = { ...fixture };
    Object.defineProperty(hostile, 'deploymentId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return DEPLOYMENT_ID;
      },
    });
    expect(() => admitAppAcceptance(hostile, 'stark-dev/develop')).toThrow(/enumerable data/u);
    expect(accessorCalls).toBe(0);

    const smoke = fixture['smoke'] as Readonly<Record<string, unknown>>;
    expect(() =>
      admitAppAcceptance(
        { ...fixture, smoke: { ...smoke, acceptedPlanChecksum: '0'.repeat(64) } },
        'stark-dev/develop',
      ),
    ).toThrow(/smoke.*plan/iu);
    const releaseAuthority = fixture['releaseAuthority'] as Readonly<Record<string, unknown>>;
    const proverImage = releaseAuthority['proverImage'] as Readonly<Record<string, unknown>>;
    expect(() =>
      admitAppAcceptance(
        {
          ...fixture,
          releaseAuthority: {
            ...releaseAuthority,
            proverImage: { ...proverImage, imageDigest: `sha256:${'0'.repeat(64)}` },
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/Prover image/iu);

    const runtime = fixture['runtime'] as Readonly<Record<string, unknown>>;
    expect(() =>
      admitAppAcceptance(
        {
          ...fixture,
          runtime: {
            ...runtime,
            proverTaskDefinitionArn: 'arn:aws:ecs:ap-northeast-1:111122223333:task-definition/stark-ballot-prover:42',
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/runtime snapshot.*exact current shape/iu);
  });

  it('binds plan disposition to approval policy and all rollback material to App inputs', () => {
    const fixture = createAppAcceptanceFixture();
    const approval = fixture['approval'] as Readonly<Record<string, unknown>>;
    expect(() =>
      admitAppAcceptance(
        {
          ...fixture,
          planDisposition: 'empty',
          approval: { ...approval, approvalMode: 'manual-approval' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/approval.*plan disposition/iu);

    const nonsecretInputs = fixture['nonsecretInputs'] as Readonly<Record<string, unknown>>;
    const files = nonsecretInputs['files'] as readonly Readonly<Record<string, unknown>>[];
    const file = files[0];
    if (file === undefined || typeof file['contentBase64'] !== 'string') {
      throw new Error('test fixture input file is missing');
    }
    const values = JSON.parse(Buffer.from(file['contentBase64'], 'base64').toString('utf8')) as Record<string, unknown>;
    values['deployment_id'] = `dep_${'0'.repeat(32)}`;
    const body = canonicalRecordJson(values);
    expect(() =>
      admitAppAcceptance(
        {
          ...fixture,
          nonsecretInputs: {
            ...nonsecretInputs,
            files: [
              {
                ...file,
                sha256: createHash('sha256').update(body).digest('hex'),
                contentBase64: Buffer.from(body).toString('base64'),
              },
            ],
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/deployment ID/iu);
  });

  it('rejects an alternate Lambda deployable key even when the stored App inputs repeat it', () => {
    const fixture = createAppAcceptanceFixture();
    const deployables = fixture['deployables'] as Readonly<Record<string, unknown>>;
    const lambdaSet = deployables['lambdaArtifacts'] as Readonly<Record<string, unknown>>;
    const artifacts = lambdaSet['artifacts'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    const publicApi = artifacts['public_api'];
    if (publicApi === undefined) {
      throw new Error('test fixture public API artifact is missing');
    }
    const alternateKey = `${lambdaSet['prefix'] as string}/alternate-public-api.zip`;
    const changedArtifacts = { ...artifacts, public_api: { ...publicApi, key: alternateKey } };
    const nonsecretInputs = fixture['nonsecretInputs'] as Readonly<Record<string, unknown>>;
    const files = nonsecretInputs['files'] as readonly Readonly<Record<string, unknown>>[];
    const file = files[0];
    if (file === undefined || typeof file['contentBase64'] !== 'string') {
      throw new Error('test fixture input file is missing');
    }
    const values = JSON.parse(Buffer.from(file['contentBase64'], 'base64').toString('utf8')) as Record<string, unknown>;
    const inputArtifacts = values['lambda_artifacts'] as Record<string, Record<string, unknown>>;
    inputArtifacts['public_api'] = { ...inputArtifacts['public_api'], s3_key: alternateKey };
    const body = canonicalRecordJson(values);

    expect(() =>
      admitAppAcceptance(
        {
          ...fixture,
          deployables: { ...deployables, lambdaArtifacts: { ...lambdaSet, artifacts: changedArtifacts } },
          nonsecretInputs: {
            ...nonsecretInputs,
            files: [
              {
                ...file,
                sha256: createHash('sha256').update(body).digest('hex'),
                contentBase64: Buffer.from(body).toString('base64'),
              },
            ],
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/canonical Lambda artifact key/iu);
  });

  it('binds a non-primary recovery activation to the retained immutable manifest body', () => {
    const admitted = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectRecoveryManifest(admitted, '6'.repeat(64), '6'.repeat(64));
    expect(() => admitAppAcceptance(admitted, 'stark-dev/develop')).not.toThrow();

    const detached = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectRecoveryManifest(detached, '6'.repeat(64), '7'.repeat(64));
    expect(() => admitAppAcceptance(detached, 'stark-dev/develop')).toThrow(/recovery activation.*detached/iu);

    const wrongKey = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectRecoveryManifest(wrongKey, '6'.repeat(64), '6'.repeat(64));
    nestedRecord(wrongKey, 'runtime', 'dynamodbRecovery', 'manifest')['key'] =
      'recovery-manifests/stark-dev/develop/detached-recovery.json';
    expect(() => admitAppAcceptance(wrongKey, 'stark-dev/develop')).toThrow(/recovery activation.*manifest key/iu);
  });

  it('binds rollback verifier selection to the exact retained verifier package and target identity', () => {
    const admitted = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectFreshRollback(admitted);
    expect(() => admitAppAcceptance(admitted, 'stark-dev/develop')).not.toThrow();

    const detached = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectFreshRollback(detached, { packageVersionId: 'detached-package-version' });
    expect(() => admitAppAcceptance(detached, 'stark-dev/develop')).toThrow(/selected verifier.*package/iu);
  });

  it('binds normal verifier reconciliation JSON, hash, and expected FunctionVersion together', () => {
    const produced = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    rewriteAppInputValues(produced, (values) => {
      const desired = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json'])) as unknown;
      const body = canonicalJson(desired);
      expect(body).not.toBe(canonicalRecordJson(desired));
      values['image_signature_verifier_reconciliation_desired_json'] = body;
      values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    });

    expect(() => admitAppAcceptance(produced, 'stark-dev/develop')).not.toThrow();

    const absentNativeHash = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    rewriteAppInputValues(absentNativeHash, (values) => {
      const desired = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json'])) as Record<
        string,
        unknown
      >;
      nestedRecord(desired, 'aliases', 'runtime', 'target', 'function')['awsConfigSha256'] = null;
      const body = canonicalJson(desired);
      values['image_signature_verifier_reconciliation_desired_json'] = body;
      values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    });
    expect(() => admitAppAcceptance(absentNativeHash, 'stark-dev/develop')).not.toThrow();

    const missingCoordinates = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    rewriteAppInputValues(missingCoordinates, (values) => {
      const desired = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json'])) as Record<
        string,
        unknown
      >;
      nestedRecord(desired, 'aliases', 'runtime', 'target', 'function')['resolvedS3Object'] = null;
      const body = canonicalJson(desired);
      values['image_signature_verifier_reconciliation_desired_json'] = body;
      values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    });
    expect(() => admitAppAcceptance(missingCoordinates, 'stark-dev/develop')).toThrow(
      /reconciliation authority.*invalid/iu,
    );

    const detached = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    rewriteAppInputValues(detached, (values) => {
      const desired = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json'])) as Record<
        string,
        unknown
      >;
      desired['expectedFunctionVersion'] = '43';
      const body = canonicalJson(desired);
      values['image_signature_verifier_reconciliation_desired_json'] = body;
      values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    });

    expect(() => admitAppAcceptance(detached, 'stark-dev/develop')).toThrow(/reconciliation authority.*detached/iu);

    const alternateEncoding = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    rewriteAppInputValues(alternateEncoding, (values) => {
      const desired = JSON.parse(String(values['image_signature_verifier_reconciliation_desired_json'])) as unknown;
      const body = canonicalRecordJson(desired);
      values['image_signature_verifier_reconciliation_desired_json'] = body;
      values['image_signature_verifier_reconciliation_desired_sha256'] = createHash('sha256')
        .update(body)
        .digest('hex');
    });
    expect(() => admitAppAcceptance(alternateEncoding, 'stark-dev/develop')).toThrow(
      /reconciliation authority.*detached/iu,
    );
  });

  it('binds a fresh rollback identity to one retained acceptance and its exact static archive owner', () => {
    const admitted = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectFreshRollback(admitted);
    expect(() => admitAppAcceptance(admitted, 'stark-dev/develop')).not.toThrow();

    const detachedSelection = structuredClone(admitted);
    nestedRecord(detachedSelection, 'rollbackSelection')['staticArtifactDeploymentId'] = `dep_${'1'.repeat(32)}`;
    expect(() => admitAppAcceptance(detachedSelection, 'stark-dev/develop')).toThrow(/static frontend/iu);

    const detachedStatic = structuredClone(admitted);
    nestedRecord(detachedStatic, 'deployables', 'staticFrontend')['key'] =
      `static-frontend-artifacts/${APP_SOURCE_SHA}/${String(detachedStatic['deploymentId'])}/dist.tar.gz`;
    expect(() => admitAppAcceptance(detachedStatic, 'stark-dev/develop')).toThrow(/static frontend/iu);

    const missingSelection = structuredClone(admitted);
    missingSelection['rollbackSelection'] = null;
    expect(() => admitAppAcceptance(missingSelection, 'stark-dev/develop')).toThrow(/rollback selection/iu);
  });

  it('rejects rollback provenance on a normal acceptance', () => {
    const admitted = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    admitted['rollbackSelection'] = {
      acceptanceKey: deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop'),
      selectedDeploymentId: DEPLOYMENT_ID,
      staticArtifactDeploymentId: DEPLOYMENT_ID,
    };
    expect(() => admitAppAcceptance(admitted, 'stark-dev/develop')).toThrow(/normal.*rollback selection/iu);
  });

  it('preserves the original static archive owner across rollback-of-rollback selection', () => {
    const retainedRollback = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectFreshRollback(retainedRollback);
    const admittedRetained = admitAppAcceptance(retainedRollback, 'stark-dev/develop');

    const nextRollback = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    selectFreshRollback(nextRollback, {
      retained: admittedRetained,
      deploymentIdentityAuthoritySha256: '1'.repeat(64),
    });
    const admittedNext = admitAppAcceptance(nextRollback, 'stark-dev/develop');

    expect(admittedNext.rollbackSelection).toEqual({
      acceptanceKey: deriveAppAcceptanceRecordKey(admittedRetained, 'stark-dev/develop'),
      selectedDeploymentId: admittedRetained.deploymentId,
      staticArtifactDeploymentId: DEPLOYMENT_ID,
    });
    expect(admittedNext.deployables['staticFrontend']).toEqual(admittedRetained.deployables['staticFrontend']);
  });

  it.each(appAcceptanceCorruptions)('rejects independent $name corruption', ({ corrupt }) => {
    const fixture = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
    corrupt(fixture);
    expect(() => admitAppAcceptance(fixture, 'stark-dev/develop')).toThrow();
  });
});

describe('App current acceptance pointer', () => {
  it('projects bounded unique head-first history bound to the observed predecessor', () => {
    const recordKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const priorKey = recordKey.replace(/[0-9a-f]{64}\.json$/u, `${'0'.repeat(64)}.json`);

    const pointer = projectInitialAppAcceptancePointer(
      {
        history: [recordKey, priorKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );

    expect(pointer).toMatchObject({
      kind: APP_CURRENT_ACCEPTANCE_POINTER_KIND,
      targetKey: 'stark-dev/develop',
      generation: 1,
      headKey: recordKey,
      history: [recordKey, priorKey],
      previous: {
        etag: 'captured-etag',
        versionId: 'captured-version',
      },
    });
    expect(Object.keys(pointer).sort()).toEqual(
      ['compareAndSwapEvidenceId', 'generation', 'headKey', 'history', 'kind', 'previous', 'targetKey'].sort(),
    );
    expect(pointer.compareAndSwapEvidenceId).toMatch(/^cas\/app-acceptance\/[0-9a-f]{64}$/u);
    expect(admitAppCurrentAcceptancePointer(pointer, 'stark-dev/develop')).toEqual(pointer);
  });

  it('preserves prepend, dedupe, truncation, and predecessor-observation binding', () => {
    const baseKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const history = Array.from({ length: 10 }, (_, index) =>
      baseKey.replace(/[0-9a-f]{64}\.json$/u, `${index.toString(16).repeat(64)}.json`),
    );
    const currentPointer = projectInitialAppAcceptancePointer(
      {
        history,
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    const nextRecordKey = history[4];
    if (nextRecordKey === undefined) {
      throw new Error('test history is incomplete');
    }

    const next = projectAppAcceptancePointerTransition(
      {
        currentPointer,
        currentPointerObservation: { etag: 'current-etag', versionId: 'current-version' },
        nextRecordKey,
      },
      'stark-dev/develop',
    );

    expect(next.headKey).toBe(nextRecordKey);
    expect(next.generation).toBe(2);
    expect(next.history).toEqual([nextRecordKey, ...history.filter((key) => key !== nextRecordKey)].slice(0, 10));
    expect(next.previous).toEqual({
      etag: 'current-etag',
      versionId: 'current-version',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '1'],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s generation', (_label, generation) => {
    const recordKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const pointer = projectInitialAppAcceptancePointer(
      {
        history: [recordKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );

    expect(() => admitAppCurrentAcceptancePointer({ ...pointer, generation }, 'stark-dev/develop')).toThrow(
      /positive safe integer/iu,
    );
  });

  it('rejects a missing generation and generation detached from the pointer digest', () => {
    const recordKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const pointer = projectInitialAppAcceptancePointer(
      {
        history: [recordKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    const missingGeneration = structuredClone(pointer) as Record<string, unknown>;
    Reflect.deleteProperty(missingGeneration, 'generation');

    expect(() => admitAppCurrentAcceptancePointer(missingGeneration, 'stark-dev/develop')).toThrow(
      /exact current shape/iu,
    );
    expect(() => admitAppCurrentAcceptancePointer({ ...pointer, generation: 2 }, 'stark-dev/develop')).toThrow(
      /compare-and-swap/iu,
    );
    expect(() =>
      projectInitialAppAcceptancePointer(
        {
          generation: 7,
          history: [recordKey],
          predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/exact current shape/iu);
  });

  it('rejects generation overflow before projecting a later head', () => {
    const recordKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const nextRecordKey = recordKey.replace(/[0-9a-f]{64}\.json$/u, `${'0'.repeat(64)}.json`);
    const initial = projectInitialAppAcceptancePointer(
      {
        history: [recordKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    const generation = Number.MAX_SAFE_INTEGER;
    const currentPointer = {
      ...initial,
      generation,
      compareAndSwapEvidenceId: `cas/app-acceptance/${canonicalSha256({
        generation,
        headKey: initial.headKey,
        history: initial.history,
        previous: initial.previous,
      })}`,
    };

    expect(() =>
      projectAppAcceptancePointerTransition(
        {
          currentPointer,
          currentPointerObservation: { etag: 'current-etag', versionId: 'current-version' },
          nextRecordKey,
        },
        'stark-dev/develop',
      ),
    ).toThrow(/generation.*overflow/iu);
  });

  it('rejects duplicate, empty, oversized, and content-detached pointer shapes', () => {
    const recordKey = deriveAppAcceptanceRecordKey(createAppAcceptanceFixture(), 'stark-dev/develop');
    const priorKey = recordKey.replace(/[0-9a-f]{64}\.json$/u, `${'0'.repeat(64)}.json`);
    expect(() =>
      projectInitialAppAcceptancePointer(
        {
          history: [recordKey, recordKey],
          predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/duplicate/iu);
    expect(() =>
      projectInitialAppAcceptancePointer(
        {
          history: [],
          predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/1 and 10/iu);
    expect(() =>
      projectInitialAppAcceptancePointer(
        {
          history: Array.from({ length: 11 }, (_, index) =>
            recordKey.replace(/[0-9a-f]{64}\.json$/u, `${index.toString(16).repeat(64)}.json`),
          ),
          predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/1 and 10/iu);

    const initial = projectInitialAppAcceptancePointer(
      {
        history: [recordKey, priorKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    expect(() => admitAppCurrentAcceptancePointer({ ...initial, headKey: priorKey }, 'stark-dev/develop')).toThrow(
      /first history key/iu,
    );
    expect(() =>
      projectAppAcceptancePointerTransition(
        {
          currentPointer: initial,
          currentPointerObservation: { etag: 'current-etag', versionId: 'current-version' },
          nextRecordKey: recordKey,
        },
        'stark-dev/develop',
      ),
    ).toThrow(/must change its head/iu);
    expect(() =>
      admitAppCurrentAcceptancePointer(
        { ...initial, compareAndSwapEvidenceId: 'cas/app-acceptance/bad' },
        'stark-dev/develop',
      ),
    ).toThrow(/compare-and-swap/iu);
    const detachedTail = priorKey.replace(/[0-9a-f]{64}\.json$/u, `${'1'.repeat(64)}.json`);
    const initialPrevious = initial.previous;
    if (initialPrevious === null) throw new Error('Development fixture must retain its existing predecessor.');
    expect(() =>
      admitAppCurrentAcceptancePointer({ ...initial, history: [recordKey, detachedTail] }, 'stark-dev/develop'),
    ).toThrow(/compare-and-swap/iu);
    expect(() =>
      admitAppCurrentAcceptancePointer(
        {
          ...initial,
          previous: { etag: 'other-etag', versionId: initialPrevious.versionId },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/compare-and-swap/iu);
  });
});

describe('App acceptance selection', () => {
  it('binds the selected record bytes and observation to one current or retained history key', () => {
    const current = createBoundSelectionFixture('current');
    const retained = createBoundSelectionFixture('retained');

    expect(current.selectionType).toBe('current');
    expect(retained.selectionType).toBe('retained');
    expect(Object.keys(current).sort()).toEqual(
      [
        'acceptance',
        'acceptanceKey',
        'acceptanceObservation',
        'pointer',
        'pointerObservation',
        'selectionType',
        'targetKey',
      ].sort(),
    );
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.acceptance)).toBe(true);
  });

  it('admits an older provider only for a retained selection', () => {
    const currentRecord = createAppAcceptanceFixture();
    const retainedRecord = withRetainedProvider(createAppAcceptanceFixture({ acceptedAt: '2026-08-14T01:04:06.000Z' }));
    const currentKey = deriveAppAcceptanceRecordKey(currentRecord, 'stark-dev/develop');
    const retainedKey = deriveAppAcceptanceRecordKey(retainedRecord, 'stark-dev/develop');
    const pointer = projectInitialAppAcceptancePointer(
      {
        history: [currentKey, retainedKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    const base = {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-version' },
      recordKey: retainedKey,
      record: retainedRecord,
      recordObservation: { etag: 'record-etag', versionId: 'record-version' },
    };

    expect(bindAppAcceptanceSelection(base, 'stark-dev/develop').selectionType).toBe('retained');

    const olderHead = projectInitialAppAcceptancePointer(
      {
        history: [retainedKey, currentKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    expect(() => bindAppAcceptanceSelection({ ...base, pointer: olderHead }, 'stark-dev/develop')).toThrow(
      /Terraform runtime/iu,
    );
  });

  it('rejects malformed keys, keys outside history, and keys detached from the admitted record body', () => {
    const record = createAppAcceptanceFixture();
    const recordKey = deriveAppAcceptanceRecordKey(record, 'stark-dev/develop');
    const otherKey = recordKey.replace(/[0-9a-f]{64}\.json$/u, `${'0'.repeat(64)}.json`);
    const pointer = projectInitialAppAcceptancePointer(
      {
        history: [recordKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    const base = {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-version' },
      recordKey,
      record,
      recordObservation: { etag: 'record-etag', versionId: 'record-version' },
    };

    expect(() =>
      bindAppAcceptanceSelection({ ...base, recordKey: `${recordKey}.detached` }, 'stark-dev/develop'),
    ).toThrow(/key/iu);
    expect(() => bindAppAcceptanceSelection({ ...base, recordKey: otherKey }, 'stark-dev/develop')).toThrow(
      /history/iu,
    );
    const pointerWithOther = projectInitialAppAcceptancePointer(
      {
        history: [otherKey],
        predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
      },
      'stark-dev/develop',
    );
    expect(() =>
      bindAppAcceptanceSelection({ ...base, pointer: pointerWithOther, recordKey: otherKey }, 'stark-dev/develop'),
    ).toThrow(/derived key/iu);
  });
});

it('binds production App acceptance, approval, verifier, and retained history to the expected target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const configured = await import('./index.js');
    const authority = await import('./app-acceptance-ledger.js');
    const publication = await import('./app-acceptance-publication.js');
    const projections = await import('./app-acceptance-projections.js');
    const execution = await import('./app-execution-authority.js');
    const production = configured.resolveAllowedDeploymentTarget('stark-prod/main');
    const development = configured.resolveAllowedDeploymentTarget('stark-dev/develop');
    const base = createAppAcceptanceFixture();
    const fixtures = await import('./testdata/app-acceptance-ledger-fixture.js');
    const body = mutableRecord(fixtures.createProductionAppAcceptanceFixture(), 'production acceptance');
    const admitted = authority.admitAppAcceptance(body, production.targetKey);
    expect(canonicalRecordJson(admitted)).toBe(canonicalRecordJson(body));
    const key = authority.deriveAppAcceptanceRecordKey(body, production.targetKey);
    const context = admitted.targetContext;
    expect(key).toBe(`${context.names.acceptedDeploymentPrefix}/acceptances/${canonicalSha256(body)}.json`);
    expect(authority.admitAppAcceptanceRecordKey(key, production.targetKey)).toBe(key);
    expect(() => authority.admitAppAcceptanceRecordKey(key, development.targetKey)).toThrow('namespace');
    expect(() => authority.admitAppAcceptance(body, undefined)).toThrow('expected target');
    expect(() => authority.admitAppAcceptance(body, development.targetKey)).toThrow('target');
    expect(() => authority.admitRetainedAppAcceptance(body, development.targetKey)).toThrow('target');
    expect(() => authority.deriveAppAcceptanceRecordKey(body, development.targetKey)).toThrow('target');
    for (const field of [
      'targetContext',
      'backend',
      'nonsecretInputs',
      'secretReferences',
      'provider',
      'smoke',
      'releaseAuthority',
      'deployables',
      'verifier',
    ]) {
      expect(
        () => authority.admitAppAcceptance({ ...body, [field]: base[field] }, production.targetKey),
        field,
      ).toThrow();
    }
    // Approval references use the same relative key; the owning bucket adapter binds the account.
    expect(admitted.approval).toEqual(base['approval']);
    expect(
      authority.admitAppAcceptance({ ...body, planDisposition: 'empty' }, production.targetKey).approval.approvalMode,
    ).toBe('manual-approval');
    expect(() =>
      authority.admitAppAcceptance(
        {
          ...body,
          planDisposition: 'empty',
          approval: { ...admitted.approval, approvalMode: 'empty-plan-skip', approvedAt: null },
        },
        production.targetKey,
      ),
    ).toThrow('approval');
    expect(() =>
      authority.admitAppAcceptanceVerifierAuthority(
        admitted.verifier,
        authority.admitAppAcceptanceReleaseAuthority(base['releaseAuthority'], development.targetKey),
        APP_SOURCE_SHA,
        production.targetKey,
      ),
    ).toThrow();
    const coordinates = { etag: '"fixture-etag"', versionId: 'fixture-version' };
    const pointer = authority.projectInitialAppAcceptancePointer(
      { history: [key], predecessor: coordinates },
      production.targetKey,
    );
    const selected = authority.bindAppAcceptanceSelection(
      {
        pointer,
        pointerObservation: coordinates,
        recordKey: key,
        record: admitted,
        recordObservation: coordinates,
      },
      production.targetKey,
    );
    expect(selected).toMatchObject({ selectionType: 'current', targetKey: production.targetKey, acceptanceKey: key });
    const nextBody = { ...body, acceptedAt: '2026-08-14T01:05:05.000Z' };
    const nextKey = authority.deriveAppAcceptanceRecordKey(nextBody, production.targetKey);
    const nextPointer = authority.projectAppAcceptancePointerTransition(
      {
        currentPointer: pointer,
        currentPointerObservation: coordinates,
        nextRecordKey: nextKey,
      },
      production.targetKey,
    );
    expect(nextPointer.history).toEqual([nextKey, key]);
    const retained = authority.bindAppAcceptanceSelection(
      {
        pointer: nextPointer,
        pointerObservation: coordinates,
        recordKey: key,
        record: admitted,
        recordObservation: coordinates,
      },
      production.targetKey,
    );
    const rollbackInput = { acceptanceSelection: retained, controlSourceSha: 'e'.repeat(40) };
    const rollbackExecution = execution.projectRollbackAppExecutionAuthority(rollbackInput, production.targetKey);
    expect(rollbackExecution).toMatchObject({
      targetKey: production.targetKey,
      deploymentMode: 'rollback',
      selectedAcceptanceKey: key,
      selectedApplicationSourceSha: admitted.selectedApplicationSourceSha,
      releaseAuthority: admitted.releaseAuthority,
      verifier: admitted.verifier,
    });
    expect(execution.admitAppExecutionAuthority(rollbackExecution, production.targetKey)).toEqual(rollbackExecution);
    expect(execution.deriveAppExecutionAuthoritySha256(rollbackExecution, production.targetKey)).toBe(
      createHash('sha256').update(canonicalJson(rollbackExecution)).digest('hex'),
    );
    for (const wrongTarget of [undefined, 'unreviewed/main', development.targetKey]) {
      expect(() => execution.projectRollbackAppExecutionAuthority(rollbackInput, wrongTarget)).toThrow();
      expect(() => execution.admitAppExecutionAuthority(rollbackExecution, wrongTarget)).toThrow();
      expect(() => execution.deriveAppExecutionAuthoritySha256(rollbackExecution, wrongTarget)).toThrow();
    }
    expect(() =>
      execution.projectRollbackAppExecutionAuthority(
        { ...rollbackInput, acceptanceSelection: selected },
        production.targetKey,
      ),
    ).toThrow('retained');

    expect(projections.projectAppTerraformDriftAuthority(selected, production.targetKey).targetKey).toBe(
      production.targetKey,
    );
    expect(projections.projectRetainedAppImageAuthority(retained, production.targetKey).targetKey).toBe(
      production.targetKey,
    );
    expect(projections.projectAppAcceptanceEvent(selected, production.targetKey).detail.env).toBe('main');
    expect(projections.projectAppCurrentRecoveryAuthority(selected, production.targetKey).targetKey).toBe(
      production.targetKey,
    );
    expect(projections.projectAppRollbackAuthority(retained, production.targetKey).targetKey).toBe(
      production.targetKey,
    );
    expect(() => projections.projectAppStaticFastAuthority(selected, production.targetKey)).toThrow('not authorized');
    for (const projectAuthority of [
      projections.projectAppTerraformDriftAuthority,
      projections.projectRetainedAppImageAuthority,
      projections.projectAppAcceptanceEvent,
      projections.projectAppCurrentRecoveryAuthority,
      projections.projectAppRollbackAuthority,
    ])
      expect(() => projectAuthority(selected, development.targetKey)).toThrow('target');
    const objects = new Map<string, { body: string; etag: string; versionId: string }>();
    const events: string[] = [];
    let sequence = 0;
    const transport = {
      getObject({ key: objectKey }: { key: string }) {
        events.push(`get:${objectKey}`);
        return objects.get(objectKey);
      },
      putObject(input: {
        key: string;
        body: string;
        condition: { type: 'if-none-match' } | { type: 'if-match'; etag: string; versionId: string };
      }) {
        events.push(`put:${input.key}:${input.condition.type}`);
        const current = objects.get(input.key);
        if (
          input.condition.type === 'if-none-match'
            ? current !== undefined
            : current?.etag !== input.condition.etag || current.versionId !== input.condition.versionId
        )
          return { status: 'precondition-failed' } as const;
        sequence += 1;
        const observation = { etag: `"etag-${sequence}"`, versionId: `version-${sequence}` };
        objects.set(input.key, { body: input.body, ...observation });
        return { status: 'written', ...observation } as const;
      },
    };
    const ledger = publication.createAppAcceptanceLedger(transport, production.targetKey);
    const devLedger = publication.createAppAcceptanceLedger(transport, development.targetKey);
    const pointerKey = context.names.acceptedDeploymentPointerKey;
    await expect(ledger.publishRecord(admitted.kind, admitted)).resolves.toMatchObject({ status: 'created', key });
    await expect(ledger.publishRecord(admitted.kind, admitted)).resolves.toMatchObject({
      status: 'idempotent-retry',
      key,
    });
    await expect(ledger.publishRecord(admitted.kind, nextBody)).resolves.toMatchObject({
      status: 'created',
      key: nextKey,
    });
    // The permanent ledger updates existing history; empty-account initialization is a separate path.
    objects.set(pointerKey, { body: canonicalRecordJson(pointer), ...coordinates });
    await expect(ledger.resolveCurrentHistory(pointerKey)).resolves.toMatchObject({
      pointer,
      records: [{ recordKey: key }],
    });
    events.length = 0;
    await expect(devLedger.readRecord(key)).rejects.toThrow('namespace');
    await expect(devLedger.resolveCurrentHistory(pointerKey)).rejects.toThrow('pointer key');
    await expect(ledger.publishRecord(admitted.kind, base)).rejects.toThrow('target');
    expect(() => publication.createAppAcceptanceLedger(transport, undefined)).toThrow('expected target');
    expect(events).toEqual([]);
    const movement = {
      kind: pointer.kind,
      pointerKey,
      currentPointer: pointer,
      pointer: nextPointer,
      expected: coordinates,
    };
    await expect(ledger.movePointer(movement)).resolves.toMatchObject({ status: 'moved', pointer: nextPointer });
    const written = objects.get(pointerKey);
    events.length = 0;
    await expect(ledger.movePointer(movement)).resolves.toMatchObject({ status: 'idempotent-retry' });
    expect(objects.get(pointerKey)).toEqual(written);
    expect(events.some((event) => event.startsWith('put:'))).toBe(false);
    const devPointer = authority.projectInitialAppAcceptancePointer(
      {
        history: [authority.deriveAppAcceptanceRecordKey(base, development.targetKey)],
        predecessor: coordinates,
      },
      development.targetKey,
    );
    objects.set(pointerKey, { body: canonicalRecordJson(devPointer), ...coordinates });
    await expect(ledger.resolveCurrentHistory(pointerKey)).rejects.toThrow('target');
    await expect(ledger.movePointer(movement)).rejects.toThrow('target');
    expect(
      authority.bindAppAcceptanceSelection(
        {
          pointer: nextPointer,
          pointerObservation: coordinates,
          recordKey: key,
          record: admitted,
          recordObservation: coordinates,
        },
        production.targetKey,
      ).selectionType,
    ).toBe('retained');
    expect(() => authority.admitAppCurrentAcceptancePointer(pointer, development.targetKey)).toThrow('target');
    expect(() =>
      authority.projectAppAcceptancePointerTransition(
        {
          currentPointer: pointer,
          currentPointerObservation: coordinates,
          nextRecordKey: authority.deriveAppAcceptanceRecordKey(base, development.targetKey),
        },
        production.targetKey,
      ),
    ).toThrow('namespace');
    expect(() =>
      authority.bindAppAcceptanceSelection(
        {
          pointer: nextPointer,
          pointerObservation: coordinates,
          recordKey: key,
          record: base,
          recordObservation: coordinates,
        },
        production.targetKey,
      ),
    ).toThrow('target');
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
