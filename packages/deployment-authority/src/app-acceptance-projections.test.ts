import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_ATTEMPT_ID,
  ACCEPTED_AT,
  APP_SOURCE_SHA,
  PIPELINE_EXECUTION_ID,
  createAppAcceptanceFixture,
  createBoundSelectionFixture,
} from './testdata/app-acceptance-ledger-fixture.js';
import {
  bindAppAcceptanceSelection,
  deriveAppAcceptanceRecordKey,
  projectInitialAppAcceptancePointer,
} from './app-acceptance-ledger.js';
import {
  projectAppAcceptanceEvent,
  projectAppCurrentRecoveryAuthority,
  projectAppRollbackAuthority,
  projectAppStaticFastAuthority,
  projectAppTerraformDriftAuthority,
  projectRetainedAppImageAuthority,
} from './app-acceptance-projections.js';
import { canonicalRecordJson, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const appAuthority = resolveDeploymentLaneAuthority(target, 'app');

function createRecoverySelectionFixture() {
  const candidate = structuredClone(createAppAcceptanceFixture()) as Record<string, unknown>;
  const nonsecret = candidate['nonsecretInputs'] as Record<string, unknown>;
  const files = nonsecret['files'] as Array<Record<string, unknown>>;
  const values = JSON.parse(Buffer.from(String(files[0]?.['contentBase64']), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
  const recoveryId = '6'.repeat(64);
  const manifestSha256 = '7'.repeat(64);
  values['dynamodb_recovery_phase'] = 'primary_quiesced';
  values['dynamodb_recovery_activation'] = {
    account_alias: target.accountLabel,
    account_id: target.accountId,
    deployment_environment: target.environmentId,
    kms_key_arn: (candidate['backend'] as Readonly<Record<string, unknown>>)['kmsKeyArn'],
    manifest_sha256: manifestSha256,
    manifest_type: 'dynamodb-recovery-activation',
    recovery_id: recoveryId,
    recovery_point: '2026-08-14T00:00:00.000Z',
    region: target.region,
    sessions: {
      key_schema: 'sessionId:S',
      source_table_arn: 'sessions-source',
      table_arn: 'sessions-replacement',
      table_name: 'sessions-replacement',
    },
    validation_status: 'validated',
    votes: {
      key_schema: 'sessionId:S,voteIndex:N',
      source_table_arn: 'votes-source',
      table_arn: 'votes-replacement',
      table_name: 'votes-replacement',
      vote_id_index_schema: 'voteId:S',
    },
  };
  const body = canonicalRecordJson(values);
  candidate['nonsecretInputs'] = {
    ...nonsecret,
    files: [
      {
        path: 'pipeline.auto.tfvars.json',
        sha256: createHash('sha256').update(body).digest('hex'),
        contentBase64: Buffer.from(body).toString('base64'),
      },
    ],
  };
  candidate['runtime'] = {
    ...(candidate['runtime'] as Readonly<Record<string, unknown>>),
    dynamodbRecovery: {
      phase: 'primary_quiesced',
      manifest: {
        key: `${appAuthority.names.recoveryManifestPrefix}/${recoveryId}.json`,
        versionId: 'recovery-manifest-version',
        sha256: manifestSha256,
      },
    },
  };
  const acceptanceKey = deriveAppAcceptanceRecordKey(candidate, 'stark-dev/develop');
  const pointer = projectInitialAppAcceptancePointer(
    {
      history: [acceptanceKey],
      predecessor: { etag: 'captured-etag', versionId: 'captured-version' },
    },
    'stark-dev/develop',
  );
  return bindAppAcceptanceSelection(
    {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-version' },
      recordKey: acceptanceKey,
      record: candidate,
      recordObservation: { etag: 'record-etag', versionId: 'record-version' },
    },
    'stark-dev/develop',
  );
}

describe('App acceptance consumer projections', () => {
  it('projects the current acceptance into the complete report-only Terraform drift authority', () => {
    const selection = createBoundSelectionFixture('current');

    const projected = projectAppTerraformDriftAuthority(selection, 'stark-dev/develop');

    expect(projected).toEqual({
      authorityType: 'app-terraform-drift-authority',
      targetKey: 'stark-dev/develop',
      acceptanceKey: selection.acceptanceKey,
      acceptedAt: ACCEPTED_AT,
      controlSourceSha: APP_SOURCE_SHA,
      selectedApplicationSourceSha: APP_SOURCE_SHA,
      deploymentMode: 'normal',
      targetContext: selection.acceptance.targetContext,
      backend: selection.acceptance.backend,
      nonsecretInputs: selection.acceptance.nonsecretInputs,
      secretReferences: selection.acceptance.secretReferences,
      provider: selection.acceptance.provider,
      acceptedPlanChecksum: selection.acceptance.acceptedPlanChecksum,
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.nonsecretInputs)).toBe(true);
  });

  it('projects either current or retained acceptance into the key-only image-retention authority', () => {
    const current = createBoundSelectionFixture('current');
    const retained = createBoundSelectionFixture('retained');

    for (const selection of [current, retained]) {
      const projected = projectRetainedAppImageAuthority(selection, 'stark-dev/develop');
      expect(projected).toEqual({
        authorityType: 'retained-app-image-authority',
        targetKey: 'stark-dev/develop',
        acceptanceKey: selection.acceptanceKey,
        toolchainReleaseKey: selection.acceptance.releaseAuthority['toolchainReleaseKey'],
        proverReleaseKey: selection.acceptance.releaseAuthority['proverReleaseKey'],
        toolchainImage: selection.acceptance.releaseAuthority['toolchainImage'],
        proverImage: selection.acceptance.releaseAuthority['proverImage'],
      });
      expect(JSON.stringify(projected)).not.toContain('current.json');
    }
  });

  it('projects only the current acceptance into the closed deterministic operations event', () => {
    const selection = createBoundSelectionFixture('current');

    const projected = projectAppAcceptanceEvent(selection, 'stark-dev/develop');

    expect(projected).toEqual({
      source: 'stark-ballot.observability',
      detailType: 'Accepted Deployment',
      eventBusName: 'default',
      detail: {
        ts: ACCEPTED_AT,
        event_type: 'deployment_accepted',
        env: 'develop',
        deployment_id: selection.acceptance.deploymentId,
        deployment_mode: 'normal',
        pipeline_execution_id: PIPELINE_EXECUTION_ID,
        plan_disposition: 'changed',
        resource_name: 'app',
        state: 'ACCEPTED',
      },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(selection.acceptanceKey);
    expect(serialized).not.toContain(APP_SOURCE_SHA);
    expect(serialized).not.toContain(selection.acceptance.acceptanceAttemptId);
    expect(serialized).not.toContain(selection.acceptance.targetContext.target.accountId);
  });

  it('projects only the current acceptance into canonical static-fast retained inputs', () => {
    const selection = createBoundSelectionFixture('current');
    const attemptPrefix =
      `${appAuthority.names.acceptedDeploymentPrefix}/executions/${PIPELINE_EXECUTION_ID}/attempts/` +
      ACCEPTANCE_ATTEMPT_ID;
    const staticFrontend = selection.acceptance.deployables['staticFrontend'] as Readonly<Record<string, unknown>>;

    const projected = projectAppStaticFastAuthority(selection, 'stark-dev/develop');

    expect(projected).toEqual({
      authorityType: 'app-static-fast-authority',
      targetKey: 'stark-dev/develop',
      acceptanceKey: selection.acceptanceKey,
      acceptanceObservation: selection.acceptanceObservation,
      selectedApplicationSourceSha: APP_SOURCE_SHA,
      deploymentId: selection.acceptance.deploymentId,
      applyOutputsPath: `${attemptPrefix}/apply-outputs.json`,
      applyOutputsSha256: selection.acceptance.runtime['applyOutputsSha256'],
      imageIdMappingSha256: (selection.acceptance.releaseAuthority['zkvm'] as Readonly<Record<string, unknown>>)[
        'imageIdMappingSha256'
      ],
      staticFrontendArtifactSha256: staticFrontend['artifactSha256'],
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.acceptanceObservation)).toBe(true);
    expect(() => projectAppStaticFastAuthority(createBoundSelectionFixture('retained'), 'stark-dev/develop')).toThrow(
      /current/iu,
    );
  });

  it('projects only the current acceptance recovery phase and exact manifest reference', () => {
    const selection = createBoundSelectionFixture('current');

    const projected = projectAppCurrentRecoveryAuthority(selection, 'stark-dev/develop');

    expect(projected).toEqual({
      authorityType: 'app-current-recovery-authority',
      targetKey: 'stark-dev/develop',
      acceptanceKey: selection.acceptanceKey,
      current: { phase: 'primary_active', manifest: null },
    });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() =>
      projectAppCurrentRecoveryAuthority(createBoundSelectionFixture('retained'), 'stark-dev/develop'),
    ).toThrow(/current/iu);

    const recovery = createRecoverySelectionFixture();
    const retainedManifest = recovery.acceptance.runtime['dynamodbRecovery'] as Readonly<Record<string, unknown>>;
    expect(projectAppCurrentRecoveryAuthority(recovery, 'stark-dev/develop')).toEqual({
      authorityType: 'app-current-recovery-authority',
      targetKey: 'stark-dev/develop',
      acceptanceKey: recovery.acceptanceKey,
      current: { phase: 'primary_quiesced', manifest: retainedManifest['manifest'] },
    });
    expect(Object.isFrozen(projectAppCurrentRecoveryAuthority(recovery, 'stark-dev/develop').current)).toBe(true);
    expect(Object.isFrozen(projectAppCurrentRecoveryAuthority(recovery, 'stark-dev/develop').current['manifest'])).toBe(
      true,
    );
  });

  it('projects only a retained selection into complete forward rollback authority', () => {
    const retained = createBoundSelectionFixture('retained');

    const projected = projectAppRollbackAuthority(retained, 'stark-dev/develop');

    expect(projected).toEqual({
      authorityType: 'app-rollback-authority',
      targetKey: 'stark-dev/develop',
      selectedAcceptanceKey: retained.acceptanceKey,
      acceptedAt: retained.acceptance.acceptedAt,
      controlSourceSha: retained.acceptance.controlSourceSha,
      selectedApplicationSourceSha: retained.acceptance.selectedApplicationSourceSha,
      deploymentId: retained.acceptance.deploymentId,
      staticArtifactDeploymentId: retained.acceptance.deploymentId,
      deploymentMode: retained.acceptance.deploymentMode,
      targetContext: retained.acceptance.targetContext,
      backend: retained.acceptance.backend,
      nonsecretInputs: retained.acceptance.nonsecretInputs,
      secretReferences: retained.acceptance.secretReferences,
      provider: retained.acceptance.provider,
      acceptedPlanChecksum: retained.acceptance.acceptedPlanChecksum,
      releaseAuthority: retained.acceptance.releaseAuthority,
      verifier: retained.acceptance.verifier,
      deployables: retained.acceptance.deployables,
      runtime: retained.acceptance.runtime,
    });
    expect(Object.isFrozen(projected.releaseAuthority)).toBe(true);
    expect(() => projectAppRollbackAuthority(createBoundSelectionFixture('current'), 'stark-dev/develop')).toThrow(
      /retained/iu,
    );
  });

  it('rejects historical drift/events and descriptor-hostile selections without property reads', () => {
    const retained = createBoundSelectionFixture('retained');
    expect(() => projectAppTerraformDriftAuthority(retained, 'stark-dev/develop')).toThrow(/current/iu);
    expect(() => projectAppAcceptanceEvent(retained, 'stark-dev/develop')).toThrow(/current/iu);
    expect(() => projectAppStaticFastAuthority(retained, 'stark-dev/develop')).toThrow(/current/iu);
    expect(() => projectAppCurrentRecoveryAuthority(retained, 'stark-dev/develop')).toThrow(/current/iu);

    let propertyReads = 0;
    const hostile = new Proxy(createBoundSelectionFixture('current'), {
      get() {
        propertyReads += 1;
        return 'swapped';
      },
    });
    expect(projectAppAcceptanceEvent(hostile, 'stark-dev/develop')).toEqual(
      projectAppAcceptanceEvent(createBoundSelectionFixture('current'), 'stark-dev/develop'),
    );
    expect(projectAppStaticFastAuthority(hostile, 'stark-dev/develop')).toEqual(
      projectAppStaticFastAuthority(createBoundSelectionFixture('current'), 'stark-dev/develop'),
    );
    expect(projectAppCurrentRecoveryAuthority(hostile, 'stark-dev/develop')).toEqual(
      projectAppCurrentRecoveryAuthority(createBoundSelectionFixture('current'), 'stark-dev/develop'),
    );
    expect(propertyReads).toBe(0);

    const unexpected = { ...createBoundSelectionFixture('current'), compatibilityFallback: true };
    expect(() => projectAppStaticFastAuthority(unexpected, 'stark-dev/develop')).toThrow(/exact current shape/iu);
    expect(() => projectAppCurrentRecoveryAuthority(unexpected, 'stark-dev/develop')).toThrow(/exact current shape/iu);
  });
});
