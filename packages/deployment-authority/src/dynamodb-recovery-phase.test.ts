import { describe, expect, it } from 'vitest';
import {
  DYNAMODB_RECOVERY_PHASES,
  deriveDynamoDbRecoveryId,
  evaluateDynamoDbRecoveryPhaseTransition,
  parseDynamoDbRecoveryPhase,
  validateDynamoDbRecoveryActivationManifestSourceShape,
  validateDynamoDbRecoverySelection,
  type DynamoDbRecoveryPhase,
  type DynamoDbRecoverySelection,
} from './dynamodb-recovery-phase.js';

const RECOVERY_IDENTITY = Object.freeze({
  planType: 'dynamodb-recovery',
  recoveryPoint: '2026-07-10T12:34:56.000Z',
  accountAlias: 'stark-dev',
  deploymentEnvironment: 'develop',
  accountId: '123456789012',
  region: 'ap-northeast-1',
  sessionsSourceTableArn:
    'arn:aws:dynamodb:ap-northeast-1:123456789012:table/stark-ballot-simulator-stark-dev-develop-sessions',
  votesSourceTableArn:
    'arn:aws:dynamodb:ap-northeast-1:123456789012:table/stark-ballot-simulator-stark-dev-develop-votes',
  sessionsReplacementTableName: 'stark-ballot-simulator-stark-dev-develop-sessions-recovery-20260710t123456z',
  votesReplacementTableName: 'stark-ballot-simulator-stark-dev-develop-votes-recovery-20260710t123456z',
});

function activationManifest(): Record<string, unknown> {
  const table = (kind: 'sessions' | 'votes') => ({
    sourceTableArn: `${RECOVERY_IDENTITY[kind === 'sessions' ? 'sessionsSourceTableArn' : 'votesSourceTableArn']}`,
    replacementTableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/` +
      RECOVERY_IDENTITY[kind === 'sessions' ? 'sessionsReplacementTableName' : 'votesReplacementTableName'],
    replacementTableName:
      RECOVERY_IDENTITY[kind === 'sessions' ? 'sessionsReplacementTableName' : 'votesReplacementTableName'],
    keySchema:
      kind === 'sessions'
        ? [{ attributeName: 'sessionId', attributeType: 'S' }]
        : [
            { attributeName: 'sessionId', attributeType: 'S' },
            { attributeName: 'voteIndex', attributeType: 'N' },
          ],
    globalSecondaryIndexes:
      kind === 'sessions'
        ? []
        : [
            {
              indexName: 'voteId-index',
              partitionKey: 'voteId',
              attributeType: 'S',
              projectionType: 'KEYS_ONLY',
            },
          ],
    operationalControls: {
      billingMode: 'PAY_PER_REQUEST',
      deletionProtectionEnabled: true,
      pointInTimeRecoveryEnabled: true,
      ttlAttribute: 'expiresAt',
      requiredTags: {
        Project: 'stark-ballot-simulator',
        AccountAlias: 'stark-dev',
        Environment: 'develop',
        DataClass: kind === 'sessions' ? 'session-authority' : 'session-owned-votes',
      },
    },
  });
  return {
    manifestType: 'dynamodb-recovery-activation',
    validationStatus: 'validated',
    recoveryId: deriveDynamoDbRecoveryId(RECOVERY_IDENTITY),
    recoveryPoint: RECOVERY_IDENTITY.recoveryPoint,
    accountAlias: RECOVERY_IDENTITY.accountAlias,
    deploymentEnvironment: RECOVERY_IDENTITY.deploymentEnvironment,
    accountId: RECOVERY_IDENTITY.accountId,
    region: RECOVERY_IDENTITY.region,
    kmsKeyArn: 'arn:aws:kms:ap-northeast-1:123456789012:key/11111111-2222-3333-4444-555555555555',
    tables: { sessions: table('sessions'), votes: table('votes') },
  };
}

const MANIFEST = Object.freeze({
  key: `recovery-manifests/stark-dev/develop/${'a'.repeat(64)}.json`,
  versionId: 'manifest-version',
  sha256: 'b'.repeat(64),
});

function selection(phase: DynamoDbRecoveryPhase): DynamoDbRecoverySelection {
  return {
    phase,
    manifest: phase === 'primary_active' ? null : MANIFEST,
  };
}

describe('DynamoDB recovery phase authority', () => {
  it('retains the existing recovery identity digest outside the retired readiness surface', () => {
    expect(deriveDynamoDbRecoveryId(RECOVERY_IDENTITY)).toBe(
      'ab540221e9e733d13b43a70dc67ed895c3fbd8a7da75853d3237efc53e87f37a',
    );
  });

  it('retains exact activation-manifest source admission for the real recovery workflow', () => {
    const manifest = activationManifest();

    expect(validateDynamoDbRecoveryActivationManifestSourceShape(manifest)).toBe(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest['tables'])).toBe(true);
  });

  it('rejects proxied, accessor-backed, and sparse activation-manifest data', () => {
    const proxiedManifest = activationManifest();
    let proxyTrapCalls = 0;
    const proxy = new Proxy(proxiedManifest, {
      get() {
        proxyTrapCalls += 1;
        throw new Error('manifest proxy get trap');
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error('manifest proxy descriptor trap');
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error('manifest proxy prototype trap');
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error('manifest proxy ownKeys trap');
      },
    });
    expect(() => validateDynamoDbRecoveryActivationManifestSourceShape(proxy)).toThrow(/exact current shape/iu);
    expect(proxyTrapCalls).toBe(0);

    const accessorManifest = activationManifest();
    Object.defineProperty(accessorManifest, 'region', {
      enumerable: true,
      get() {
        throw new Error('manifest region accessor');
      },
    });
    expect(() => validateDynamoDbRecoveryActivationManifestSourceShape(accessorManifest)).toThrow(
      /exact current shape/iu,
    );

    const sparseManifest = activationManifest();
    const sessions = (sparseManifest['tables'] as Record<string, Record<string, unknown>>)['sessions'];
    if (sessions === undefined) throw new Error('sessions fixture is missing');
    const keySchema = sessions['keySchema'] as unknown[];
    keySchema.length = 2;
    expect(() => validateDynamoDbRecoveryActivationManifestSourceShape(sparseManifest)).toThrow(
      /dense data-property array/iu,
    );
  });

  it('owns the exact ordered phase set', () => {
    expect(DYNAMODB_RECOVERY_PHASES).toEqual([
      'primary_active',
      'primary_quiesced',
      'replacement_quiesced',
      'replacement_active',
    ]);
    expect(parseDynamoDbRecoveryPhase('replacement_quiesced')).toBe('replacement_quiesced');
    expect(() => parseDynamoDbRecoveryPhase('replacement_ready')).toThrow('DynamoDB recovery phase is invalid.');
  });

  it('admits only primary_active as the initial accepted phase', () => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: null,
      requested: selection('primary_active'),
    });

    expect(result).toEqual({
      current: null,
      requested: selection('primary_active'),
      disposition: 'initial',
      allowedNextPhases: ['primary_active'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: null,
        requested: selection('primary_quiesced'),
      }),
    ).toThrow('Initial DynamoDB recovery authority must use primary_active.');
  });

  it.each(DYNAMODB_RECOVERY_PHASES)('admits an exact same-phase %s retry', (phase) => {
    const current = selection(phase);

    expect(evaluateDynamoDbRecoveryPhaseTransition({ current, requested: selection(phase) })).toMatchObject({
      disposition: 'idempotent',
      current,
      requested: current,
    });
  });

  it.each([
    ['primary_active', 'primary_quiesced'],
    ['primary_quiesced', 'replacement_quiesced'],
    ['replacement_quiesced', 'replacement_active'],
  ] as const)('admits the adjacent forward transition %s -> %s', (currentPhase, requestedPhase) => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: selection(currentPhase),
      requested: selection(requestedPhase),
    });

    expect(result.disposition).toBe('forward');
    expect(result.allowedNextPhases).toContain(requestedPhase);
  });

  it.each([
    ['replacement_active', 'replacement_quiesced'],
    ['replacement_quiesced', 'primary_quiesced'],
    ['primary_quiesced', 'primary_active'],
  ] as const)('admits the adjacent reverse transition %s -> %s', (currentPhase, requestedPhase) => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: selection(currentPhase),
      requested: selection(requestedPhase),
    });

    expect(result.disposition).toBe('reverse');
    expect(result.allowedNextPhases).toContain(requestedPhase);
  });

  it.each([
    ['primary_active', 'replacement_quiesced'],
    ['primary_active', 'replacement_active'],
    ['primary_quiesced', 'replacement_active'],
    ['replacement_active', 'primary_quiesced'],
    ['replacement_active', 'primary_active'],
    ['replacement_quiesced', 'primary_active'],
  ] as const)('rejects the skipped transition %s -> %s', (currentPhase, requestedPhase) => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection(currentPhase),
        requested: selection(requestedPhase),
      }),
    ).toThrow('DynamoDB recovery phases may change by only one adjacent phase.');
  });

  it('introduces the manifest only when leaving primary_active and removes it only when returning', () => {
    expect(
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_active'),
        requested: selection('primary_quiesced'),
      }).disposition,
    ).toBe('forward');
    expect(
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_quiesced'),
        requested: selection('primary_active'),
      }).disposition,
    ).toBe('reverse');

    expect(() => validateDynamoDbRecoverySelection({ phase: 'primary_active', manifest: MANIFEST })).toThrow(
      'primary_active must not select a DynamoDB recovery manifest.',
    );
    expect(() => validateDynamoDbRecoverySelection({ phase: 'primary_quiesced', manifest: null })).toThrow(
      'DynamoDB recovery transition phases require an exact recovery manifest.',
    );
  });

  it.each([
    ['primary_quiesced', 'primary_quiesced'],
    ['primary_quiesced', 'replacement_quiesced'],
    ['replacement_quiesced', 'replacement_active'],
  ] as const)('rejects manifest substitution across %s -> %s', (currentPhase, requestedPhase) => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection(currentPhase),
        requested: {
          phase: requestedPhase,
          manifest: { ...MANIFEST, versionId: 'different-version' },
        },
      }),
    ).toThrow('DynamoDB recovery manifest must remain exact across selected recovery phases.');
  });

  it('rejects unknown semantic fields', () => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_active'),
        requested: selection('primary_quiesced'),
        unexpectedField: true,
      }),
    ).toThrow('DynamoDB recovery phase transition must use the exact current shape.');
    expect(() =>
      validateDynamoDbRecoverySelection({
        ...selection('primary_active'),
        legacyPhase: 'active',
      }),
    ).toThrow('DynamoDB recovery selection must use the exact current shape.');
  });
});
