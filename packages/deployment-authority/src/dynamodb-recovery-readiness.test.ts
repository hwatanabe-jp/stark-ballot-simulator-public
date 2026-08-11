import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJsonSha256,
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
} from '@stark-ballot/deployment-authority';
import { CURRENT_AUTHORITY_ENTRY_KEYS, RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES } from './app-acceptance.js';
import {
  deriveDynamoDbRecoveryId,
  evaluateDynamoDbRecoveryReadiness,
  validateDynamoDbRecoveryReadinessEvidence,
  type DynamoDbRecoveryReadinessInput,
} from './dynamodb-recovery-readiness.js';

const CONTROL_SOURCE_SHA = 'c'.repeat(40);
const PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
const ACCEPTANCE_ATTEMPT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLAN_CHECKSUM = '4'.repeat(64);
const RECOVERY_POINT = '2026-07-10T12:34:56.000Z';
const EARLIEST_RESTORABLE_AT = '2026-07-01T00:00:00.000Z';
const LATEST_RESTORABLE_AT = '2026-07-20T00:00:00.000Z';

type Mutable<T> = T extends readonly (infer Entry)[]
  ? Mutable<Entry>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function immutableReference(key: string, character: string) {
  return {
    key,
    versionId: `version-${character}`,
    sha256: character.repeat(64),
  };
}

function tableArn(region: string, accountId: string, tableName: string): string {
  return `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;
}

function currentAuthorityObservation(options: {
  readonly targetContext: ReturnType<typeof renderDeploymentLaneContext>;
  readonly recoveryManifest: ReturnType<typeof immutableReference>;
  readonly sourceSha: string;
}) {
  const acceptedDeploymentReference = immutableReference(
    `${options.targetContext.names.acceptedDeploymentPrefix}/executions/${PIPELINE_EXECUTION_ID}/attempts/` +
      `${ACCEPTANCE_ATTEMPT_ID}/authoritative-app-deployment.json`,
    '1',
  );
  const attemptPrefix =
    `${options.targetContext.names.acceptedDeploymentPrefix}/executions/${PIPELINE_EXECUTION_ID}/attempts/` +
    ACCEPTANCE_ATTEMPT_ID;
  const deploymentIdentityAuthoritySha256 = 'd'.repeat(64);
  const entry = Object.assign(
    Object.fromEntries(CURRENT_AUTHORITY_ENTRY_KEYS.map((key) => [key, null])),
    Object.fromEntries(
      Object.entries(RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES).map(([field, basename]) => [
        field,
        `${attemptPrefix}/${basename}`,
      ]),
    ),
    {
      acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
      accountId: options.targetContext.target.accountId,
      applyOutputsSha256: '3'.repeat(64),
      approvalEvidencePath: `${options.targetContext.names.approvalEvidencePrefix}/${PIPELINE_EXECUTION_ID}.json`,
      approvalEvidenceSha256: '4'.repeat(64),
      approvalEvidenceVersionId: 'approval-version',
      approvalReason: 'manual-approval',
      controlSourceSha: CONTROL_SOURCE_SHA,
      deploymentEnvironment: options.targetContext.target.environmentId,
      deploymentId: `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`,
      deploymentIdentityAuthoritySha256,
      deploymentMode: 'normal',
      dynamodbRecoveryManifest: options.recoveryManifest,
      dynamodbRecoveryPhase: 'primary_quiesced',
      importingResourceChangeCount: 0,
      manifestPath: acceptedDeploymentReference.key,
      manifestSha256: acceptedDeploymentReference.sha256,
      manifestVersionId: acceptedDeploymentReference.versionId,
      manualApprovalSkipped: false,
      movedResourceChangeCount: 0,
      outputChangeCount: 0,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      planChecksum: PLAN_CHECKSUM,
      planEmpty: false,
      resourceChangeCount: 1,
      rollbackSelection: null,
      selectedSourceSha: options.sourceSha,
      sourceSha: options.sourceSha,
    },
  );
  const body = {
    acceptedDeployments: [entry],
    authorityType: 'app-accepted-deployment-authority',
    maxRetainedAcceptedDeployments: 10,
    retentionDays: 180,
    stateIdentity: options.targetContext.root.stateIdentity,
  };
  const bodySha256 = createHash('sha256').update(canonicalRecordJson(body)).digest('hex');
  const pointer = {
    key: options.targetContext.names.acceptedDeploymentPointerKey,
    versionId: 'current-version',
    sha256: bodySha256,
  };
  return { body, pointerBefore: pointer, pointerAfter: { ...pointer } };
}

function recoveryId(input: {
  accountAlias: string;
  deploymentEnvironment: string;
  accountId: string;
  region: string;
  sessionsSourceTableArn: string;
  votesSourceTableArn: string;
  sessionsReplacementTableName: string;
  votesReplacementTableName: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        planType: 'dynamodb-recovery',
        recoveryPoint: RECOVERY_POINT,
        ...input,
      }),
    )
    .digest('hex');
}

function inputFixture(): DynamoDbRecoveryReadinessInput {
  const target = resolveAllowedDeploymentTarget('stark-dev/develop');
  const targetContext = renderDeploymentLaneContext({
    target,
    lane: 'app',
    accountId: target.accountId,
    requestedControlSourceSha: CONTROL_SOURCE_SHA,
    selectedApplicationSourceSha: CONTROL_SOURCE_SHA,
    frameworkSourceSha: CONTROL_SOURCE_SHA,
  });
  const primaryNames = {
    sessions: `${target.resourcePrefix}-sessions`,
    votes: `${target.resourcePrefix}-votes`,
  };
  const replacementNames = {
    sessions: `${primaryNames.sessions}-recovery-20260710t123456z`,
    votes: `${primaryNames.votes}-recovery-20260710t123456z`,
  };
  const primaryArns = {
    sessions: tableArn(target.region, target.accountId, primaryNames.sessions),
    votes: tableArn(target.region, target.accountId, primaryNames.votes),
  };
  const replacementArns = {
    sessions: tableArn(target.region, target.accountId, replacementNames.sessions),
    votes: tableArn(target.region, target.accountId, replacementNames.votes),
  };
  const kmsKeyArn = `arn:aws:kms:${target.region}:${target.accountId}:key/11111111-2222-3333-4444-555555555555`;
  const selectedRecoveryId = recoveryId({
    accountAlias: target.accountLabel,
    deploymentEnvironment: target.environmentId,
    accountId: target.accountId,
    region: target.region,
    sessionsSourceTableArn: primaryArns.sessions,
    votesSourceTableArn: primaryArns.votes,
    sessionsReplacementTableName: replacementNames.sessions,
    votesReplacementTableName: replacementNames.votes,
  });
  const manifestReference = immutableReference(
    `recovery-manifests/${target.accountLabel}/${target.environmentId}/${selectedRecoveryId}.json`,
    '5',
  );
  const keySchemas = {
    sessions: [{ attributeName: 'sessionId', attributeType: 'S' as const }],
    votes: [
      { attributeName: 'sessionId', attributeType: 'S' as const },
      { attributeName: 'voteIndex', attributeType: 'N' as const },
    ],
  };
  const indexes = {
    sessions: [],
    votes: [
      {
        indexName: 'voteId-index' as const,
        partitionKey: 'voteId' as const,
        attributeType: 'S' as const,
        projectionType: 'KEYS_ONLY' as const,
      },
    ],
  };
  const requiredTags = (kind: 'sessions' | 'votes') => ({
    Project: 'stark-ballot-simulator',
    AccountAlias: target.accountLabel,
    Environment: target.environmentId,
    DataClass: kind === 'sessions' ? ('session-authority' as const) : ('session-owned-votes' as const),
  });
  const manifestTable = (kind: 'sessions' | 'votes') => ({
    sourceTableArn: primaryArns[kind],
    replacementTableArn: replacementArns[kind],
    replacementTableName: replacementNames[kind],
    keySchema: keySchemas[kind],
    globalSecondaryIndexes: indexes[kind],
    operationalControls: {
      billingMode: 'PAY_PER_REQUEST' as const,
      deletionProtectionEnabled: true as const,
      pointInTimeRecoveryEnabled: true as const,
      ttlAttribute: 'expiresAt' as const,
      requiredTags: requiredTags(kind),
    },
  });
  const observedKeySchema = {
    sessions: [{ attributeName: 'sessionId', attributeType: 'S' as const, keyType: 'HASH' as const }],
    votes: [
      { attributeName: 'sessionId', attributeType: 'S' as const, keyType: 'HASH' as const },
      { attributeName: 'voteIndex', attributeType: 'N' as const, keyType: 'RANGE' as const },
    ],
  };
  const tableObservation = (role: 'primary' | 'replacement', kind: 'sessions' | 'votes') => ({
    availability: 'available' as const,
    describeTable: {
      tableArn: role === 'primary' ? primaryArns[kind] : replacementArns[kind],
      tableName: role === 'primary' ? primaryNames[kind] : replacementNames[kind],
      tableStatus: 'ACTIVE' as const,
      keySchema: observedKeySchema[kind],
      globalSecondaryIndexes: indexes[kind],
      localSecondaryIndexCount: 0,
      billingMode: 'PAY_PER_REQUEST' as const,
      deletionProtectionEnabled: true,
      sseStatus: 'ENABLED' as const,
      kmsKeyArn,
      streamEnabled: false,
      streamViewType: null,
      restoreSummary:
        role === 'primary'
          ? null
          : {
              sourceTableArn: primaryArns[kind],
              recoveryPoint: RECOVERY_POINT,
              restoreInProgress: false,
            },
    },
    continuousBackups: {
      status: 'ENABLED' as const,
      earliestRestorableAt: EARLIEST_RESTORABLE_AT,
      latestRestorableAt: LATEST_RESTORABLE_AT,
    },
    timeToLive: { status: 'ENABLED' as const, attributeName: 'expiresAt' as const },
    tags: requiredTags(kind),
  });
  const currentAuthority = currentAuthorityObservation({
    targetContext,
    recoveryManifest: manifestReference,
    sourceSha: CONTROL_SOURCE_SHA,
  });
  const currentAuthorityPointer = currentAuthority.pointerBefore;
  const acceptedBaselineReference = immutableReference(
    `${targetContext.names.terraformBaselinePrefix}/${targetContext.root.stateIdentity}/executions/` +
      `${PIPELINE_EXECUTION_ID}/attempts/${ACCEPTANCE_ATTEMPT_ID}/baseline.json`,
    '3',
  );
  const prerequisiteChecks = {
    quiescing: {
      admissionClosed: true,
      proverEventSourceMappingDisabled: true,
      verificationEventSourceMappingDisabled: true,
    },
    drain: {
      finalizationsDrained: true,
      proverQueueDrained: true,
      verificationQueueDrained: true,
      inFlightExecutionsDrained: true,
    },
    wrongCapability: { stateReadDenied: true, mutationDenied: true },
    dataValidation: {
      requiredBeforeActivation: true,
      schemaCheckRequired: true,
      countCheckRequired: true,
      checksumCheckRequired: true,
    },
    smoke: { currentAcceptedPhasePassed: true, requestedPhaseRequired: true },
  };
  const prerequisiteReference = immutableReference(
    `${targetContext.names.approvalEvidencePrefix}/recovery-readiness/prerequisites.json`,
    '6',
  );
  const roleArn = `arn:aws:iam::${target.accountId}:role/${targetContext.names.recoveryReadinessRole}`;
  const reviewedIam = {
    roleArn,
    trustPolicySha256: '7'.repeat(64),
    permissionsBoundary: {
      policyArn: `arn:aws:iam::${target.accountId}:policy/recovery-readiness-boundary`,
      documentSha256: '8'.repeat(64),
    },
    attachedPolicies: [
      {
        policyArn: `arn:aws:iam::${target.accountId}:policy/recovery-readiness-core`,
        documentSha256: '9'.repeat(64),
      },
      {
        policyArn: `arn:aws:iam::${target.accountId}:policy/recovery-readiness-sensitive`,
        documentSha256: 'a'.repeat(64),
      },
    ],
    inlinePolicies: [{ policyName: 'recovery-readiness-provider-read', documentSha256: 'b'.repeat(64) }],
  };

  return {
    targetContext,
    currentAuthority,
    acceptedBaseline: {
      recordType: 'accepted-terraform-baseline',
      reference: acceptedBaselineReference,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
      acceptedPlanChecksum: PLAN_CHECKSUM,
      sourceSha: CONTROL_SOURCE_SHA,
      controlSourceSha: CONTROL_SOURCE_SHA,
      stateIdentity: targetContext.root.stateIdentity,
      backendKey: targetContext.root.backendKey,
      dynamodbRecoveryPhase: 'primary_quiesced',
      dynamodbRecoveryManifest: manifestReference,
    },
    reviewedControlSourceSha: CONTROL_SOURCE_SHA,
    currentControlSourceSha: CONTROL_SOURCE_SHA,
    requestedRecovery: {
      phase: 'replacement_quiesced',
      manifest: manifestReference,
    },
    manifest: {
      reference: manifestReference,
      bodySha256: manifestReference.sha256,
      manifestType: 'dynamodb-recovery-activation',
      validationStatus: 'validated',
      recoveryId: selectedRecoveryId,
      recoveryPoint: RECOVERY_POINT,
      accountAlias: target.accountLabel,
      deploymentEnvironment: target.environmentId,
      accountId: target.accountId,
      region: target.region,
      kmsKeyArn,
      tables: {
        sessions: manifestTable('sessions'),
        votes: manifestTable('votes'),
      },
    },
    tables: {
      primary: {
        sessions: tableObservation('primary', 'sessions'),
        votes: tableObservation('primary', 'votes'),
      },
      replacement: {
        sessions: tableObservation('replacement', 'sessions'),
        votes: tableObservation('replacement', 'votes'),
      },
    },
    prerequisites: {
      owner: { accountMatched: true, regionMatched: true },
      retainedEvidence: {
        reference: prerequisiteReference,
        bodySha256: prerequisiteReference.sha256,
        evidenceType: 'dynamodb-recovery-prerequisites',
        acceptedBaseline: acceptedBaselineReference,
        checks: prerequisiteChecks,
        controlSourceSha: CONTROL_SOURCE_SHA,
        currentAcceptedAuthority: {
          pointer: currentAuthorityPointer,
          phase: 'primary_quiesced',
          manifest: manifestReference,
        },
        observedAt: '2026-08-02T01:01:02.000Z',
        requestedRecovery: {
          phase: 'replacement_quiesced',
          manifest: manifestReference,
        },
        targetContextSha256: canonicalJsonSha256(targetContext),
      },
    },
    iam: {
      reviewed: reviewedIam,
      observed: {
        ...reviewedIam,
        permissionsBoundary: { ...reviewedIam.permissionsBoundary, defaultVersionId: 'v1' },
        attachedPolicies: reviewedIam.attachedPolicies.map((policy) => ({ ...policy, defaultVersionId: 'v1' })),
      },
    },
    cleanup: { requested: false, authorization: null },
    planSummary: null,
    startedAt: '2026-08-02T01:02:03.000Z',
    finishedAt: '2026-08-02T01:03:04.000Z',
  };
}

function cloneFixture(): Mutable<DynamoDbRecoveryReadinessInput> {
  return structuredClone(inputFixture()) as Mutable<DynamoDbRecoveryReadinessInput>;
}

type MutableTableObservation = Mutable<DynamoDbRecoveryReadinessInput['tables']['primary']['sessions']>;

function requireDescription(observation: MutableTableObservation) {
  if (observation.describeTable === null) {
    throw new Error('Test fixture must contain a DescribeTable observation.');
  }
  return observation.describeTable;
}

function requireTags(observation: MutableTableObservation) {
  if (observation.tags === null) {
    throw new Error('Test fixture must contain a ListTagsOfResource observation.');
  }
  return observation.tags;
}

function requireRetainedPrerequisites(input: Mutable<DynamoDbRecoveryReadinessInput>) {
  if (input.prerequisites.retainedEvidence === null) {
    throw new Error('Test fixture must contain retained prerequisite evidence.');
  }
  return input.prerequisites.retainedEvidence;
}

function requireObservedIam(input: Mutable<DynamoDbRecoveryReadinessInput>) {
  if (input.iam.observed === null) {
    throw new Error('Test fixture must contain observed IAM evidence.');
  }
  return input.iam.observed;
}

describe('DynamoDB recovery readiness', () => {
  it('derives the existing recovery ID from the exact fixed-order identity bytes', () => {
    expect(
      deriveDynamoDbRecoveryId({
        planType: 'dynamodb-recovery',
        recoveryPoint: RECOVERY_POINT,
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
      }),
    ).toBe('ab540221e9e733d13b43a70dc67ed895c3fbd8a7da75853d3237efc53e87f37a');
  });

  it('rejects unbound prerequisite and IAM boolean attestations', () => {
    const input = inputFixture();
    const retainedEvidence = input.prerequisites.retainedEvidence;
    if (retainedEvidence === null) throw new Error('Test fixture must contain retained prerequisite evidence.');

    expect(() =>
      evaluateDynamoDbRecoveryReadiness({
        ...input,
        prerequisites: {
          ...retainedEvidence.checks,
          owner: input.prerequisites.owner,
        },
        iam: {
          readOnlySurfaceVerified: true,
          mutationActionsAbsent: true,
          applyRoleAssumptionAbsent: true,
        },
      }),
    ).toThrow(/retained prerequisite evidence/u);
  });

  it('emits closed report-only evidence for a coherent adjacent recovery transition', () => {
    const evidence = evaluateDynamoDbRecoveryReadiness(inputFixture());

    expect(evidence).toMatchObject({
      evidenceType: 'dynamodb-recovery-readiness',
      controlSourceSha: CONTROL_SOURCE_SHA,
      recovery: {
        currentPhase: 'primary_quiesced',
        requestedPhase: 'replacement_quiesced',
        transitionDisposition: 'forward',
      },
      result: 'ready',
      rejectedChecks: [],
      reportOnly: true,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(validateDynamoDbRecoveryReadinessEvidence(evidence)).toEqual(evidence);
    expect(evidence).not.toHaveProperty('state');
    expect(evidence).not.toHaveProperty('plan');
    expect(JSON.stringify(evidence)).not.toMatch(/rawSessionIds|itemValues|rawError/u);
  });

  it('reports disabled PITR and recovery points outside the retained primary window', () => {
    const disabled = cloneFixture();
    disabled.tables.primary.sessions.continuousBackups = {
      status: 'DISABLED',
      earliestRestorableAt: null,
      latestRestorableAt: null,
    };
    expect(evaluateDynamoDbRecoveryReadiness(disabled)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['primary-sessions'],
    });

    const outside = cloneFixture();
    outside.tables.primary.votes.continuousBackups = {
      status: 'ENABLED',
      earliestRestorableAt: '2026-07-11T00:00:00.000Z',
      latestRestorableAt: LATEST_RESTORABLE_AT,
    };
    expect(evaluateDynamoDbRecoveryReadiness(outside)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['primary-votes'],
    });
  });

  it('rejects a wrong target or source authority', () => {
    const wrongTarget = cloneFixture();
    wrongTarget.targetContext.target.region = 'us-east-1';
    expect(() => evaluateDynamoDbRecoveryReadiness(wrongTarget)).toThrow(/canonical allowed target|App lane/u);

    const wrongSource = cloneFixture();
    const authorityBody = wrongSource.currentAuthority.body as {
      acceptedDeployments: Array<Record<string, unknown>>;
    };
    const currentEntry = authorityBody.acceptedDeployments[0];
    if (currentEntry === undefined) throw new Error('Test fixture must contain the current accepted deployment.');
    currentEntry['sourceSha'] = 'd'.repeat(40);
    expect(() => evaluateDynamoDbRecoveryReadiness(wrongSource)).toThrow(/current accepted authority/u);
  });

  it('rejects a valid current authority body that is not bound by the observed pointer', () => {
    const input = cloneFixture();
    const authorityBody = input.currentAuthority.body as Record<string, unknown>;
    authorityBody['retentionDays'] = 181;

    expect(() => evaluateDynamoDbRecoveryReadiness(input)).toThrow(/pointer changed or contradicts the App lane/u);
  });

  it('rejects the retired caller-projected current authority shape', () => {
    const input = inputFixture();

    expect(() =>
      evaluateDynamoDbRecoveryReadiness({
        ...input,
        currentAuthority: {
          authorityType: 'app-accepted-deployment-authority',
          stateIdentity: input.targetContext.root.stateIdentity,
          pointerBefore: input.currentAuthority.pointerBefore,
          pointerAfter: input.currentAuthority.pointerAfter,
          bodySha256: input.currentAuthority.pointerBefore.sha256,
          pipelineExecutionId: PIPELINE_EXECUTION_ID,
          acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
          sourceSha: CONTROL_SOURCE_SHA,
          controlSourceSha: CONTROL_SOURCE_SHA,
          dynamodbRecoveryPhase: 'primary_quiesced',
          dynamodbRecoveryManifest: input.manifest.reference,
        },
      }),
    ).toThrow(/exact semantic shape/u);
  });

  it('rejects replacement name collisions and targets outside the disposable recovery namespace', () => {
    const collision = cloneFixture();
    const primarySessions = requireDescription(collision.tables.primary.sessions);
    collision.manifest.tables.sessions.replacementTableName = primarySessions.tableName;
    collision.manifest.tables.sessions.replacementTableArn = primarySessions.tableArn;
    expect(() => evaluateDynamoDbRecoveryReadiness(collision)).toThrow(/replacement table names/u);

    const nonDisposable = cloneFixture();
    nonDisposable.manifest.tables.votes.replacementTableName = 'shared-production-votes';
    nonDisposable.manifest.tables.votes.replacementTableArn = tableArn(
      nonDisposable.manifest.region,
      nonDisposable.manifest.accountId,
      'shared-production-votes',
    );
    expect(() => evaluateDynamoDbRecoveryReadiness(nonDisposable)).toThrow(/replacement table names/u);
  });

  it.each([
    [
      'key schema',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).keySchema = [
          { attributeName: 'sessionId', attributeType: 'S', keyType: 'HASH' },
        ];
      },
    ],
    [
      'index schema',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).globalSecondaryIndexes = [];
      },
    ],
    [
      'local secondary index',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).localSecondaryIndexCount = 1;
      },
    ],
    [
      'encryption',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).kmsKeyArn =
          `arn:aws:kms:${input.manifest.region}:${input.manifest.accountId}:key/` +
          'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      },
    ],
    [
      'disabled encryption',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        const description = requireDescription(input.tables.replacement.votes);
        description.sseStatus = 'DISABLED';
        description.kmsKeyArn = null;
      },
    ],
    [
      'TTL',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        input.tables.replacement.votes.timeToLive = { status: 'DISABLED', attributeName: null };
      },
    ],
    [
      'transitional TTL',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        input.tables.replacement.votes.timeToLive = { status: 'ENABLING', attributeName: 'expiresAt' };
      },
    ],
    [
      'stream',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        const description = requireDescription(input.tables.replacement.votes);
        description.streamEnabled = true;
        description.streamViewType = 'NEW_AND_OLD_IMAGES';
      },
    ],
    [
      'inaccessible table status',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).tableStatus = 'INACCESSIBLE_ENCRYPTION_CREDENTIALS';
      },
    ],
    [
      'capacity',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireDescription(input.tables.replacement.votes).billingMode = 'PROVISIONED';
      },
    ],
    [
      'tags',
      (input: Mutable<DynamoDbRecoveryReadinessInput>) => {
        requireTags(input.tables.replacement.votes).DataClass = 'session-authority';
      },
    ],
  ])('reports a replacement table %s mismatch without raw table data', (_label, mutate) => {
    const input = cloneFixture();
    mutate(input);

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['replacement-votes'],
    });
  });

  it('reports incomplete quiescing and drain prerequisites', () => {
    const input = cloneFixture();
    const prerequisites = requireRetainedPrerequisites(input);
    prerequisites.checks.quiescing.verificationEventSourceMappingDisabled = false;
    prerequisites.checks.drain.inFlightExecutionsDrained = false;

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['drain', 'quiescing'],
    });
  });

  it('rejects a skipped recovery phase', () => {
    const input = cloneFixture();
    input.requestedRecovery.phase = 'replacement_active';

    expect(() => evaluateDynamoDbRecoveryReadiness(input)).toThrow(/adjacent phase/u);
  });

  it('rejects stale current-control and accepted-baseline authority', () => {
    const staleControl = cloneFixture();
    staleControl.currentControlSourceSha = 'e'.repeat(40);
    expect(() => evaluateDynamoDbRecoveryReadiness(staleControl)).toThrow(/explicitly reviewed source/u);

    const staleBaseline = cloneFixture();
    staleBaseline.acceptedBaseline.controlSourceSha = 'e'.repeat(40);
    expect(() => evaluateDynamoDbRecoveryReadiness(staleBaseline)).toThrow(/accepted App baseline/u);
  });

  it('reports missing data-validation and future-smoke requirements', () => {
    const input = cloneFixture();
    const prerequisites = requireRetainedPrerequisites(input);
    prerequisites.checks.dataValidation.checksumCheckRequired = false;
    prerequisites.checks.smoke.requestedPhaseRequired = false;

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['data-validation', 'smoke'],
    });
  });

  it('reports cleanup requested without its own immutable authorization', () => {
    const input = cloneFixture();
    input.cleanup.requested = true;

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['cleanup-authorization'],
    });
  });

  it('reports missing tables, owner checks, wrong-capability checks, and no-mutation IAM evidence', () => {
    const input = cloneFixture();
    input.tables.replacement.sessions = {
      availability: 'missing',
      describeTable: null,
      continuousBackups: null,
      timeToLive: null,
      tags: null,
    };
    input.prerequisites.owner.accountMatched = false;
    requireRetainedPrerequisites(input).checks.wrongCapability.mutationDenied = false;
    const observedPolicy = requireObservedIam(input).attachedPolicies[0];
    if (observedPolicy === undefined) throw new Error('Test fixture must contain an attached IAM policy.');
    observedPolicy.documentSha256 = 'd'.repeat(64);

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['owner', 'read-only-iam', 'replacement-sessions', 'wrong-capability'],
    });
  });

  it('reports every retained prerequisite category not-ready when no exact evidence was read', () => {
    const input = cloneFixture();
    input.prerequisites.retainedEvidence = null;

    expect(evaluateDynamoDbRecoveryReadiness(input)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['data-validation', 'drain', 'quiescing', 'smoke', 'wrong-capability'],
    });
  });

  it('rejects retained prerequisite evidence that does not bind its bytes or current transition', () => {
    const wrongBytes = cloneFixture();
    requireRetainedPrerequisites(wrongBytes).bodySha256 = 'e'.repeat(64);
    expect(() => evaluateDynamoDbRecoveryReadiness(wrongBytes)).toThrow(/immutable reference/u);

    const staleAuthority = cloneFixture();
    const retainedPointer = requireRetainedPrerequisites(staleAuthority).currentAcceptedAuthority.pointer;
    requireRetainedPrerequisites(staleAuthority).currentAcceptedAuthority.pointer = {
      ...retainedPointer,
      sha256: 'f'.repeat(64),
    };
    expect(() => evaluateDynamoDbRecoveryReadiness(staleAuthority)).toThrow(/current reviewed transition/u);
  });

  it('reports IAM not-ready when live policy evidence is absent or differs from the reviewed contract', () => {
    const absent = cloneFixture();
    absent.iam.observed = null;
    expect(evaluateDynamoDbRecoveryReadiness(absent)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['read-only-iam'],
    });

    const changed = cloneFixture();
    requireObservedIam(changed).trustPolicySha256 = '0'.repeat(64);
    expect(evaluateDynamoDbRecoveryReadiness(changed)).toMatchObject({
      result: 'not-ready',
      rejectedChecks: ['read-only-iam'],
    });
  });

  it('rejects duplicate identities in an otherwise length-correct sorted IAM policy inventory', () => {
    const input = cloneFixture();
    const reviewedPolicy = input.iam.reviewed.attachedPolicies[0];
    const observedPolicy = requireObservedIam(input).attachedPolicies[0];
    if (reviewedPolicy === undefined || observedPolicy === undefined) {
      throw new Error('Test fixture must contain attached IAM policies.');
    }
    input.iam.reviewed.attachedPolicies = [structuredClone(reviewedPolicy), structuredClone(reviewedPolicy)];
    requireObservedIam(input).attachedPolicies = [structuredClone(observedPolicy), structuredClone(observedPolicy)];

    expect(() => evaluateDynamoDbRecoveryReadiness(input)).toThrow(/exact sorted policy inventory/u);
  });

  it('binds only an optional redacted Terraform plan summary', () => {
    const input = cloneFixture();
    input.planSummary = {
      actionCounts: { create: 0, update: 2, replace: 0, delete: 0, readOnly: 1 },
      addresses: [{ address: 'aws_lambda_function.public_api', actionClasses: ['update'] }],
      omittedAddressCount: 0,
    };

    const evidence = evaluateDynamoDbRecoveryReadiness(input);
    expect(evidence.planSummary).toEqual(input.planSummary);
    expect(evidence).not.toHaveProperty('planPath');
    expect(evidence).not.toHaveProperty('savedPlan');
  });

  it('rejects a non-canonical redacted Terraform summary', () => {
    const input = cloneFixture();
    input.planSummary = {
      actionCounts: { create: 0, update: 2, replace: 0, delete: 0, readOnly: 0 },
      addresses: [
        { address: 'aws_s3_bucket.second', actionClasses: ['update'] },
        { address: 'aws_s3_bucket.first', actionClasses: ['update'] },
      ],
      omittedAddressCount: 0,
    };

    expect(() => evaluateDynamoDbRecoveryReadiness(input)).toThrow(/Terraform drift addresses/u);
  });

  it('rejects unknown input, manifest, observation, prerequisite, and evidence fields', () => {
    const input = inputFixture();
    expect(() => evaluateDynamoDbRecoveryReadiness({ ...input, unexpectedField: true })).toThrow(
      /exact semantic shape/u,
    );
    expect(() =>
      evaluateDynamoDbRecoveryReadiness({
        ...input,
        manifest: { ...input.manifest, rawSessionIds: ['secret'] },
      }),
    ).toThrow(/exact semantic shape/u);
    expect(() =>
      evaluateDynamoDbRecoveryReadiness({
        ...input,
        tables: {
          ...input.tables,
          primary: {
            ...input.tables.primary,
            sessions: { ...input.tables.primary.sessions, rawDescribeTable: {} },
          },
        },
      }),
    ).toThrow(/exact semantic shape/u);
    expect(() =>
      evaluateDynamoDbRecoveryReadiness({
        ...input,
        prerequisites: { ...input.prerequisites, restoreAlreadyCreated: true },
      }),
    ).toThrow(/exact semantic shape/u);

    const evidence = evaluateDynamoDbRecoveryReadiness(input);
    expect(() => validateDynamoDbRecoveryReadinessEvidence({ ...evidence, rawError: 'secret' })).toThrow(
      /exact semantic shape/u,
    );
  });
});
