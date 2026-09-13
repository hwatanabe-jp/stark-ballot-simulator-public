import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonSha256, canonicalRecordJson } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  admitCompactSavedPlanApprovalSummary,
  admitSavedPlanApprovalEvidenceKey,
  admitSavedPlanApprovalAgreement,
  admitSavedPlanReviewMaterial,
  buildExpandedSavedPlanApprovalEvidence,
  deriveSavedPlanApprovalEvidenceKey,
  renderCompactSavedPlanApprovalSummary,
} from './saved-plan-approval-evidence.js';
import { buildSavedPlanCorrespondence } from './saved-plan-correspondence.js';
import { classifySavedPlanDisposition } from './saved-plan-disposition.js';
import { buildSavedPlanFixture } from './testdata/saved-plan-fixture.js';

const PIPELINE_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const ACTION_EXECUTION_ID = '22222222-3333-4444-8555-666666666666';
const SOURCE_SHA = 'a'.repeat(40);
const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const APPROVAL_EVIDENCE_PREFIX = resolveDeploymentLaneAuthority(TARGET, 'bootstrap').names.approvalEvidencePrefix;
const DETACHED_ACCOUNT_ID = TARGET.accountId === '000000000000' ? '111111111111' : '000000000000';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function expandedFixture(
  options: {
    lane?: 'app' | 'bootstrap' | 'foundation';
    gate?: 'terraform' | 'verifier-preflight';
    deploymentMode?: 'normal' | 'rollback';
    selectedSourceSha?: string;
    semanticChange?: boolean;
  } = {},
) {
  const prepared = buildSavedPlanFixture(options);
  return {
    ...prepared,
    input: {
      correspondence: prepared.correspondence,
      review: prepared.review,
      artifactObservation: prepared.artifactObservation,
      pendingAction: prepared.pendingAction,
      reviewerIdentity: prepared.reviewerIdentity,
    },
  };
}

function evidenceReferenceFor(evidence: unknown, versionId = 'approval-evidence-object-id') {
  const value = evidence as {
    target: { targetKey: string; lane: string; gate: string };
    execution: { pipelineExecutionId: string; actionExecutionId: string };
  };
  return {
    key: deriveSavedPlanApprovalEvidenceKey(
      {
        targetKey: value.target.targetKey,
        lane: value.target.lane,
        gate: value.target.gate,
        pipelineExecutionId: value.execution.pipelineExecutionId,
        actionExecutionId: value.execution.actionExecutionId,
      },
      TARGET.targetKey,
    ),
    versionId,
    sha256: sha256(canonicalRecordJson(evidence)),
  };
}

function agreementFixture() {
  const prepared = expandedFixture();
  const evidence = buildExpandedSavedPlanApprovalEvidence(prepared.input, TARGET.targetKey);
  const expandedBody = Buffer.from(canonicalRecordJson(evidence));
  const expandedReference = evidenceReferenceFor(evidence);
  const compactSummary = renderCompactSavedPlanApprovalSummary(
    {
      evidence,
      evidenceReference: expandedReference,
    },
    TARGET.targetKey,
  );
  return {
    ...prepared,
    evidence,
    expandedBody,
    expandedReference,
    compactSummary,
    agreementInput: {
      compactSummary,
      correspondence: prepared.input.correspondence,
      expandedBody,
      expandedReference,
      pendingAction: prepared.input.pendingAction,
    },
  };
}

describe('saved-plan manual approval evidence', () => {
  it.each([
    { targetKey: 'stark-dev/develop', count: 1_000 },
    { targetKey: 'stark-prod/main', count: 101 },
    { targetKey: 'stark-prod/main', count: 1_000 },
  ])(
    'preserves $count resource and drift addresses through $targetKey approval and Apply admission',
    ({ targetKey, count }) => {
      const prepared = buildSavedPlanFixture({
        targetKey,
        lane: 'bootstrap',
        resourceChangeCount: count,
        driftChangeCount: count,
      });
      const material = { correspondence: prepared.correspondence, review: prepared.review };
      const admitted = admitSavedPlanReviewMaterial(material, targetKey);
      expect(admitted.review.summary.changedAddresses).toHaveLength(count);
      expect(admitted.review.summary.drift.names).toHaveLength(count);
      const evidence = buildExpandedSavedPlanApprovalEvidence(
        {
          ...material,
          artifactObservation: prepared.artifactObservation,
          pendingAction: prepared.pendingAction,
          reviewerIdentity: prepared.reviewerIdentity,
        },
        targetKey,
      );
      const expandedBody = Buffer.from(canonicalRecordJson(evidence));
      const expandedReference = {
        key: deriveSavedPlanApprovalEvidenceKey(
          {
            targetKey,
            lane: 'bootstrap',
            gate: 'terraform',
            pipelineExecutionId: evidence.execution.pipelineExecutionId,
            actionExecutionId: evidence.execution.actionExecutionId,
          },
          targetKey,
        ),
        versionId: 'complete-review-approval-version',
        sha256: sha256(expandedBody),
      };
      const compactSummary = renderCompactSavedPlanApprovalSummary(
        { evidence, evidenceReference: expandedReference },
        targetKey,
      );
      expect(Buffer.byteLength(compactSummary)).toBeLessThanOrEqual(512);
      expect(
        admitSavedPlanApprovalAgreement(
          {
            compactSummary,
            correspondence: prepared.correspondence,
            expandedBody,
            expandedReference,
            pendingAction: prepared.pendingAction,
          },
          targetKey,
        ).evidence,
      ).toEqual(evidence);
    },
  );

  it.each([
    {
      name: 'Bootstrap Terraform',
      options: { lane: 'bootstrap' as const },
      mode: 'none',
    },
    {
      name: 'Foundation Terraform',
      options: { lane: 'foundation' as const },
      mode: 'none',
    },
    {
      name: 'App verifier preflight',
      options: { lane: 'app' as const, gate: 'verifier-preflight' as const },
      mode: 'normal',
    },
    {
      name: 'normal App Terraform',
      options: { lane: 'app' as const },
      mode: 'normal',
    },
    {
      name: 'rollback App Terraform',
      options: {
        lane: 'app' as const,
        deploymentMode: 'rollback' as const,
        selectedSourceSha: 'b'.repeat(40),
      },
      mode: 'rollback',
    },
  ])('builds exact expanded evidence for $name', ({ options, mode }) => {
    const { input } = expandedFixture(options);

    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);

    expect(evidence.contract.deploymentMode).toBe(mode);
    expect(evidence.contract.disposition).toBe('REVIEWABLE');
    expect(evidence.execution.pipelineExecutionId).toBe(PIPELINE_EXECUTION_ID);
    expect(evidence.artifact.versionId).toBe(input.review.artifact.versionId);
    expect(evidence.review).toEqual(input.review);
  });

  it('derives one governed key from the target, lane, gate, execution, and pending action', () => {
    expect(
      deriveSavedPlanApprovalEvidenceKey(
        {
          targetKey: 'stark-dev/develop',
          lane: 'bootstrap',
          gate: 'terraform',
          pipelineExecutionId: PIPELINE_EXECUTION_ID,
          actionExecutionId: ACTION_EXECUTION_ID,
        },
        TARGET.targetKey,
      ),
    ).toBe(
      `${APPROVAL_EVIDENCE_PREFIX}/saved-plans/stark-dev/develop/bootstrap/terraform/` +
        `${PIPELINE_EXECUTION_ID}/${ACTION_EXECUTION_ID}.json`,
    );
  });

  it('admits only the exact derived approval-evidence key', () => {
    const key = deriveSavedPlanApprovalEvidenceKey(
      {
        targetKey: TARGET.targetKey,
        lane: 'foundation',
        gate: 'terraform',
        pipelineExecutionId: PIPELINE_EXECUTION_ID,
        actionExecutionId: ACTION_EXECUTION_ID,
      },
      TARGET.targetKey,
    );

    expect(admitSavedPlanApprovalEvidenceKey(key, TARGET.targetKey)).toBe(key);
    expect(() =>
      admitSavedPlanApprovalEvidenceKey(key.replace('/foundation/terraform/', '/app/foundation/'), TARGET.targetKey),
    ).toThrow();
    expect(() => admitSavedPlanApprovalEvidenceKey(key.replace('.json', '/extra.json'), TARGET.targetKey)).toThrow();
    expect(() => admitSavedPlanApprovalEvidenceKey(`${key}?version=latest`, TARGET.targetKey)).toThrow();
    expect(() => admitSavedPlanApprovalEvidenceKey(new String(key), TARGET.targetKey)).toThrow();
  });

  it('rejects widened or unsupported deterministic-key inputs', () => {
    const input = {
      targetKey: TARGET.targetKey,
      lane: 'bootstrap',
      gate: 'terraform',
      pipelineExecutionId: PIPELINE_EXECUTION_ID,
      actionExecutionId: ACTION_EXECUTION_ID,
    };

    expect(() =>
      deriveSavedPlanApprovalEvidenceKey({ ...input, targetKey: 'stark-prod/main' }, TARGET.targetKey),
    ).toThrow();
    expect(() =>
      deriveSavedPlanApprovalEvidenceKey({ ...input, lane: 'app', gate: 'unknown' }, TARGET.targetKey),
    ).toThrow();
    expect(() =>
      deriveSavedPlanApprovalEvidenceKey({ ...input, actionExecutionId: 'not-a-uuid' }, TARGET.targetKey),
    ).toThrow();
    expect(() => deriveSavedPlanApprovalEvidenceKey({ ...input, unexpected: true }, TARGET.targetKey)).toThrow(
      'exact current shape',
    );
    expect(() => deriveSavedPlanApprovalEvidenceKey(new Proxy(input, {}), TARGET.targetKey)).toThrow('Proxy');
    const coercion = vi.fn(() => 'bootstrap');
    expect(() =>
      deriveSavedPlanApprovalEvidenceKey(
        {
          ...input,
          lane: { [Symbol.toPrimitive]: coercion },
        },
        TARGET.targetKey,
      ),
    ).toThrow();
    expect(coercion).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'reviewable Bootstrap', options: { lane: 'bootstrap' as const }, disposition: 'REVIEWABLE' },
    {
      name: 'empty normal App',
      options: { lane: 'app' as const, semanticChange: false },
      disposition: 'EMPTY_PLAN_SKIP',
    },
  ])('admits $name review material before any approval-action authority is needed', ({ options, disposition }) => {
    const prepared = expandedFixture(options);

    const admitted = admitSavedPlanReviewMaterial(
      {
        correspondence: prepared.correspondence,
        review: prepared.review,
      },
      TARGET.targetKey,
    );

    expect(admitted.correspondence.contract.disposition).toBe(disposition);
    expect(admitted.review).toEqual(prepared.review);
    expect(admitted.correspondence.contract.review).toEqual({
      reviewType: 'saved-plan-semantic-review',
      context: prepared.review.context,
      summary: prepared.review.summary,
      approval: prepared.review.approval,
      authority: prepared.review.authority,
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it('rejects detached review material before selecting an approval action', () => {
    const prepared = expandedFixture({ lane: 'app', semanticChange: false });
    const detachedReview = {
      ...prepared.review,
      summary: { ...prepared.review.summary, planJsonSha256: '0'.repeat(64) },
    };

    expect(() =>
      admitSavedPlanReviewMaterial(
        {
          correspondence: prepared.correspondence,
          review: detachedReview,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/Terraform plan|correspondence/u);
    expect(() =>
      admitSavedPlanReviewMaterial(
        {
          correspondence: prepared.correspondence,
          review: prepared.review,
          pendingAction: prepared.pendingAction,
        },
        TARGET.targetKey,
      ),
    ).toThrow('exact current shape');
  });

  it('builds one exact expanded approval binding from an admitted correspondence and artifact observation', () => {
    const { input } = expandedFixture();

    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);

    expect(evidence).toMatchObject({
      correspondenceSha256: sha256(input.correspondence.manifestBody),
      contract: {
        deploymentMode: 'none',
        disposition: 'REVIEWABLE',
        reviewDigest: input.review.reviewDigest,
      },
      target: {
        targetKey: TARGET.targetKey,
        lane: 'bootstrap',
        gate: 'terraform',
        accountId: TARGET.accountId,
      },
      source: { controlSourceSha: SOURCE_SHA, selectedApplicationSourceSha: null },
      execution: {
        pipelineExecutionId: PIPELINE_EXECUTION_ID,
        stageName: 'ManualApproval',
        actionName: 'ApproveInitialDevelopmentApply',
        actionExecutionId: ACTION_EXECUTION_ID,
      },
      resolvedInputs: null,
    });
    expect(Object.keys(evidence).sort()).toEqual([
      'artifact',
      'contract',
      'correspondenceSha256',
      'execution',
      'resolvedInputs',
      'review',
      'reviewer',
      'source',
      'target',
    ]);
    expect(Object.keys(evidence.contract).sort()).toEqual([
      'deploymentMode',
      'disposition',
      'reviewDigest',
      'tfplanSha256',
    ]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.artifact.metadata)).toBe(true);
  });

  it('does not enumerate correspondence byte indices while building expanded evidence', () => {
    const { input } = expandedFixture();
    const rawBytes = new Set<unknown>([
      input.correspondence.manifestBody,
      input.correspondence.files.tfplan,
      input.correspondence.files.tfplanJson,
    ]);
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');

    try {
      expect(buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey).contract.disposition).toBe('REVIEWABLE');
      expect(ownKeys.mock.calls.some(([value]) => rawBytes.has(value))).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it('rejects plan JSON whose semantic structure differs from the reviewer-side review', () => {
    const { input } = expandedFixture();
    const expected = structuredClone(input.correspondence.expected);
    const files = { ...input.correspondence.files };
    const planJson = JSON.parse(Buffer.from(files.tfplanJson).toString('utf8')) as {
      resource_changes: unknown[];
    };
    planJson.resource_changes.push({
      address: 'aws_s3_bucket.detached',
      change: {
        actions: ['update'],
        before: {},
        after: {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    });
    files.tfplanJson = Buffer.from(canonicalRecordJson(planJson));
    const semanticReview = structuredClone(expected.contract.review);
    mutableRecord(semanticReview.summary)['planJsonSha256'] = sha256(files.tfplanJson);
    const contract = classifySavedPlanDisposition({ appReleaseChain: null, review: semanticReview }, TARGET.targetKey);
    expected.contract = contract;
    expect(() => buildSavedPlanCorrespondence({ ...expected, files }, TARGET.targetKey)).toThrow(
      'exact Terraform plan',
    );
  });

  it('bounds the exact saved-plan archive observation at 512 MiB', () => {
    const { input } = expandedFixture();
    const atBound = {
      ...input,
      artifactObservation: {
        ...input.artifactObservation,
        metadata: { ...input.artifactObservation.metadata, contentLength: 512 * 1024 * 1024 },
      },
    };

    expect(buildExpandedSavedPlanApprovalEvidence(atBound, TARGET.targetKey).artifact.metadata.contentLength).toBe(
      512 * 1024 * 1024,
    );
    expect(() =>
      buildExpandedSavedPlanApprovalEvidence(
        {
          ...input,
          artifactObservation: {
            ...input.artifactObservation,
            metadata: { ...input.artifactObservation.metadata, contentLength: 512 * 1024 * 1024 + 1 },
          },
        },
        TARGET.targetKey,
      ),
    ).toThrow('content length');
  });

  it('rejects detached artifact coordinates, identity, and object metadata', () => {
    const { input } = expandedFixture();
    const artifact = input.artifactObservation;
    const candidates: unknown[] = [
      { ...artifact, bucket: 'detached-artifact-bucket' },
      { ...artifact, key: 'pipeline/PlanOutput/detached-artifact.zip' },
      { ...artifact, versionId: 'detached-object-id' },
      { ...artifact, sha256: '0'.repeat(64) },
      { ...artifact, metadata: { ...artifact.metadata, etag: 'unquoted-etag' } },
      {
        ...artifact,
        metadata: {
          ...artifact.metadata,
          kmsKeyArn: `arn:aws:kms:${TARGET.region}:${DETACHED_ACCOUNT_ID}:key/55555555-6666-7777-8888-999999999999`,
        },
      },
      { ...artifact, metadata: { ...artifact.metadata, serverSideEncryption: 'AES256' } },
      { ...artifact, metadata: { ...artifact.metadata, unexpected: true } },
    ];

    for (const artifactObservation of candidates) {
      expect(() =>
        buildExpandedSavedPlanApprovalEvidence({ ...input, artifactObservation }, TARGET.targetKey),
      ).toThrow();
    }
  });

  it('rejects pending-action and admin-reviewer identity drift without retaining a token', () => {
    const { input } = expandedFixture();
    const pendingCandidates: unknown[] = [
      { ...input.pendingAction, pipelineExecutionId: '99999999-8888-7777-6666-555555555555' },
      { ...input.pendingAction, stageName: 'DetachedApproval' },
      { ...input.pendingAction, actionName: 'DetachedApprovalAction' },
      { ...input.pendingAction, token: 'must-not-be-retained' },
    ];
    for (const pendingAction of pendingCandidates) {
      expect(() => buildExpandedSavedPlanApprovalEvidence({ ...input, pendingAction }, TARGET.targetKey)).toThrow();
    }

    const reviewerCandidates: unknown[] = [
      { ...input.reviewerIdentity, Account: DETACHED_ACCOUNT_ID },
      {
        ...input.reviewerIdentity,
        Arn: `arn:aws:sts::${TARGET.accountId}:assumed-role/stark-dev-operator/reviewer`,
      },
      { ...input.reviewerIdentity, UserId: 'AROABCDEFGHIJKLMNOP:different-session' },
      { ...input.reviewerIdentity, unexpected: true },
    ];
    for (const reviewerIdentity of reviewerCandidates) {
      expect(() => buildExpandedSavedPlanApprovalEvidence({ ...input, reviewerIdentity }, TARGET.targetKey)).toThrow();
    }
    expect(buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey)).not.toHaveProperty('token');
  });

  it('rejects accessors, symbols, and direct or nested Proxies without invoking attacker code', () => {
    const { input } = expandedFixture();
    const directGetter = vi.fn(() => input.review);
    const directAccessor = { ...input };
    Object.defineProperty(directAccessor, 'review', { enumerable: true, get: directGetter });
    const nestedGetter = vi.fn(() => input.artifactObservation.metadata.etag);
    const nestedMetadata = { ...input.artifactObservation.metadata };
    Object.defineProperty(nestedMetadata, 'etag', { enumerable: true, get: nestedGetter });
    const nestedAccessor = {
      ...input,
      artifactObservation: { ...input.artifactObservation, metadata: nestedMetadata },
    };

    expect(() => buildExpandedSavedPlanApprovalEvidence(directAccessor, TARGET.targetKey)).toThrow();
    expect(() => buildExpandedSavedPlanApprovalEvidence(nestedAccessor, TARGET.targetKey)).toThrow();
    expect(directGetter).not.toHaveBeenCalled();
    expect(nestedGetter).not.toHaveBeenCalled();
    expect(() =>
      buildExpandedSavedPlanApprovalEvidence({ ...input, [Symbol('hidden')]: true }, TARGET.targetKey),
    ).toThrow();
    expect(() => buildExpandedSavedPlanApprovalEvidence(new Proxy(input, {}), TARGET.targetKey)).toThrow('Proxy');
    expect(() =>
      buildExpandedSavedPlanApprovalEvidence(
        {
          ...input,
          artifactObservation: new Proxy(input.artifactObservation, {}),
        },
        TARGET.targetKey,
      ),
    ).toThrow('Proxy');
  });

  it('rebinds the full reviewer-side artifact, state, context, summary, and digest', () => {
    const { input } = expandedFixture();
    const detachedArtifact = structuredClone(input.review);
    detachedArtifact.artifact.versionId = 'detached-object-id';
    const detachedState = { ...input.review, state: { ...input.review.state, bucket: 'detached-state-bucket' } };
    const detachedContext = { ...input.review, context: { ...input.review.context, sourceSha: 'b'.repeat(40) } };
    const detachedSummary = { ...input.review, summary: { ...input.review.summary, tfplanSha256: '0'.repeat(64) } };
    const detachedDigest = structuredClone(input.review);
    detachedDigest.reviewDigest = '0'.repeat(64);

    for (const review of [detachedArtifact, detachedState, detachedContext, detachedSummary, detachedDigest]) {
      expect(() => buildExpandedSavedPlanApprovalEvidence({ ...input, review }, TARGET.targetKey)).toThrow();
    }
  });

  it('renders a bounded compact summary that binds the expanded object identity', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const evidenceBody = Buffer.from(canonicalRecordJson(evidence));
    const evidenceReference = {
      key: deriveSavedPlanApprovalEvidenceKey(
        {
          targetKey: evidence.target.targetKey,
          lane: evidence.target.lane,
          gate: evidence.target.gate,
          pipelineExecutionId: evidence.execution.pipelineExecutionId,
          actionExecutionId: evidence.execution.actionExecutionId,
        },
        TARGET.targetKey,
      ),
      versionId: 'approval-evidence-object-id',
      sha256: sha256(evidenceBody),
    };

    const summary = renderCompactSavedPlanApprovalSummary({ evidence, evidenceReference }, TARGET.targetKey);

    expect(JSON.parse(summary)).toEqual({
      accountId: TARGET.accountId,
      deploymentEnvironment: 'develop',
      deploymentMode: 'none',
      disposition: 'REVIEWABLE',
      evidenceSha256: evidenceReference.sha256,
      evidenceVersionId: evidenceReference.versionId,
      reviewedPlanChecksum: evidence.contract.tfplanSha256,
      sourceSha: SOURCE_SHA,
    });
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(512);
  });

  it('does not render manual-approval evidence for an empty-plan skip', () => {
    const skip = expandedFixture({ lane: 'app', semanticChange: false });
    expect(() => buildExpandedSavedPlanApprovalEvidence(skip.input, TARGET.targetKey)).toThrow(/reviewable/u);

    const { input } = expandedFixture();
    const evidence = structuredClone(buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey));
    mutableRecord(evidence.contract)['disposition'] = 'EMPTY_PLAN_SKIP';
    const evidenceReference = {
      key: deriveSavedPlanApprovalEvidenceKey(
        {
          targetKey: evidence.target.targetKey,
          lane: evidence.target.lane,
          gate: evidence.target.gate,
          pipelineExecutionId: evidence.execution.pipelineExecutionId,
          actionExecutionId: evidence.execution.actionExecutionId,
        },
        TARGET.targetKey,
      ),
      versionId: 'approval-evidence-object-id',
      sha256: sha256(canonicalRecordJson(evidence)),
    };

    expect(() => renderCompactSavedPlanApprovalSummary({ evidence, evidenceReference }, TARGET.targetKey)).toThrow(
      /reviewable/u,
    );
  });

  it('rejects detached artifact, reviewer, and resolved-input evidence at compact admission', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const detachedArtifact = {
      ...evidence,
      artifact: { ...evidence.artifact, bucket: 'detached-artifact-bucket' },
    };
    const detachedReviewer = {
      ...evidence,
      reviewer: { ...evidence.reviewer, accountId: DETACHED_ACCOUNT_ID },
    };
    const widenedInputs = { ...evidence, resolvedInputs: {} };

    for (const detached of [detachedArtifact, detachedReviewer, widenedInputs]) {
      expect(() =>
        renderCompactSavedPlanApprovalSummary(
          {
            evidence: detached,
            evidenceReference: evidenceReferenceFor(detached),
          },
          TARGET.targetKey,
        ),
      ).toThrow();
    }
  });

  it('rejects source, deployment-mode, lane, and gate incoherence at compact admission', () => {
    const app = expandedFixture({ lane: 'app' });
    const appEvidence = buildExpandedSavedPlanApprovalEvidence(app.input, TARGET.targetKey);
    const detachedSource = {
      ...appEvidence,
      source: { ...appEvidence.source, selectedApplicationSourceSha: 'b'.repeat(40) },
    };
    const bootstrap = expandedFixture();
    const bootstrapEvidence = buildExpandedSavedPlanApprovalEvidence(bootstrap.input, TARGET.targetKey);
    const detachedMode = {
      ...bootstrapEvidence,
      contract: { ...bootstrapEvidence.contract, deploymentMode: 'normal' },
    };
    const detachedNonAppSource = {
      ...bootstrapEvidence,
      source: { ...bootstrapEvidence.source, selectedApplicationSourceSha: 'b'.repeat(40) },
    };
    const detachedGate = {
      ...bootstrapEvidence,
      target: { ...bootstrapEvidence.target, gate: 'verifier-preflight' },
    };

    for (const evidence of [detachedSource, detachedMode, detachedNonAppSource, detachedGate]) {
      expect(() =>
        renderCompactSavedPlanApprovalSummary(
          {
            evidence,
            evidenceReference: evidenceReferenceFor(evidence),
          },
          TARGET.targetKey,
        ),
      ).toThrow();
    }
  });

  it('admits a compact summary only by rebuilding it from exact expanded evidence', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const evidenceReference = {
      key: deriveSavedPlanApprovalEvidenceKey(
        {
          targetKey: evidence.target.targetKey,
          lane: evidence.target.lane,
          gate: evidence.target.gate,
          pipelineExecutionId: evidence.execution.pipelineExecutionId,
          actionExecutionId: evidence.execution.actionExecutionId,
        },
        TARGET.targetKey,
      ),
      versionId: 'approval-evidence-object-id',
      sha256: sha256(canonicalRecordJson(evidence)),
    };
    const compactSummary = renderCompactSavedPlanApprovalSummary({ evidence, evidenceReference }, TARGET.targetKey);

    expect(
      admitCompactSavedPlanApprovalSummary({ compactSummary, evidence, evidenceReference }, TARGET.targetKey),
    ).toBe(compactSummary);
    expect(() =>
      admitCompactSavedPlanApprovalSummary(
        {
          compactSummary: compactSummary.replace('REVIEWABLE', 'EMPTY_PLAN_SKIP'),
          evidence,
          evidenceReference,
        },
        TARGET.targetKey,
      ),
    ).toThrow('does not match');
  });

  it('rejects corrupt expanded references and oversized compact summaries', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const reference = evidenceReferenceFor(evidence);

    expect(() =>
      renderCompactSavedPlanApprovalSummary(
        {
          evidence,
          evidenceReference: { ...reference, key: `${reference.key}.detached` },
        },
        TARGET.targetKey,
      ),
    ).toThrow('key');
    expect(() =>
      renderCompactSavedPlanApprovalSummary(
        {
          evidence,
          evidenceReference: { ...reference, versionId: '' },
        },
        TARGET.targetKey,
      ),
    ).toThrow('VersionId');
    expect(() =>
      renderCompactSavedPlanApprovalSummary(
        {
          evidence,
          evidenceReference: { ...reference, sha256: '0'.repeat(64) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('canonical body');
    expect(() =>
      renderCompactSavedPlanApprovalSummary(
        {
          evidence,
          evidenceReference: evidenceReferenceFor(evidence, 'x'.repeat(300)),
        },
        TARGET.targetKey,
      ),
    ).toThrow('byte bound');
  });

  it('exact-admits compact-summary descriptors without invoking nested accessors or Proxies', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const evidenceReference = evidenceReferenceFor(evidence);
    const compactSummary = renderCompactSavedPlanApprovalSummary({ evidence, evidenceReference }, TARGET.targetKey);
    const getter = vi.fn(() => evidenceReference.sha256);
    const accessorReference = { ...evidenceReference };
    Object.defineProperty(accessorReference, 'sha256', { enumerable: true, get: getter });

    expect(() =>
      admitCompactSavedPlanApprovalSummary(
        { compactSummary, evidence, evidenceReference: accessorReference },
        TARGET.targetKey,
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      admitCompactSavedPlanApprovalSummary(
        {
          compactSummary,
          evidence: new Proxy(evidence, {}),
          evidenceReference,
        },
        TARGET.targetKey,
      ),
    ).toThrow('Proxy');
    expect(() =>
      admitCompactSavedPlanApprovalSummary(
        { compactSummary, evidence, evidenceReference, unexpected: true },
        TARGET.targetKey,
      ),
    ).toThrow('exact current shape');
  });

  it('admits only exact agreement between correspondence, expanded body, and compact summary', () => {
    const { input } = expandedFixture();
    const evidence = buildExpandedSavedPlanApprovalEvidence(input, TARGET.targetKey);
    const expandedBody = Buffer.from(canonicalRecordJson(evidence));
    const expandedReference = {
      key: deriveSavedPlanApprovalEvidenceKey(
        {
          targetKey: evidence.target.targetKey,
          lane: evidence.target.lane,
          gate: evidence.target.gate,
          pipelineExecutionId: evidence.execution.pipelineExecutionId,
          actionExecutionId: evidence.execution.actionExecutionId,
        },
        TARGET.targetKey,
      ),
      versionId: 'approval-evidence-object-id',
      sha256: sha256(expandedBody),
    };
    const compactSummary = renderCompactSavedPlanApprovalSummary(
      {
        evidence,
        evidenceReference: expandedReference,
      },
      TARGET.targetKey,
    );

    const agreement = admitSavedPlanApprovalAgreement(
      {
        compactSummary,
        correspondence: input.correspondence,
        expandedBody,
        expandedReference,
        pendingAction: input.pendingAction,
      },
      TARGET.targetKey,
    );

    expect(agreement).toEqual({ compactSummary, evidence, evidenceReference: expandedReference });
    expect(Object.isFrozen(agreement)).toBe(true);
    expect(Object.isFrozen(agreement.evidenceReference)).toBe(true);
  });

  it('rejects noncanonical, oversized, and checksum-detached stored evidence bodies', () => {
    const prepared = agreementFixture();
    const noncanonicalBody = Buffer.from(JSON.stringify(prepared.evidence));

    expect(() =>
      admitSavedPlanApprovalAgreement(
        {
          ...prepared.agreementInput,
          expandedBody: noncanonicalBody,
          expandedReference: { ...prepared.expandedReference, sha256: sha256(noncanonicalBody) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('canonical JSON');
    expect(() =>
      admitSavedPlanApprovalAgreement(
        {
          ...prepared.agreementInput,
          expandedBody: Buffer.alloc(1024 * 1024 + 1, 1),
        },
        TARGET.targetKey,
      ),
    ).toThrow('byte length');
    expect(() =>
      admitSavedPlanApprovalAgreement(
        {
          ...prepared.agreementInput,
          expandedReference: { ...prepared.expandedReference, sha256: '0'.repeat(64) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('exact stored bytes');
  });

  it('rejects untrusted expanded-body authority and pending-action substitutions', () => {
    const prepared = agreementFixture();
    const detachedEvidence = [
      {
        ...prepared.evidence,
        artifact: {
          ...prepared.evidence.artifact,
          metadata: { ...prepared.evidence.artifact.metadata, etag: 'unquoted-etag' },
        },
      },
      {
        ...prepared.evidence,
        reviewer: { ...prepared.evidence.reviewer, accountId: DETACHED_ACCOUNT_ID },
      },
      { ...prepared.evidence, resolvedInputs: {} },
      { ...prepared.evidence, correspondenceSha256: '0'.repeat(64) },
      {
        ...prepared.evidence,
        source: { ...prepared.evidence.source, controlSourceSha: 'b'.repeat(40) },
      },
      {
        ...prepared.evidence,
        execution: {
          ...prepared.evidence.execution,
          pipelineExecutionId: '99999999-8888-7777-6666-555555555555',
        },
      },
      {
        ...prepared.evidence,
        execution: { ...prepared.evidence.execution, stageName: 'DetachedApproval' },
      },
      {
        ...prepared.evidence,
        execution: {
          ...prepared.evidence.execution,
          actionExecutionId: '99999999-8888-7777-6666-555555555555',
        },
      },
    ];

    for (const evidence of detachedEvidence) {
      const expandedBody = Buffer.from(canonicalRecordJson(evidence));
      expect(() =>
        admitSavedPlanApprovalAgreement(
          {
            ...prepared.agreementInput,
            expandedBody,
            expandedReference: evidenceReferenceFor(evidence),
          },
          TARGET.targetKey,
        ),
      ).toThrow();
    }
  });

  it('rejects altered correspondence, review state, pending observation, references, and compact text', () => {
    const prepared = agreementFixture();
    const changedStateEvidence = {
      ...prepared.evidence,
      review: {
        ...prepared.evidence.review,
        state: { ...prepared.evidence.review.state, versionId: 'detached-state-object-id' },
      },
    };
    const changedStateBody = Buffer.from(canonicalRecordJson(changedStateEvidence));
    const changedPending = {
      ...prepared.input.pendingAction,
      actionExecutionId: '99999999-8888-7777-6666-555555555555',
    };
    const candidates: unknown[] = [
      {
        ...prepared.agreementInput,
        correspondence: {
          ...prepared.input.correspondence,
          manifestBody: Buffer.from(`${Buffer.from(prepared.input.correspondence.manifestBody).toString('utf8')} `),
        },
      },
      {
        ...prepared.agreementInput,
        expandedBody: changedStateBody,
        expandedReference: evidenceReferenceFor(changedStateEvidence),
      },
      { ...prepared.agreementInput, pendingAction: changedPending },
      {
        ...prepared.agreementInput,
        expandedReference: { ...prepared.expandedReference, key: `${prepared.expandedReference.key}.detached` },
      },
      {
        ...prepared.agreementInput,
        expandedReference: { ...prepared.expandedReference, versionId: 'detached-object-id' },
      },
      { ...prepared.agreementInput, compactSummary: `${prepared.compactSummary} ` },
    ];

    for (const candidate of candidates) {
      expect(() => admitSavedPlanApprovalAgreement(candidate, TARGET.targetKey)).toThrow();
    }
  });

  it('exact-admits agreement descriptors without reading accessors or Proxies', () => {
    const prepared = agreementFixture();
    const getter = vi.fn(() => prepared.expandedBody);
    const accessor = { ...prepared.agreementInput };
    Object.defineProperty(accessor, 'expandedBody', { enumerable: true, get: getter });

    expect(() => admitSavedPlanApprovalAgreement(accessor, TARGET.targetKey)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => admitSavedPlanApprovalAgreement(new Proxy(prepared.agreementInput, {}), TARGET.targetKey)).toThrow(
      'Proxy',
    );
    expect(() =>
      admitSavedPlanApprovalAgreement({ ...prepared.agreementInput, [Symbol('hidden')]: true }, TARGET.targetKey),
    ).toThrow();
  });

  it('captures agreement bytes atomically without invoking byte-shell accessors or accepting shared memory', () => {
    const prepared = agreementFixture();
    const byteLengthGetter = vi.fn(() => prepared.expandedBody.byteLength);
    class AccessorBytes extends Uint8Array {
      override get byteLength() {
        return byteLengthGetter();
      }
    }
    const accessorBytes = new AccessorBytes(prepared.expandedBody);
    const sharedBytes = new Uint8Array(new SharedArrayBuffer(prepared.expandedBody.byteLength));
    sharedBytes.set(prepared.expandedBody);
    const rawBytes = new Set<unknown>([
      prepared.expandedBody,
      prepared.input.correspondence.manifestBody,
      prepared.input.correspondence.files.tfplan,
      prepared.input.correspondence.files.tfplanJson,
    ]);
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');

    try {
      expect(admitSavedPlanApprovalAgreement(prepared.agreementInput, TARGET.targetKey).evidence).toEqual(
        prepared.evidence,
      );
      expect(ownKeys.mock.calls.some(([value]) => rawBytes.has(value))).toBe(false);
      expect(() =>
        admitSavedPlanApprovalAgreement({ ...prepared.agreementInput, expandedBody: accessorBytes }, TARGET.targetKey),
      ).toThrow('byte-array shell');
      expect(byteLengthGetter).not.toHaveBeenCalled();
      expect(() =>
        admitSavedPlanApprovalAgreement({ ...prepared.agreementInput, expandedBody: sharedBytes }, TARGET.targetKey),
      ).toThrow('shared memory');
    } finally {
      ownKeys.mockRestore();
    }
  });
});

it('binds production approval evidence, reviewer, and saved-plan agreement to the selected target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const authority = await import('./saved-plan-approval-evidence.js');
    const fixtures = await import('./testdata/saved-plan-fixture.js');
    const productionKey = 'stark-prod/main';
    for (const options of [
      { lane: 'bootstrap' },
      { lane: 'foundation' },
      { lane: 'app' },
      { lane: 'app', gate: 'verifier-preflight' },
      { lane: 'app', deploymentMode: 'rollback', selectedSourceSha: 'b'.repeat(40) },
      { lane: 'app', semanticChange: false },
    ] as const) {
      const prepared = fixtures.buildSavedPlanFixture({ ...options, targetKey: productionKey });
      const development = fixtures.buildSavedPlanFixture(options);
      const input = {
        correspondence: prepared.correspondence,
        review: prepared.review,
        artifactObservation: prepared.artifactObservation,
        pendingAction: prepared.pendingAction,
        reviewerIdentity: prepared.reviewerIdentity,
      };
      const material = { correspondence: input.correspondence, review: input.review };
      expect(authority.admitSavedPlanReviewMaterial(material, productionKey).review).toEqual(input.review);
      const evidence = authority.buildExpandedSavedPlanApprovalEvidence(input, productionKey);
      const keyInput = {
        targetKey: productionKey,
        lane: evidence.target.lane,
        gate: evidence.target.gate,
        pipelineExecutionId: evidence.execution.pipelineExecutionId,
        actionExecutionId: evidence.execution.actionExecutionId,
      };
      const key = authority.deriveSavedPlanApprovalEvidenceKey(keyInput, productionKey);
      expect(authority.admitSavedPlanApprovalEvidenceKey(key, productionKey)).toBe(key);
      const body = Buffer.from(canonicalRecordJson(evidence));
      const reference = { key, versionId: 'production-approval-version', sha256: sha256(body) };
      const compactInput = { evidence, evidenceReference: reference };
      const compactSummary = authority.renderCompactSavedPlanApprovalSummary(compactInput, productionKey);
      expect(Buffer.byteLength(compactSummary)).toBeLessThanOrEqual(512);
      expect(JSON.parse(compactSummary)).toMatchObject({ deploymentEnvironment: 'main', disposition: 'REVIEWABLE' });
      const compactAdmission = { ...compactInput, compactSummary };
      expect(authority.admitCompactSavedPlanApprovalSummary(compactAdmission, productionKey)).toBe(compactSummary);
      const agreement = {
        compactSummary,
        correspondence: input.correspondence,
        expandedBody: body,
        expandedReference: reference,
        pendingAction: input.pendingAction,
      };
      expect(authority.admitSavedPlanApprovalAgreement(agreement, productionKey).evidence).toEqual(evidence);
      for (const field of ['backendKey', 'stateIdentity', 'state'] as const) {
        const mixed = structuredClone(evidence);
        const review = mutableRecord(mixed.review);
        if (field === 'state') review['state'] = development.review.state;
        else mutableRecord(review['context'])[field] = development.review.context[field];
        review['reviewDigest'] = canonicalJsonSha256({
          context: review['context'],
          artifact: review['artifact'],
          state: review['state'],
          summary: review['summary'],
          approval: review['approval'],
          authority: review['authority'],
        });
        mutableRecord(mixed.contract)['reviewDigest'] = review['reviewDigest'];
        const mixedReference = { ...reference, sha256: sha256(canonicalRecordJson(mixed)) };
        const mixedSummary = JSON.stringify({ ...JSON.parse(compactSummary), evidenceSha256: mixedReference.sha256 });
        expect(() =>
          authority.renderCompactSavedPlanApprovalSummary(
            { evidence: mixed, evidenceReference: mixedReference },
            productionKey,
          ),
        ).toThrow();
        expect(() =>
          authority.admitCompactSavedPlanApprovalSummary(
            { evidence: mixed, evidenceReference: mixedReference, compactSummary: mixedSummary },
            productionKey,
          ),
        ).toThrow();
      }
      for (const wrongTarget of [undefined, 'unreviewed/main', TARGET.targetKey]) {
        expect(() => authority.admitSavedPlanReviewMaterial(material, wrongTarget)).toThrow();
        expect(() => authority.buildExpandedSavedPlanApprovalEvidence(input, wrongTarget)).toThrow();
        expect(() => authority.deriveSavedPlanApprovalEvidenceKey(keyInput, wrongTarget)).toThrow();
        expect(() => authority.admitSavedPlanApprovalEvidenceKey(key, wrongTarget)).toThrow();
        expect(() => authority.renderCompactSavedPlanApprovalSummary(compactInput, wrongTarget)).toThrow();
        expect(() => authority.admitCompactSavedPlanApprovalSummary(compactAdmission, wrongTarget)).toThrow();
        expect(() => authority.admitSavedPlanApprovalAgreement(agreement, wrongTarget)).toThrow();
      }
      for (const field of ['correspondence', 'review', 'artifactObservation', 'reviewerIdentity'] as const) {
        expect(() =>
          authority.buildExpandedSavedPlanApprovalEvidence({ ...input, [field]: development[field] }, productionKey),
        ).toThrow();
      }
      if (options.lane === 'bootstrap') {
        expect(() =>
          authority.buildExpandedSavedPlanApprovalEvidence(
            { ...input, pendingAction: development.pendingAction },
            productionKey,
          ),
        ).toThrow();
      }
      expect(() =>
        authority.admitSavedPlanApprovalAgreement(
          { ...agreement, correspondence: development.correspondence },
          productionKey,
        ),
      ).toThrow();
      expect(() =>
        authority.admitSavedPlanApprovalAgreement(
          { ...agreement, expandedBody: Buffer.concat([body, Buffer.from(' ')]) },
          productionKey,
        ),
      ).toThrow();
      expect(() =>
        authority.admitSavedPlanApprovalAgreement(
          {
            ...agreement,
            pendingAction: { ...input.pendingAction, actionExecutionId: '33333333-4444-4555-8666-777777777777' },
          },
          productionKey,
        ),
      ).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
