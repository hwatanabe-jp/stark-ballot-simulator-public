import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalRecordJson,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
} from '@stark-ballot/deployment-authority';
import { CURRENT_AUTHORITY_ENTRY_KEYS, RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES } from './app-acceptance.js';
import {
  evaluateRollbackReadiness,
  ROLLBACK_READINESS_DEPENDENCY_CATEGORIES,
  validateRollbackReadinessEvidence,
  type RollbackReadinessDependencyCategory,
  type RollbackReadinessInput,
} from './rollback-readiness.js';

const CONTROL_SOURCE_SHA = 'c'.repeat(40);
const SELECTED_SOURCE_SHA = 'a'.repeat(40);
const HISTORICAL_CONTROL_SOURCE_SHA = 'b'.repeat(40);
const PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
const ACCEPTANCE_ATTEMPT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HEAD_PIPELINE_EXECUTION_ID = '99999999-8888-7777-6666-555555555555';
const HEAD_ACCEPTANCE_ATTEMPT_ID = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
const PLAN_CHECKSUM = '4'.repeat(64);
const VALUE_DEPENDENCIES = new Set<RollbackReadinessDependencyCategory>([
  'image-id-method',
  'plan-inputs',
  'prover-image-digest',
  'prover-image-signature',
  'rollback-history',
]);

function reference(name: string, character: string) {
  return {
    key: `readiness/${name}.json`,
    versionId: `version-${character}`,
    sha256: character.repeat(64),
  };
}

function authorityEntry(options: {
  readonly targetContext: ReturnType<typeof renderDeploymentLaneContext>;
  readonly pipelineExecutionId: string;
  readonly acceptanceAttemptId: string;
  readonly sourceSha: string;
  readonly controlSourceSha: string;
  readonly planChecksum: string;
  readonly reference: ReturnType<typeof reference>;
}) {
  const attemptPrefix =
    `${options.targetContext.names.acceptedDeploymentPrefix}/executions/${options.pipelineExecutionId}/attempts/` +
    options.acceptanceAttemptId;
  const deploymentIdentityAuthoritySha256 = 'd'.repeat(64);
  const entry = Object.fromEntries(CURRENT_AUTHORITY_ENTRY_KEYS.map((key) => [key, null]));
  Object.assign(
    entry,
    Object.fromEntries(
      Object.entries(RETAINED_DEPLOYMENT_ARTIFACT_BASENAMES).map(([field, basename]) => [
        field,
        `${attemptPrefix}/${basename}`,
      ]),
    ),
  );
  return Object.assign(entry, {
    acceptanceAttemptId: options.acceptanceAttemptId,
    accountId: options.targetContext.target.accountId,
    applyOutputsSha256: '3'.repeat(64),
    approvalEvidencePath: `${options.targetContext.names.approvalEvidencePrefix}/${options.pipelineExecutionId}.json`,
    approvalEvidenceSha256: '4'.repeat(64),
    approvalEvidenceVersionId: 'approval-version',
    approvalReason: 'manual-approval',
    controlSourceSha: options.controlSourceSha,
    deploymentEnvironment: options.targetContext.target.environmentId,
    deploymentId: `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`,
    deploymentIdentityAuthoritySha256,
    deploymentMode: options.sourceSha === options.controlSourceSha ? 'normal' : 'rollback',
    dynamodbRecoveryManifest: null,
    dynamodbRecoveryPhase: 'primary_active',
    importingResourceChangeCount: 0,
    manifestPath: options.reference.key,
    manifestSha256: options.reference.sha256,
    manifestVersionId: options.reference.versionId,
    manualApprovalSkipped: false,
    movedResourceChangeCount: 0,
    outputChangeCount: 0,
    pipelineExecutionId: options.pipelineExecutionId,
    planChecksum: options.planChecksum,
    planEmpty: false,
    resourceChangeCount: 1,
    rollbackSelection: options.sourceSha === options.controlSourceSha ? null : {},
    selectedSourceSha: options.sourceSha,
    sourceSha: options.sourceSha,
  });
}

function authorityObservation(
  targetContext: ReturnType<typeof renderDeploymentLaneContext>,
  acceptedDeployments: readonly Record<string, unknown>[],
) {
  const body = {
    acceptedDeployments,
    authorityType: 'app-accepted-deployment-authority',
    maxRetainedAcceptedDeployments: 10,
    retentionDays: 180,
    stateIdentity: targetContext.root.stateIdentity,
  };
  const bodySha256 = createHash('sha256').update(canonicalRecordJson(body)).digest('hex');
  const pointer = {
    key: targetContext.names.acceptedDeploymentPointerKey,
    versionId: 'current-version',
    sha256: bodySha256,
  };
  return { body, pointerBefore: pointer, pointerAfter: { ...pointer } };
}

function inputFixture(): RollbackReadinessInput {
  const target = resolveAllowedDeploymentTarget('stark-dev/develop');
  const targetContext = renderDeploymentLaneContext({
    target,
    lane: 'app',
    accountId: target.accountId,
    requestedControlSourceSha: CONTROL_SOURCE_SHA,
    selectedApplicationSourceSha: SELECTED_SOURCE_SHA,
    frameworkSourceSha: CONTROL_SOURCE_SHA,
  });
  const candidateReference = {
    ...reference('candidate', '2'),
    key:
      `${targetContext.names.acceptedDeploymentPrefix}/executions/${PIPELINE_EXECUTION_ID}/attempts/` +
      `${ACCEPTANCE_ATTEMPT_ID}/authoritative-app-deployment.json`,
  };
  const acceptedBaselineReference = {
    ...reference('accepted-baseline', '3'),
    key:
      `${targetContext.names.terraformBaselinePrefix}/${targetContext.root.stateIdentity}/executions/` +
      `${PIPELINE_EXECUTION_ID}/attempts/${ACCEPTANCE_ATTEMPT_ID}/baseline.json`,
  };
  const currentHeadReference = {
    ...reference('current-head', '1'),
    key:
      `${targetContext.names.acceptedDeploymentPrefix}/executions/${HEAD_PIPELINE_EXECUTION_ID}/attempts/` +
      `${HEAD_ACCEPTANCE_ATTEMPT_ID}/authoritative-app-deployment.json`,
  };
  const currentAuthority = authorityObservation(targetContext, [
    authorityEntry({
      targetContext,
      pipelineExecutionId: HEAD_PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: HEAD_ACCEPTANCE_ATTEMPT_ID,
      sourceSha: CONTROL_SOURCE_SHA,
      controlSourceSha: CONTROL_SOURCE_SHA,
      planChecksum: '1'.repeat(64),
      reference: currentHeadReference,
    }),
    authorityEntry({
      targetContext,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
      sourceSha: SELECTED_SOURCE_SHA,
      controlSourceSha: HISTORICAL_CONTROL_SOURCE_SHA,
      planChecksum: PLAN_CHECKSUM,
      reference: candidateReference,
    }),
  ]);
  return {
    targetContext,
    currentAuthority,
    candidate: {
      recordType: 'app-accepted-deployment',
      reference: candidateReference,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
      accountId: targetContext.target.accountId,
      region: targetContext.target.region,
      deploymentEnvironment: targetContext.target.environmentId,
      stateIdentity: targetContext.root.stateIdentity,
      backendKey: targetContext.root.backendKey,
      controlSourceSha: HISTORICAL_CONTROL_SOURCE_SHA,
      sourceSha: SELECTED_SOURCE_SHA,
      selectedSourceSha: SELECTED_SOURCE_SHA,
      planChecksum: PLAN_CHECKSUM,
    },
    acceptedBaseline: {
      recordType: 'accepted-terraform-baseline',
      reference: acceptedBaselineReference,
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
      acceptedPlanChecksum: PLAN_CHECKSUM,
      controlSourceSha: HISTORICAL_CONTROL_SOURCE_SHA,
      stateIdentity: targetContext.root.stateIdentity,
      backendKey: targetContext.root.backendKey,
    },
    reviewedControlSourceSha: CONTROL_SOURCE_SHA,
    currentControlSourceSha: CONTROL_SOURCE_SHA,
    dependencies: ROLLBACK_READINESS_DEPENDENCY_CATEGORIES.map((category, index) => {
      const character = ((index % 6) + 4).toString();
      if (VALUE_DEPENDENCIES.has(category)) {
        return {
          category,
          status: 'available' as const,
          reference: null,
          observedReference: null,
          expectedValueSha256: character.repeat(64),
          observedValueSha256: character.repeat(64),
        };
      }
      const dependencyReference =
        category === 'accepted-baseline'
          ? acceptedBaselineReference
          : category === 'candidate-record'
            ? candidateReference
            : reference(category, character);
      return {
        category,
        status: 'available' as const,
        reference: dependencyReference,
        observedReference: dependencyReference,
        expectedValueSha256: null,
        observedValueSha256: null,
      };
    }),
    planSummary: null,
    startedAt: '2026-08-02T01:02:03.000Z',
    finishedAt: '2026-08-02T01:03:04.000Z',
  };
}

function replaceDependency(
  input: RollbackReadinessInput,
  category: RollbackReadinessDependencyCategory,
  status: 'missing' | 'rejected',
): RollbackReadinessInput {
  return {
    ...input,
    dependencies: input.dependencies.map((dependency) =>
      dependency.category === category
        ? {
            ...dependency,
            status,
            observedReference: dependency.reference === null || status === 'missing' ? null : dependency.reference,
            observedValueSha256:
              dependency.expectedValueSha256 === null ? null : status === 'missing' ? null : 'f'.repeat(64),
          }
        : dependency,
    ),
  };
}

function acceptedDeployments(input: RollbackReadinessInput): readonly Record<string, unknown>[] {
  const body = input.currentAuthority.body as { readonly acceptedDeployments: readonly Record<string, unknown>[] };
  return body.acceptedDeployments;
}

describe('rollback readiness', () => {
  it('emits closed report-only evidence for a reachable current-semantic candidate', () => {
    const evidence = evaluateRollbackReadiness(inputFixture());

    expect(evidence).toMatchObject({
      evidenceType: 'app-rollback-readiness',
      controlSourceSha: CONTROL_SOURCE_SHA,
      result: 'ready',
      rejectedDependencies: [],
      reportOnly: true,
      candidate: {
        pipelineExecutionId: PIPELINE_EXECUTION_ID,
        acceptanceAttemptId: ACCEPTANCE_ATTEMPT_ID,
        selectedSourceSha: SELECTED_SOURCE_SHA,
      },
    });
    expect(evidence.dependencies.map(({ category }) => category)).toEqual(ROLLBACK_READINESS_DEPENDENCY_CATEGORIES);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(validateRollbackReadinessEvidence(evidence)).toEqual(evidence);
  });

  it('reports the current accepted head as explicitly not ready when no rollback history exists', () => {
    const input = inputFixture();
    const candidateEntry = acceptedDeployments(input)[1];
    if (candidateEntry === undefined) throw new Error('Test fixture must contain the rollback candidate.');
    const evidence = evaluateRollbackReadiness({
      ...input,
      currentAuthority: authorityObservation(input.targetContext, [candidateEntry]),
    });

    expect(evidence.result).toBe('not-ready');
    expect(evidence.rejectedDependencies).toContain('rollback-history');
    expect(evidence.candidate.reference).toEqual(input.candidate.reference);
  });

  it.each(ROLLBACK_READINESS_DEPENDENCY_CATEGORIES.filter((category) => category !== 'rollback-history'))(
    'reports a missing or rejected %s without selecting a fallback',
    (category) => {
      const evidence = evaluateRollbackReadiness(
        replaceDependency(inputFixture(), category, VALUE_DEPENDENCIES.has(category) ? 'rejected' : 'missing'),
      );

      expect(evidence.result).toBe('not-ready');
      expect(evidence.rejectedDependencies).toEqual([category]);
      expect(evidence.candidate.reference).toEqual(inputFixture().candidate.reference);
    },
  );

  it('binds an optional redacted fresh-plan summary without exposing plan bytes', () => {
    const input = inputFixture();
    const evidence = evaluateRollbackReadiness({
      ...input,
      planSummary: {
        actionCounts: { create: 0, update: 2, replace: 0, delete: 0, readOnly: 1 },
        addresses: [{ address: 'aws_lambda_function.public_api', actionClasses: ['update'] }],
        omittedAddressCount: 0,
      },
    });

    expect(evidence.planSummary).toEqual({
      actionCounts: { create: 0, delete: 0, readOnly: 1, replace: 0, update: 2 },
      addresses: [{ address: 'aws_lambda_function.public_api', actionClasses: ['update'] }],
      omittedAddressCount: 0,
    });
    expect(evidence).not.toHaveProperty('plan');
    expect(evidence).not.toHaveProperty('planPath');
  });

  it.each([
    [
      'duplicate action classes',
      {
        actionCounts: { create: 0, update: 1, replace: 0, delete: 0, readOnly: 0 },
        addresses: [
          {
            address: 'aws_lambda_function.public_api',
            actionClasses: ['update', 'update'],
          },
        ],
        omittedAddressCount: 0,
      },
    ],
    [
      'unsorted addresses',
      {
        actionCounts: { create: 0, update: 2, replace: 0, delete: 0, readOnly: 0 },
        addresses: [
          { address: 'aws_s3_bucket.second', actionClasses: ['update'] },
          { address: 'aws_s3_bucket.first', actionClasses: ['update'] },
        ],
        omittedAddressCount: 0,
      },
    ],
    [
      'an address absent from the action counts',
      {
        actionCounts: { create: 0, update: 0, replace: 0, delete: 0, readOnly: 0 },
        addresses: [{ address: 'aws_lambda_function.public_api', actionClasses: ['update'] }],
        omittedAddressCount: 0,
      },
    ],
  ])('rejects %s using the canonical Terraform summary admission', (_label, planSummary) => {
    expect(() => evaluateRollbackReadiness({ ...inputFixture(), planSummary })).toThrow(/Terraform drift/u);
  });

  it('reports an observed object VersionId mismatch as rejected evidence', () => {
    const input = inputFixture();
    const evidence = evaluateRollbackReadiness({
      ...input,
      dependencies: input.dependencies.map((dependency) =>
        dependency.category === 'lambda-public-api' && dependency.reference !== null
          ? {
              ...dependency,
              status: 'rejected',
              observedReference: { ...dependency.reference, versionId: 'wrong-version' },
            }
          : dependency,
      ),
    });

    expect(evidence.result).toBe('not-ready');
    expect(evidence.rejectedDependencies).toEqual(['lambda-public-api']);
  });

  it('rejects a current-pointer compare-and-swap or body-hash mismatch', () => {
    const input = inputFixture();
    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        currentAuthority: {
          ...input.currentAuthority,
          pointerAfter: { ...input.currentAuthority.pointerAfter, versionId: 'changed-version' },
        },
      }),
    ).toThrow(/pointer changed/u);
    const tamperedBody = {
      ...(input.currentAuthority.body as Record<string, unknown>),
      retentionDays: 181,
    };
    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        currentAuthority: { ...input.currentAuthority, body: tamperedBody },
      }),
    ).toThrow(/does not bind/u);
  });

  it('rejects the retired caller-projected current authority shape', () => {
    const input = inputFixture();

    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        currentAuthority: {
          authorityType: 'app-accepted-deployment-authority',
          stateIdentity: input.targetContext.root.stateIdentity,
          pointerBefore: input.currentAuthority.pointerBefore,
          pointerAfter: input.currentAuthority.pointerAfter,
          bodySha256: input.currentAuthority.pointerBefore.sha256,
          reachableCandidates: [input.candidate.reference],
        },
      }),
    ).toThrow(/exact semantic shape/u);
  });

  it('rejects a candidate outside current retained reachability even when its object exists', () => {
    const input = inputFixture();
    const currentHead = acceptedDeployments(input)[0];
    if (currentHead === undefined) throw new Error('Test fixture must contain the current head.');
    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        currentAuthority: authorityObservation(input.targetContext, [currentHead]),
      }),
    ).toThrow(/outside current retained semantic reachability/u);
  });

  it.each([
    ['account', { accountId: '111122223333' }],
    ['region', { region: 'us-east-1' }],
    ['environment', { deploymentEnvironment: 'main' }],
    ['source', { selectedSourceSha: 'd'.repeat(40) }],
    ['record shape', { recordType: 'legacy-app-deployment' }],
  ])('rejects a candidate with wrong %s authority', (_label, override) => {
    const input = inputFixture();
    expect(() => evaluateRollbackReadiness({ ...input, candidate: { ...input.candidate, ...override } })).toThrow(
      /candidate/u,
    );
  });

  it('rejects stale baseline and unreviewed current-control source authority', () => {
    const input = inputFixture();
    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        acceptedBaseline: { ...input.acceptedBaseline, acceptedPlanChecksum: 'e'.repeat(64) },
      }),
    ).toThrow(/baseline contradicts/u);
    expect(() => evaluateRollbackReadiness({ ...input, currentControlSourceSha: 'e'.repeat(40) })).toThrow(
      /explicitly reviewed source/u,
    );
  });

  it('rejects evidence whose target-context hash is not bound to its control and selected sources', () => {
    const evidence = evaluateRollbackReadiness(inputFixture());

    expect(() =>
      validateRollbackReadinessEvidence({
        ...evidence,
        target: { ...evidence.target, targetContextSha256: 'f'.repeat(64) },
      }),
    ).toThrow(/target context SHA-256 is invalid/u);
  });

  it('rejects incomplete, duplicate, unknown, and retired semantic shapes', () => {
    const input = inputFixture();
    expect(() => evaluateRollbackReadiness({ ...input, unexpectedField: true })).toThrow(/exact semantic shape/u);
    expect(() => evaluateRollbackReadiness({ ...input, dependencies: input.dependencies.slice(1) })).toThrow(
      /every closed category/u,
    );
    expect(() =>
      evaluateRollbackReadiness({
        ...input,
        dependencies: input.dependencies.map((dependency, index) =>
          index === 0 ? { ...dependency, category: 'legacy-artifact' } : dependency,
        ),
      }),
    ).toThrow(/category is invalid/u);
    const evidence = evaluateRollbackReadiness(input);
    expect(() => validateRollbackReadinessEvidence({ ...evidence, rawError: 'secret' })).toThrow(
      /exact semantic shape/u,
    );
  });

  it('rejects sparse, accessor-backed, and hidden dependency arrays without invoking accessors', () => {
    const input = inputFixture();
    const sparse: unknown[] = [];
    sparse.length = input.dependencies.length;
    for (let index = 1; index < input.dependencies.length; index += 1) {
      sparse[index] = input.dependencies[index];
    }
    let getterInvoked = false;
    const accessorBacked = [...input.dependencies];
    Object.defineProperty(accessorBacked, '0', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return input.dependencies[0];
      },
    });
    const hidden = [...input.dependencies];
    Object.defineProperty(hidden, 'secret', { enumerable: false, value: 'do-not-admit' });

    for (const dependencies of [sparse, accessorBacked, hidden]) {
      expect(() => evaluateRollbackReadiness({ ...input, dependencies })).toThrow(/dense data-property array/u);
    }
    expect(getterInvoked).toBe(false);
  });
});
