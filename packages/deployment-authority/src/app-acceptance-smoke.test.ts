import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalJsonSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  type AllowedDeploymentTarget,
} from './index.js';
import { admitAppAcceptanceSmokeReport } from './app-acceptance-smoke.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const app = resolveDeploymentLaneAuthority(target, 'app');
const selectedSourceSha = 'a'.repeat(40);
const normalPipelineExecutionId = '11111111-2222-4333-8444-555555555555';
const historicalPipelineExecutionId = '99999999-8888-4777-8666-555555555555';
const acceptanceAttemptId = '22222222-3333-4444-8555-666666666666';
const selectedDeploymentId = `dep_${'7'.repeat(32)}`;
const staticArtifactDeploymentId = `dep_${'8'.repeat(32)}`;
const deploymentIdentityAuthoritySha256 = '1'.repeat(64);
const appExecutionAuthoritySha256 = '0'.repeat(64);
const deploymentId = `dep_${deploymentIdentityAuthoritySha256.slice(0, 32)}`;
const retainedArtifactBasenames = {
  applyOutputsPath: 'apply-outputs.json',
  denialSmokePath: 'app-smoke-denial-evidence.json',
  deploymentIdentityPath: 'deployment-identity.json',
  dynamodbDataPlaneSmokePath: 'app-smoke-dynamodb-data-plane-evidence.json',
  dynamodbRecoveryPhaseSmokePath: 'app-smoke-dynamodb-recovery-phase-evidence.json',
  dynamodbRecoverySelectionPath: 'dynamodb-recovery-selection.json',
  imageSignatureVerifierApplyIdentityPath: 'image-signature-verifier-apply-identity.json',
  imageSignatureVerifierPlanIdentityPath: 'image-signature-verifier-plan-identity.json',
  imageSignatureVerifierSmokeIdentityPath: 'image-signature-verifier-smoke-identity.json',
  mutationDenialSimulationPath: 'app-smoke-mutation-denial-simulation.json',
  planChecksumPath: 'tfplan.sha256',
  planEmptyPath: 'app-plan-empty.json',
  planJsonPath: 'tfplan.json',
  planPath: 'tfplan',
  planSummaryPath: 'tfplan.txt',
  rollbackSelectionPath: 'rollback-selection.json',
  smokeCallerPath: 'app-smoke-caller.json',
  smokeDeclaredBlocksPath: 'app-smoke-declared-blocks.txt',
  smokeReportPath: 'app-smoke-report.json',
  smokeTerraformFilesPath: 'app-smoke-terraform-files.txt',
  sourcePreflightPath: 'source-preflight.json',
  stateDenialSimulationPath: 'app-smoke-state-denial-simulation.json',
  staticFrontendDeployPath: 'static-frontend-deploy.json',
  targetLambdaArtifactsPath: 'target-lambda-artifacts.json',
  terraformProvidersPath: 'terraform-providers.txt',
  terraformVersionPath: 'terraform-version.json',
} as const;
const lambdaArtifactNames = [
  'public_api',
  'finalization_writer',
  'proof_dispatcher',
  'verification_worker',
  'image_signature_verifier',
  'semaphore_janitor',
] as const;

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} fixture is not a record`);
  }
  return value as Record<string, unknown>;
}

function immutableReference(key: string, fill: string) {
  return { key, versionId: `version-${fill}`, sha256: fill.repeat(64) };
}

function buildAppSmokeReportFixture(
  options: {
    mode: 'normal' | 'rollback';
    controlSourceSha: string;
    selectedSourceSha: string;
    pipelineExecutionId: string;
    acceptanceAttemptId: string;
  },
  authorities: { target: AllowedDeploymentTarget; app: typeof app } = { target, app },
): Record<string, unknown> {
  const { target, app } = authorities;
  const attemptPrefix =
    `${app.names.acceptedDeploymentPrefix}/executions/${options.pipelineExecutionId}/attempts/` +
    options.acceptanceAttemptId;
  const retainedDeploymentArtifacts = Object.fromEntries(
    Object.entries(retainedArtifactBasenames).map(([field, basename]) => [field, `${attemptPrefix}/${basename}`]),
  ) as Record<string, string>;
  retainedDeploymentArtifacts['approvalEvidencePath'] =
    `${app.names.approvalEvidencePrefix}/${options.pipelineExecutionId}.json`;
  const functionArn =
    `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:` +
    app.names.signatureVerifierFunction;
  const proverImageUri =
    `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/` +
    `${app.names.proverRepository}@sha256:${'a'.repeat(64)}`;
  const verifierPackage = {
    s3_bucket: app.names.appRetainedArtifactBucket,
    s3_key: `${app.names.lambdaArtifactPrefix}/${options.selectedSourceSha}/image-signature-verifier.zip`,
    s3_object_version: 'package-version',
    source_code_hash: Buffer.from('6'.repeat(64), 'hex').toString('base64'),
    sha256: '6'.repeat(64),
    asset_manifest_sha256: '7'.repeat(64),
    trust_root_sha256: '8'.repeat(64),
  };
  const verifier = {
    functionArn,
    functionVersion: '1',
    preflightAliasArn: `${functionArn}:preflight`,
    runtimeAliasArn: `${functionArn}:runtime`,
    architecture: 'x86_64',
    runtime: 'nodejs24.x',
    timeoutSeconds: 120,
    environmentSha256: '1'.repeat(64),
    functionConfigurationSha256: '2'.repeat(64),
    executionRoleArn: `arn:${target.partition}:iam::${target.accountId}:role/${app.names.signatureVerifierRole}`,
    executionRoleAssumePolicySha256: '3'.repeat(64),
    executionRolePolicySha256: '4'.repeat(64),
    executionRolePermissionsBoundaryArn:
      `arn:${target.partition}:iam::${target.accountId}:policy/` + app.names.signatureVerifierPermissionsBoundary,
    executionRolePermissionsBoundaryPolicySha256: '5'.repeat(64),
    package: verifierPackage,
  };
  const preflight = {
    evidenceType: 'app-image-signature-preflight-validation',
    sourceSha: options.selectedSourceSha,
    selectedSourceSha: options.selectedSourceSha,
    proverImageUri,
    signingProfileArn:
      `arn:${target.partition}:signer:${target.region}:${target.accountId}:/signing-profiles/` +
      app.names.signerProfile,
    trustPolicySha256: '9'.repeat(64),
    verifierVersion: 'fixture-verifier',
    evidence: immutableReference(
      `${app.names.signaturePreflightPrefix}/executions/${options.pipelineExecutionId}/attempts/` +
        `${'a'.repeat(64)}/verification.json`,
      'a',
    ),
    verifier,
  };
  const lambdaArtifacts = Object.fromEntries(
    lambdaArtifactNames.map((name, index) => {
      if (name === 'image_signature_verifier') return [name, verifierPackage];
      const artifactSha256 = String(index + 1).repeat(64);
      return [
        name,
        {
          s3_bucket: app.names.appRetainedArtifactBucket,
          s3_key: `${app.names.lambdaArtifactPrefix}/${options.selectedSourceSha}/${name}.zip`,
          s3_object_version: `${name}-version`,
          source_code_hash: Buffer.from(artifactSha256, 'hex').toString('base64'),
          sha256: artifactSha256,
        },
      ];
    }),
  );
  const staticFrontend = {
    bucket: app.names.appRetainedArtifactBucket,
    key: `${app.names.staticFrontendArtifactPrefix}/${options.selectedSourceSha}/${deploymentId}/` + 'dist.tar.gz',
    versionId: 'static-frontend-version',
    sha256: 'c'.repeat(64),
    artifactSha256: 'd'.repeat(64),
  };
  const releaseEvidence = {
    appExecutionAuthoritySha256,
    imageArchitectures: { prover: 'arm64', toolchain: 'arm64' },
    failureMarkerSmokeStatus: 'PASS',
    imageSignaturePreflight: preflight,
    imageSignatureVerifierIdentity: {
      planPath: retainedDeploymentArtifacts['imageSignatureVerifierPlanIdentityPath'],
      applyPath: retainedDeploymentArtifacts['imageSignatureVerifierApplyIdentityPath'],
      smokePath: retainedDeploymentArtifacts['imageSignatureVerifierSmokeIdentityPath'],
      identitySha256: 'f'.repeat(64),
    },
  };
  const retainedDeployables = {
    lambdaArtifacts: {
      manifestType: 'app-lambda-artifact-set',
      sourceSha: options.selectedSourceSha,
      bucket: app.names.appRetainedArtifactBucket,
      prefix: `${app.names.lambdaArtifactPrefix}/${options.selectedSourceSha}`,
      artifacts: lambdaArtifacts,
      proverImageUri,
      expectedImageId: `0x${'7'.repeat(64)}`,
      imageIdMappingEvidence: { mappingSha256: 'f'.repeat(64) },
    },
    staticFrontend,
  };
  return {
    reportType: 'app-smoke-report',
    sourceSha: options.selectedSourceSha,
    selectedSourceSha: options.selectedSourceSha,
    controlSourceSha: options.controlSourceSha,
    deploymentMode: options.mode,
    dynamodbRecoveryPhase: 'primary_active',
    deploymentEnvironment: target.environmentId,
    pipelineExecutionId: options.pipelineExecutionId,
    acceptanceAttemptId: options.acceptanceAttemptId,
    deploymentId,
    deploymentIdentityAuthoritySha256,
    accountId: target.accountId,
    stateIdentity: app.stateIdentity,
    backendKey: app.backendKey,
    planChecksum: '2'.repeat(64),
    planEmpty: false,
    resourceChangeCount: 1,
    outputChangeCount: 0,
    movedResourceChangeCount: 0,
    importingResourceChangeCount: 0,
    manualApprovalSkipped: false,
    approvalReason: 'manual-approval',
    approvalEvidence: {
      path: `${app.names.approvalEvidencePrefix}/${options.pipelineExecutionId}.json`,
      versionId: 'approval-version',
      sha256: '4'.repeat(64),
    },
    applyOutputsPath: retainedDeploymentArtifacts['applyOutputsPath'],
    applyOutputsSha256: '5'.repeat(64),
    releaseEvidence,
    retainedDeployables,
    dynamodbRecoverySelection: {
      selectionType: 'dynamodb-recovery',
      phase: 'primary_active',
      quiesced: false,
      servesReplacement: false,
      enabled: false,
    },
    dynamodbRecoveryPhaseEvidence: {
      evidenceType: 'dynamodb-recovery-phase-smoke',
      phase: 'primary_active',
      quiesced: false,
      servesReplacement: false,
      admissionEnabled: true,
      eventSourceMappingsEnabled: true,
      manifest: null,
      checks: {
        selectionMatchesOutput: true,
        servedPairMatchesPhase: true,
        admissionMatchesPhase: true,
        liveAdmissionMatchesOutput: true,
        manifestMatchesSelectionAndOutput: true,
        liveStoreLambdaConfigsMatchServedPair: true,
        eventSourceMappingDesiredStateMatchesPhase: true,
        liveEventSourceMappingsMatchDesiredState: true,
      },
    },
    rollbackSelection: options.mode === 'rollback' ? {} : null,
    staticFrontendDeploy: {
      path: retainedDeploymentArtifacts['staticFrontendDeployPath'],
      frontendBucketName: app.names.frontendBucket,
      cloudfrontDistributionId: 'E123FIXTURE',
      cloudfrontDistributionDomain: 'fixture.cloudfront.net',
      operatorGateEnabled: target.environmentId === 'develop',
      artifactSha256: staticFrontend.artifactSha256,
      publicFrontendConfigSha256: 'e'.repeat(64),
      imageIdMapping: { deployedPath: '/imageId-mapping.json', cacheControl: 'no-cache', sha256: 'f'.repeat(64) },
      stablePublicAssets: {
        paths: ['/patterns/*', '/textures/*'],
        cacheControl: 'public,max-age=300',
        cloudFrontCachePolicy: 'frontend_app_shell',
      },
      invalidationId: 'fixture-invalidation',
    },
    retainedDeploymentArtifacts,
    callerArn: `arn:${target.partition}:sts::${target.accountId}:assumed-role/${app.names.terraformSmokeRole}/fixture`,
    checks: {
      expectedSmokeRole: `arn:${target.partition}:sts::${target.accountId}:assumed-role/${app.names.terraformSmokeRole}/*`,
      applyOutputsMatchExpectedState: true,
      applyOutputsPresent: true,
      dynamodbDataPlaneSmokePassed: true,
      dynamodbRecoveryPhaseSmokePassed: true,
      mutationAccessDenied: true,
      runtimeResourcesCreated: true,
      stateAccessDenied: true,
      targetRuntimeOutputsPresent: true,
    },
  };
}

function fixture(
  mode: 'normal' | 'rollback',
  authorities: { target: AllowedDeploymentTarget; app: typeof app } = { target, app },
) {
  const { target, app } = authorities;
  const report = buildAppSmokeReportFixture(
    {
      mode,
      controlSourceSha: mode === 'normal' ? selectedSourceSha : 'b'.repeat(40),
      selectedSourceSha,
      pipelineExecutionId: normalPipelineExecutionId,
      acceptanceAttemptId,
    },
    authorities,
  );
  const release = mutableRecord(report['releaseEvidence'], 'release evidence');
  const preflight = mutableRecord(release['imageSignaturePreflight'], 'signature preflight');
  const verifier = mutableRecord(preflight['verifier'], 'signature verifier');
  const functionArn = `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:${app.names.signatureVerifierFunction}`;
  verifier['functionArn'] = functionArn;
  verifier['preflightAliasArn'] = `${functionArn}:preflight`;
  verifier['runtimeAliasArn'] = `${functionArn}:runtime`;
  verifier['timeoutSeconds'] = 120;
  verifier['executionRoleArn'] =
    `arn:${target.partition}:iam::${target.accountId}:role/${app.names.signatureVerifierRole}`;
  verifier['executionRolePermissionsBoundaryArn'] =
    `arn:${target.partition}:iam::${target.accountId}:policy/${app.names.signatureVerifierPermissionsBoundary}`;
  if (mode === 'rollback') {
    report['rollbackSelection'] = {
      acceptanceKey: `${app.names.acceptedDeploymentPrefix}/acceptances/${'9'.repeat(64)}.json`,
      selectedDeploymentId,
      staticArtifactDeploymentId,
    };
    const evidence = preflight['evidence'] as Record<string, unknown>;
    evidence['key'] =
      `${app.names.signaturePreflightPrefix}/executions/${historicalPipelineExecutionId}/` +
      `attempts/${'a'.repeat(64)}/verification.json`;
    const retained = mutableRecord(report['retainedDeployables'], 'retained deployables');
    const staticFrontend = mutableRecord(retained['staticFrontend'], 'retained static frontend');
    staticFrontend['key'] =
      `${app.names.staticFrontendArtifactPrefix}/${selectedSourceSha}/${staticArtifactDeploymentId}/dist.tar.gz`;
  }
  const identity = mutableRecord(release['imageSignatureVerifierIdentity'], 'verifier identity');
  const staticDeployment = mutableRecord(report['staticFrontendDeploy'], 'static deployment');
  staticDeployment['frontendBucketName'] = app.names.frontendBucket;
  identity['identitySha256'] = canonicalJsonSha256({
    appSourceSha: preflight['selectedSourceSha'],
    preflightSourceSha: preflight['sourceSha'],
    proverImageUri: preflight['proverImageUri'],
    signingProfileArn: preflight['signingProfileArn'],
    trustPolicySha256: preflight['trustPolicySha256'],
    verifierVersion: preflight['verifierVersion'],
    preflightEvidence: preflight['evidence'],
    verifier,
  });
  return report;
}

describe('target App acceptance smoke admission', () => {
  it('admits and deeply freezes the current normal smoke wire shape', () => {
    const report = fixture('normal');

    const admitted = admitAppAcceptanceSmokeReport(report, target.targetKey);

    expect(admitted).toEqual(report);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted['releaseEvidence'])).toBe(true);
  });

  it('admits historical preflight and transitive static ownership for rollback', () => {
    const report = fixture('rollback');

    expect(admitAppAcceptanceSmokeReport(report, target.targetKey)).toEqual(report);
  });

  it('rejects rollback selections and static archives that disagree', () => {
    const report = fixture('rollback');
    const selection = report['rollbackSelection'] as Record<string, unknown>;
    selection['staticArtifactDeploymentId'] = `dep_${'0'.repeat(32)}`;

    expect(() => admitAppAcceptanceSmokeReport(report, target.targetKey)).toThrow(/static frontend.*inconsistent/iu);
  });

  it('rejects detached verifier identity hashes and incomplete checks', () => {
    const identitySplice = fixture('normal');
    const release = mutableRecord(identitySplice['releaseEvidence'], 'release evidence');
    const identity = mutableRecord(release['imageSignatureVerifierIdentity'], 'verifier identity');
    identity['identitySha256'] = '0'.repeat(64);
    expect(() => admitAppAcceptanceSmokeReport(identitySplice, target.targetKey)).toThrow(/identity hash.*detached/iu);

    const incomplete = fixture('normal');
    const checks = incomplete['checks'] as Record<string, unknown>;
    checks['runtimeResourcesCreated'] = false;
    expect(() => admitAppAcceptanceSmokeReport(incomplete, target.targetKey)).toThrow(/caller or checks/iu);
  });

  it('requires the governed frontend bucket and a control-safe caller ARN', () => {
    const wrongBucket = fixture('normal');
    const staticDeploy = wrongBucket['staticFrontendDeploy'] as Record<string, unknown>;
    staticDeploy['frontendBucketName'] = 'detached-frontend-bucket';
    expect(() => admitAppAcceptanceSmokeReport(wrongBucket, target.targetKey)).toThrow(/frontend bucket.*invalid/iu);

    const unsafeCaller = fixture('normal');
    const callerArn = unsafeCaller['callerArn'];
    if (typeof callerArn !== 'string') throw new Error('caller ARN fixture is missing');
    unsafeCaller['callerArn'] = `${callerArn}\u0000suffix`;
    expect(() => admitAppAcceptanceSmokeReport(unsafeCaller, target.targetKey)).toThrow(/caller ARN.*invalid/iu);
  });

  it('captures proxied input data without invoking property getters and rejects extra fields', () => {
    const report = fixture('normal');
    let gets = 0;
    const proxy = new Proxy(report, {
      get(targetValue, property, receiver) {
        gets += 1;
        return Reflect.get(targetValue, property, receiver) as unknown;
      },
    });

    expect(admitAppAcceptanceSmokeReport(proxy, target.targetKey)).toEqual(report);
    expect(gets).toBe(0);
    expect(() => admitAppAcceptanceSmokeReport({ ...report, latest: true }, target.targetKey)).toThrow(
      /exact enumerable data shape/iu,
    );
  });

  it('rejects the retired smoke-level release record chain and compatibility duplicate', () => {
    const report = fixture('normal');
    const releaseEvidence = mutableRecord(report['releaseEvidence'], 'release evidence');

    expect(() =>
      admitAppAcceptanceSmokeReport(
        {
          ...report,
          releaseAuthority: {
            appDeploymentRecord: immutableReference('deployments/develop/app.json', '1'),
            toolchainArtifactRecord: immutableReference('artifacts/toolchain/execution/manifest.json', '2'),
            proverReleaseRecord: immutableReference('artifacts/prover/execution/manifest.json', '3'),
          },
        },
        target.targetKey,
      ),
    ).toThrow(/exact enumerable data shape/iu);
    expect(() =>
      admitAppAcceptanceSmokeReport(
        {
          ...report,
          releaseEvidence: {
            ...releaseEvidence,
            compatibility: {
              zkvmContractHash: '8'.repeat(64),
              appSourceZkvmContractHash: '8'.repeat(64),
              proverReleaseZkvmContractHash: '8'.repeat(64),
              matchEvidenceId: 'retired-duplicate',
            },
          },
        },
        target.targetKey,
      ),
    ).toThrow(/exact enumerable data shape/iu);
  });

  it('requires release evidence to bind an execution-authority hash and a passing failure-marker smoke', () => {
    const report = fixture('normal');
    const releaseEvidence = mutableRecord(report['releaseEvidence'], 'release evidence');

    expect(() =>
      admitAppAcceptanceSmokeReport(
        {
          ...report,
          releaseEvidence: {
            ...releaseEvidence,
            appExecutionAuthoritySha256: 'not-a-sha256',
          },
        },
        target.targetKey,
      ),
    ).toThrow(/execution authority SHA-256/iu);
    expect(() =>
      admitAppAcceptanceSmokeReport(
        {
          ...report,
          releaseEvidence: {
            ...releaseEvidence,
            failureMarkerSmokeStatus: 'FAIL',
          },
        },
        target.targetKey,
      ),
    ).toThrow(/failure-marker status/iu);
  });
});

it('admits production smoke only with production state, roles, deployables, and public frontend posture', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const smoke = await import('./app-acceptance-smoke.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const authorities = { target: production, app: targets.resolveDeploymentLaneAuthority(production, 'app') };
    for (const mode of ['normal', 'rollback'] as const) {
      const report = fixture(mode, authorities);
      expect(smoke.admitAppAcceptanceSmokeReport(report, production.targetKey)).toEqual(report);
      for (const wrongTarget of [undefined, 'unreviewed/main', target.targetKey]) {
        expect(() => smoke.admitAppAcceptanceSmokeReport(report, wrongTarget)).toThrow();
      }
      const development = fixture(mode);
      for (const field of [
        'accountId',
        'deploymentEnvironment',
        'stateIdentity',
        'backendKey',
        'callerArn',
        'checks',
        'retainedDeployables',
        'retainedDeploymentArtifacts',
        'releaseEvidence',
        'staticFrontendDeploy',
      ] as const) {
        expect(() =>
          smoke.admitAppAcceptanceSmokeReport({ ...report, [field]: development[field] }, production.targetKey),
        ).toThrow();
      }
      if (mode === 'rollback') {
        expect(() =>
          smoke.admitAppAcceptanceSmokeReport(
            { ...report, rollbackSelection: development['rollbackSelection'] },
            production.targetKey,
          ),
        ).toThrow();
      }
      const empty = {
        ...report,
        resourceChangeCount: 0,
        outputChangeCount: 0,
        movedResourceChangeCount: 0,
        importingResourceChangeCount: 0,
        planEmpty: true,
      };
      expect(smoke.admitAppAcceptanceSmokeReport(empty, production.targetKey)['manualApprovalSkipped']).toBe(false);
      expect(() =>
        smoke.admitAppAcceptanceSmokeReport(
          { ...empty, manualApprovalSkipped: true, approvalReason: 'empty-plan' },
          production.targetKey,
        ),
      ).toThrow();
      const staticDeploy = mutableRecord(report['staticFrontendDeploy'], 'production static deploy');
      expect(() =>
        smoke.admitAppAcceptanceSmokeReport(
          { ...report, staticFrontendDeploy: { ...staticDeploy, operatorGateEnabled: true } },
          production.targetKey,
        ),
      ).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
