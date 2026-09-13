import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  type AllowedDeploymentTarget,
} from './index.js';
import {
  admitDynamoDbRecoveryActivationManifest,
  bindDynamoDbRecoveryActivationEvidence,
} from './dynamodb-recovery-activation.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const app = resolveDeploymentLaneAuthority(target, 'app');
const recoveryPoint = '2026-07-10T12:34:56.000Z';

function fixture(authorities: { target: AllowedDeploymentTarget; app: typeof app } = { target, app }) {
  const { target, app } = authorities;
  const primaryNames = {
    sessions: `${target.resourcePrefix}-sessions`,
    votes: `${target.resourcePrefix}-votes`,
  };
  const replacementNames = {
    sessions: `${primaryNames.sessions}-recovery-20260710t123456z`,
    votes: `${primaryNames.votes}-recovery-20260710t123456z`,
  };
  const tableArn = (name: string) =>
    `arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/${name}`;
  const sourceArns = {
    sessions: tableArn(primaryNames.sessions),
    votes: tableArn(primaryNames.votes),
  };
  const identity = {
    planType: 'dynamodb-recovery',
    recoveryPoint,
    accountAlias: target.accountLabel,
    deploymentEnvironment: target.environmentId,
    accountId: target.accountId,
    region: target.region,
    sessionsSourceTableArn: sourceArns.sessions,
    votesSourceTableArn: sourceArns.votes,
    sessionsReplacementTableName: replacementNames.sessions,
    votesReplacementTableName: replacementNames.votes,
  };
  const recoveryId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const requiredTags = (kind: 'sessions' | 'votes') => ({
    Project: 'stark-ballot-simulator',
    AccountAlias: target.accountLabel,
    Environment: target.environmentId,
    DataClass: kind === 'sessions' ? 'session-authority' : 'session-owned-votes',
  });
  const operationalControls = (kind: 'sessions' | 'votes') => ({
    billingMode: 'PAY_PER_REQUEST',
    deletionProtectionEnabled: true,
    pointInTimeRecoveryEnabled: true,
    ttlAttribute: 'expiresAt',
    requiredTags: requiredTags(kind),
  });
  const manifest = {
    accountAlias: target.accountLabel,
    accountId: target.accountId,
    deploymentEnvironment: target.environmentId,
    kmsKeyArn:
      `arn:${target.partition}:kms:${target.region}:${target.accountId}:key/` + '11111111-2222-3333-4444-555555555555',
    manifestType: 'dynamodb-recovery-activation',
    recoveryId,
    recoveryPoint,
    region: target.region,
    tables: {
      sessions: {
        globalSecondaryIndexes: [],
        keySchema: [{ attributeName: 'sessionId', attributeType: 'S' }],
        operationalControls: operationalControls('sessions'),
        replacementTableArn: tableArn(replacementNames.sessions),
        replacementTableName: replacementNames.sessions,
        sourceTableArn: sourceArns.sessions,
      },
      votes: {
        globalSecondaryIndexes: [
          {
            attributeType: 'S',
            indexName: 'voteId-index',
            partitionKey: 'voteId',
            projectionType: 'KEYS_ONLY',
          },
        ],
        keySchema: [
          { attributeName: 'sessionId', attributeType: 'S' },
          { attributeName: 'voteIndex', attributeType: 'N' },
        ],
        operationalControls: operationalControls('votes'),
        replacementTableArn: tableArn(replacementNames.votes),
        replacementTableName: replacementNames.votes,
        sourceTableArn: sourceArns.votes,
      },
    },
    validationStatus: 'validated',
  };
  const body = canonicalRecordJson(manifest);
  const reference = {
    key: `${app.names.recoveryManifestPrefix}/${recoveryId}.json`,
    versionId: 'manifest-version',
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const selection = { phase: 'replacement_quiesced', manifest: reference } as const;
  const activation = {
    manifest_type: 'dynamodb-recovery-activation',
    validation_status: 'validated',
    recovery_id: recoveryId,
    recovery_point: recoveryPoint,
    manifest_sha256: reference.sha256,
    account_alias: target.accountLabel,
    deployment_environment: target.environmentId,
    account_id: target.accountId,
    region: target.region,
    kms_key_arn: manifest.kmsKeyArn,
    sessions: {
      source_table_arn: sourceArns.sessions,
      table_arn: manifest.tables.sessions.replacementTableArn,
      table_name: replacementNames.sessions,
      key_schema: 'sessionId:S:HASH',
    },
    votes: {
      source_table_arn: sourceArns.votes,
      table_arn: manifest.tables.votes.replacementTableArn,
      table_name: replacementNames.votes,
      key_schema: 'sessionId:S:HASH,voteIndex:N:RANGE',
      vote_id_index_schema: 'voteId-index:voteId:S:HASH:KEYS_ONLY',
    },
  };
  const smokeManifest = {
    key: reference.key,
    recoveryId,
    recoveryPoint,
    replacement: {
      sessionsTableArn: manifest.tables.sessions.replacementTableArn,
      votesTableArn: manifest.tables.votes.replacementTableArn,
    },
    sha256: reference.sha256,
    versionId: reference.versionId,
  };
  return { activation, body, manifest, reference, selection, smokeManifest };
}

describe('DynamoDB recovery activation manifest admission', () => {
  it('exact-admits and deeply freezes one governed selected manifest', () => {
    const value = fixture();

    const admitted = admitDynamoDbRecoveryActivationManifest(value.manifest, value.selection, target.targetKey);

    expect(canonicalRecordJson(admitted)).toBe(value.body);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted['tables'])).toBe(true);
  });

  it('rejects a detached selected reference, target table, and noncanonical recovery point', () => {
    const detachedReference = fixture();
    expect(() =>
      admitDynamoDbRecoveryActivationManifest(
        detachedReference.manifest,
        {
          ...detachedReference.selection,
          manifest: { ...detachedReference.reference, sha256: '0'.repeat(64) },
        },
        target.targetKey,
      ),
    ).toThrow(/body SHA-256.*detached/iu);

    const detachedTable = fixture();
    detachedTable.manifest.tables.sessions.sourceTableArn = detachedTable.manifest.tables.votes.sourceTableArn;
    expect(() =>
      admitDynamoDbRecoveryActivationManifest(detachedTable.manifest, detachedTable.selection, target.targetKey),
    ).toThrow(/target, source, or replacement/iu);

    const detachedTime = fixture();
    detachedTime.manifest.recoveryPoint = '2026-07-10T12:34:56Z';
    expect(() =>
      admitDynamoDbRecoveryActivationManifest(detachedTime.manifest, detachedTime.selection, target.targetKey),
    ).toThrow(/activation point.*invalid|canonical UTC/iu);
  });

  it('captures proxied input without invoking getters and rejects extra fields', () => {
    const value = fixture();
    let reads = 0;
    const proxy = new Proxy(value.manifest, {
      get(targetValue, property, receiver) {
        reads += 1;
        return Reflect.get(targetValue, property, receiver) as unknown;
      },
    });

    expect(admitDynamoDbRecoveryActivationManifest(proxy, value.selection, target.targetKey)).toEqual(value.manifest);
    expect(reads).toBe(0);
    expect(() =>
      admitDynamoDbRecoveryActivationManifest({ ...value.manifest, latest: true }, value.selection, target.targetKey),
    ).toThrow(/exact.*shape/iu);
  });

  it('cross-binds the complete Terraform activation and smoke manifest authority', () => {
    const value = fixture();
    let selectedReads = 0;
    const swappingSelection = new Proxy(value.selection, {
      get(targetValue, property, receiver) {
        selectedReads += 1;
        if (property === 'phase' && selectedReads > 1) return 'primary_active';
        return Reflect.get(targetValue, property, receiver) as unknown;
      },
    });

    const bound = bindDynamoDbRecoveryActivationEvidence(
      value.manifest,
      swappingSelection,
      {
        smokeManifest: value.smokeManifest,
        terraformActivation: value.activation,
      },
      target.targetKey,
    );

    expect(bound.activation).toEqual(value.activation);
    expect(bound.manifest).toEqual(value.manifest);
    expect(Object.isFrozen(bound.activation)).toBe(true);
    expect(selectedReads).toBe(0);

    expect(() =>
      bindDynamoDbRecoveryActivationEvidence(
        value.manifest,
        value.selection,
        {
          smokeManifest: value.smokeManifest,
          terraformActivation: { ...value.activation, kms_key_arn: value.activation.sessions.table_arn },
        },
        target.targetKey,
      ),
    ).toThrow(/Terraform activation.*detached/iu);

    expect(() =>
      bindDynamoDbRecoveryActivationEvidence(
        value.manifest,
        value.selection,
        {
          smokeManifest: {
            ...value.smokeManifest,
            replacement: {
              ...value.smokeManifest.replacement,
              sessionsTableArn: value.smokeManifest.replacement.votesTableArn,
            },
          },
          terraformActivation: value.activation,
        },
        target.targetKey,
      ),
    ).toThrow(/smoke manifest.*detached/iu);
  });
});

it('binds production recovery tables, KMS, controls, and exact manifest evidence to the selected target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const authority = await import('./dynamodb-recovery-activation.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const value = fixture({ target: production, app: targets.resolveDeploymentLaneAuthority(production, 'app') });
    const evidence = { terraformActivation: value.activation, smokeManifest: value.smokeManifest };
    for (const phase of ['primary_quiesced', 'replacement_quiesced', 'replacement_active']) {
      const selection = { ...value.selection, phase };
      expect(
        authority.admitDynamoDbRecoveryActivationManifest(value.manifest, selection, production.targetKey),
      ).toEqual(value.manifest);
      expect(
        authority.bindDynamoDbRecoveryActivationEvidence(value.manifest, selection, evidence, production.targetKey)
          .activation,
      ).toEqual(value.activation);
    }
    for (const wrongTarget of [undefined, 'unreviewed/main', target.targetKey]) {
      expect(() =>
        authority.admitDynamoDbRecoveryActivationManifest(value.manifest, value.selection, wrongTarget),
      ).toThrow();
      expect(() =>
        authority.bindDynamoDbRecoveryActivationEvidence(value.manifest, value.selection, evidence, wrongTarget),
      ).toThrow();
    }
    const development = fixture();
    for (const field of ['accountId', 'accountAlias', 'deploymentEnvironment', 'kmsKeyArn', 'tables'] as const) {
      expect(() =>
        authority.admitDynamoDbRecoveryActivationManifest(
          { ...value.manifest, [field]: development.manifest[field] },
          value.selection,
          production.targetKey,
        ),
      ).toThrow();
    }
    expect(() =>
      authority.admitDynamoDbRecoveryActivationManifest(value.manifest, development.selection, production.targetKey),
    ).toThrow();
    expect(() =>
      authority.bindDynamoDbRecoveryActivationEvidence(
        value.manifest,
        value.selection,
        { ...evidence, terraformActivation: development.activation },
        production.targetKey,
      ),
    ).toThrow();
    expect(() =>
      authority.bindDynamoDbRecoveryActivationEvidence(
        value.manifest,
        value.selection,
        { ...evidence, smokeManifest: development.smokeManifest },
        production.targetKey,
      ),
    ).toThrow();
    expect(() =>
      authority.admitDynamoDbRecoveryActivationManifest(
        value.manifest,
        { phase: 'primary_active', manifest: null },
        production.targetKey,
      ),
    ).toThrow();
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
