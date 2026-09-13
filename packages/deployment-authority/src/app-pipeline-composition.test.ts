import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';

import {
  bindAppAcceptanceSelection,
  deriveAppAcceptanceRecordKey,
  projectInitialAppAcceptancePointer,
} from './app-acceptance-ledger.js';
import { selectAppImageSignatureVerifierAction } from './app-image-signature-verifier-reconciliation.js';
import { deriveAppExecutionAuthoritySha256, projectRollbackAppExecutionAuthority } from './app-execution-authority.js';
import { composeAppPipelineExecution } from './app-pipeline-composition.js';
import { canonicalJsonSha256 } from './internal.js';
import { deriveDeploymentIdentity, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { createAppAcceptanceFixture, createBoundSelectionFixture } from './testdata/app-acceptance-ledger-fixture.js';
import {
  alias,
  desiredState,
  immutableFunction,
  mutableFunction,
  observation,
  verifierConfigurationAuthority,
} from './testdata/app-image-signature-verifier-fixture.js';
import {
  createAppReleaseSelectionFixture,
  deriveSelectedReleaseFacts,
  type AppReleaseSelectionFixture,
} from './testdata/app-release-selection-fixture.js';
import { buildSavedPlanFixture } from './testdata/saved-plan-fixture.js';
import { decodeTerraformBaselineNonsecretInputValues } from './terraform-authority.js';

type Data = Record<string, unknown>;
const CONTROL_SOURCE_SHA = 'b'.repeat(40);
const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const APP_AUTHORITY = resolveDeploymentLaneAuthority(TARGET, 'app');

function data(value: unknown, label: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} fixture must be a record`);
  }
  return value as Data;
}

function acceptedReleaseAuthority(selection: ReturnType<typeof createBoundSelectionFixture>): Data {
  return data(selection.acceptance.releaseAuthority, 'accepted release authority');
}

function releaseChainSha256(release: Data): string {
  return canonicalJsonSha256({
    foundationAcceptanceKey: release['foundationAcceptanceKey'],
    foundationContractHash: release['foundationContractHash'],
    proverReleaseKey: release['proverReleaseKey'],
    toolchainReleaseKey: release['toolchainReleaseKey'],
  });
}

function selectedReleaseAuthority(releaseInputs: AppReleaseSelectionFixture) {
  return {
    ...deriveSelectedReleaseFacts(releaseInputs),
    zkvmContractHash: releaseInputs.prover.releaseRecord.zkvmContractHash,
  };
}

function selectedReleaseChainSha256(releaseInputs: AppReleaseSelectionFixture): string {
  const selected = selectedReleaseAuthority(releaseInputs);
  return canonicalJsonSha256({
    foundationAcceptanceKey: selected.foundationAcceptanceKey,
    foundationContractHash: selected.foundationContractHash,
    proverReleaseKey: selected.proverReleaseKey,
    toolchainReleaseKey: selected.toolchainReleaseKey,
  });
}

function currentSelectionForRelease(releaseInputs: AppReleaseSelectionFixture) {
  const record = structuredClone(createAppAcceptanceFixture()) as Data;
  const release = data(record['releaseAuthority'], 'matching accepted release authority');
  const verifier = data(record['verifier'], 'matching accepted verifier');
  const mapping = data(verifier['confirmedImageIdMapping'], 'matching accepted ImageID mapping');
  const preflight = data(verifier['signaturePreflight'], 'matching accepted verifier preflight');
  const facts = deriveSelectedReleaseFacts(releaseInputs);
  release['foundationAcceptanceKey'] = facts.foundationAcceptanceKey;
  release['foundationContractHash'] = facts.foundationContractHash;
  release['proverReleaseKey'] = facts.proverReleaseKey;
  release['toolchainReleaseKey'] = facts.toolchainReleaseKey;
  mapping['proverReleaseKey'] = facts.proverReleaseKey;
  preflight['proverReleaseKey'] = facts.proverReleaseKey;
  const acceptanceKey = deriveAppAcceptanceRecordKey(record, TARGET.targetKey);
  const pointer = projectInitialAppAcceptancePointer(
    {
      history: [acceptanceKey],
      predecessor: { etag: 'captured-etag', versionId: 'captured-object-id' },
    },
    TARGET.targetKey,
  );
  return bindAppAcceptanceSelection(
    {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-object-id' },
      recordKey: acceptanceKey,
      record,
      recordObservation: { etag: 'record-etag', versionId: 'record-object-id' },
    },
    TARGET.targetKey,
  );
}

function retainedVerifierFunction(selection: ReturnType<typeof createBoundSelectionFixture>) {
  const rollback = data(selection.acceptance, 'retained acceptance');
  const verifier = data(rollback['verifier'], 'retained verifier');
  const preflight = data(verifier['signaturePreflight'], 'retained verifier preflight');
  const verifierPackage = data(preflight['verifierPackage'], 'retained verifier package');
  const release = acceptedReleaseAuthority(selection);
  const proverImage = data(release['proverImage'], 'retained Prover image');
  const inputValues = decodeTerraformBaselineNonsecretInputValues(rollback['nonsecretInputs']);
  const configuration = structuredClone(verifierConfigurationAuthority()) as Data;
  const environment = data(configuration['environment'], 'retained verifier environment');
  configuration['runtime'] = inputValues['lambda_runtime'];
  configuration['timeout_seconds'] = inputValues['image_signature_verifier_lambda_timeout_seconds'];
  environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'] = verifierPackage['assetManifestSha256'];
  environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'] = String(proverImage['imageDigest']);
  environment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'] = verifierPackage['trustRootSha256'];
  environment['IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS'] = String(
    inputValues['image_signature_verifier_handler_deadline_ms'],
  );
  environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS'] = String(
    inputValues['image_signature_status_attempt_timeout_ms'],
  );
  environment['IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS'] = String(inputValues['image_signature_status_max_attempts']);
  environment['IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS'] = String(
    inputValues['image_signature_status_retry_delay_ms'],
  );
  environment['IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS'] = String(
    inputValues['image_signature_verifier_process_timeout_ms'],
  );
  return {
    assetManifestSha256: String(verifierPackage['assetManifestSha256']),
    awsConfigSha256: Buffer.from('3'.repeat(64), 'hex').toString('base64'),
    codeSha256: String(verifierPackage['sourceCodeHash']),
    description: '',
    functionConfigurationAuthority: configuration,
    functionConfigurationSha256: canonicalJsonSha256(configuration),
    functionVersion: '39',
    resolvedS3Object: {
      s3Bucket: String(verifierPackage['bucket']),
      s3Key: String(verifierPackage['key']),
      s3ObjectVersionId: String(verifierPackage['versionId']),
    },
    trustRootSha256: String(verifierPackage['trustRootSha256']),
    zipSha256: Buffer.from(String(verifierPackage['sourceCodeHash']), 'base64').toString('hex'),
  } as ReturnType<typeof desiredState>['aliases']['runtime']['target']['function'];
}

function currentVerifierReconciliation(selection: ReturnType<typeof createBoundSelectionFixture>) {
  const desired = structuredClone(desiredState());
  desired.sourceSha = CONTROL_SOURCE_SHA;
  desired.package.s3Key = `${APP_AUTHORITY.names.lambdaArtifactPrefix}/${CONTROL_SOURCE_SHA}/image-signature-verifier.zip`;
  desired.aliases.runtime.target = { function: retainedVerifierFunction(selection), kind: 'retained-function' };
  const currentResolvedS3Object = {
    s3Bucket: desired.package.s3Bucket,
    s3Key: desired.package.s3Key,
    s3ObjectVersionId: desired.package.s3ObjectVersionId,
  };
  return {
    desired,
    observation: observation({
      aliases: { preflight: alias('preflight', '42'), runtime: alias('runtime', '39') },
      immutableFunctions: {
        items: [
          immutableFunction('39', retainedVerifierFunction(selection)),
          immutableFunction('42', { resolvedS3Object: currentResolvedS3Object }),
        ],
        unreadNextMarker: null,
      },
      mutableFunction: mutableFunction({ resolvedS3Object: currentResolvedS3Object }),
    }),
  };
}

function normalizedLambdaArtifact(value: unknown, label: string) {
  const artifact = data(value, label);
  return {
    asset_manifest_sha256: artifact['assetManifestSha256'],
    s3_bucket: artifact['bucket'],
    s3_key: artifact['key'],
    s3_object_version: artifact['versionId'],
    source_code_hash: artifact['sourceCodeHash'],
    trust_root_sha256: artifact['trustRootSha256'],
  };
}

function hybridLambdaSetSha256(
  selection: ReturnType<typeof createBoundSelectionFixture>,
  verifier: ReturnType<typeof currentVerifierReconciliation>,
): string {
  const deployables = data(selection.acceptance.deployables, 'retained deployables');
  const lambdaArtifacts = data(deployables['lambdaArtifacts'], 'retained Lambda artifacts');
  const artifacts = data(lambdaArtifacts['artifacts'], 'retained Lambda artifact set');
  const reconciled = selectAppImageSignatureVerifierAction(verifier.desired, verifier.observation);
  if (reconciled['kind'] !== 'validate-live-state') throw new Error('current verifier fixture must be reconciled');
  const selectedFunction = data(reconciled['selectedFunction'], 'current verifier selected function');
  const selectedConfiguration = data(
    selectedFunction['functionConfigurationAuthority'],
    'current verifier selected configuration',
  );
  const selectedEnvironment = data(selectedConfiguration['environment'], 'current verifier selected environment');
  const selectedPackage = data(selectedFunction['resolvedS3Object'], 'current verifier selected package');
  const normalized = Object.fromEntries(
    Object.entries(artifacts).map(([name, value]) => [name, normalizedLambdaArtifact(value, name)]),
  );
  normalized['image_signature_verifier'] = {
    asset_manifest_sha256: selectedEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'],
    s3_bucket: selectedPackage['s3Bucket'],
    s3_key: selectedPackage['s3Key'],
    s3_object_version: selectedPackage['s3ObjectVersionId'],
    source_code_hash: selectedFunction['codeSha256'],
    trust_root_sha256: selectedEnvironment['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'],
  };
  return canonicalJsonSha256({ sourceSha: lambdaArtifacts['sourceSha'], artifacts: normalized });
}

function rollbackExecutionIdentity(
  selection: ReturnType<typeof createBoundSelectionFixture>,
  context: Data,
  controlSourceSha: string,
) {
  const authority = projectRollbackAppExecutionAuthority(
    { controlSourceSha, acceptanceSelection: selection },
    TARGET.targetKey,
  );
  const appExecutionAuthoritySha256 = deriveAppExecutionAuthoritySha256(authority, TARGET.targetKey);
  const identity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: String(selection.acceptance.selectedApplicationSourceSha),
    deployMode: 'rollback',
    pipelineExecutionId: String(context['pipelineExecutionId']),
  });
  return { authority, appExecutionAuthoritySha256, deploymentId: identity.deploymentId };
}

function normalDeploymentAuthority(
  releaseInputs: AppReleaseSelectionFixture,
  context: Data,
  selectedSourceSha: string,
) {
  const facts = selectedReleaseAuthority(releaseInputs);
  const prover = releaseInputs.prover.releaseRecord;
  const appExecutionAuthoritySha256 = 'f'.repeat(64);
  const identity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: selectedSourceSha,
    deployMode: 'normal',
    pipelineExecutionId: context['pipelineExecutionId'],
  });
  return {
    ...facts,
    appExecutionAuthoritySha256,
    deploymentId: identity.deploymentId,
    deploymentMode: 'normal',
    expectedImageId: prover.expectedImageId,
    imageIdMappingSha256: '4'.repeat(64),
    imageIdVariant: prover.imageIdVariant,
    lambdaCount: 6,
    lambdaSetSha256: '6'.repeat(64),
    lambdaSourceSha: selectedSourceSha,
    methodVersion: prover.methodVersion,
    selectedSourceSha,
    verifierFunctionVersion: '42',
  };
}

function savedPlanInput(options: {
  gate: 'terraform' | 'verifier-preflight';
  mode: 'normal' | 'rollback';
  controlSourceSha: string;
  selectedSourceSha: string;
  releaseInputs: AppReleaseSelectionFixture | null;
  verifierReconciliation: ReturnType<typeof currentVerifierReconciliation> | null;
  selection: ReturnType<typeof createBoundSelectionFixture>;
  semanticChange: boolean;
}) {
  const fixture = buildSavedPlanFixture({
    lane: 'app',
    gate: options.gate,
    deploymentMode: options.mode,
    selectedSourceSha: String(options.selection.acceptance.selectedApplicationSourceSha),
    semanticChange: options.semanticChange,
  });
  const activeReview = structuredClone(fixture.correspondence.expected.contract.review) as Data;
  const context = { ...data(activeReview['context'], 'saved-plan context'), sourceSha: options.controlSourceSha };
  const summary = activeReview['summary'];
  const activeApproval = data(activeReview['approval'], 'saved-plan approval');
  const approval =
    options.gate === 'verifier-preflight'
      ? { ...activeApproval, sourceSha: options.controlSourceSha }
      : {
          ...activeApproval,
          controlSourceSha: options.controlSourceSha,
          deploymentMode: options.mode,
          selectedSourceSha: options.selectedSourceSha,
        };
  if (options.gate === 'verifier-preflight') {
    if (options.releaseInputs === null) throw new Error('normal preflight fixture requires release inputs');
    const facts = selectedReleaseAuthority(options.releaseInputs);
    const packageSha256 = '9'.repeat(64);
    return {
      evidence: { context, summary, approval },
      authority: {
        ...facts,
        assetManifestSha256: '7'.repeat(64),
        expectedFunctionVersion: '42',
        reconciliationDesiredSha256: '8'.repeat(64),
        package: {
          key: `${APP_AUTHORITY.names.lambdaArtifactPrefix}/${options.selectedSourceSha}/image-signature-verifier.zip`,
          versionId: '2031ad6c-fe04-4cdd-9864-13197a61273b',
          sha256: packageSha256,
        },
        packageSourceSha: options.selectedSourceSha,
        releaseAuthoritySha256: canonicalJsonSha256(facts),
        sourceCodeHash: Buffer.from(packageSha256, 'hex').toString('base64'),
        trustRootSha256: 'a'.repeat(64),
      },
      releaseComparison: null,
    };
  }

  let authority;
  if (options.mode === 'normal') {
    if (options.releaseInputs === null) throw new Error('normal Terraform fixture requires release inputs');
    authority = normalDeploymentAuthority(options.releaseInputs, context, options.selectedSourceSha);
  } else {
    const verifier = options.verifierReconciliation;
    if (verifier === null) throw new Error('rollback fixture requires current verifier authority');
    const reconciled = selectAppImageSignatureVerifierAction(verifier.desired, verifier.observation);
    if (reconciled['kind'] !== 'validate-live-state') throw new Error('current verifier fixture must be reconciled');
    const runtimeFunction = data(reconciled['runtimeFunction'], 'current verifier runtime function');
    const release = acceptedReleaseAuthority(options.selection);
    const proverImage = data(release['proverImage'], 'retained Prover image');
    const toolchainImage = data(release['toolchainImage'], 'retained Toolchain image');
    const zkvm = data(release['zkvm'], 'retained zkVM authority');
    const identity = rollbackExecutionIdentity(options.selection, context, options.controlSourceSha);
    authority = {
      appExecutionAuthoritySha256: identity.appExecutionAuthoritySha256,
      deploymentId: identity.deploymentId,
      deploymentMode: 'rollback',
      expectedImageId: zkvm['expectedImageId'],
      imageIdMappingSha256: zkvm['imageIdMappingSha256'],
      imageIdVariant: zkvm['imageIdVariant'],
      lambdaCount: 6,
      lambdaSetSha256: hybridLambdaSetSha256(options.selection, verifier),
      lambdaSourceSha: options.selectedSourceSha,
      methodVersion: zkvm['methodVersion'],
      proverImageDigest: proverImage['imageDigest'],
      proverReleaseKey: release['proverReleaseKey'],
      selectedAcceptanceKey: options.selection.acceptanceKey,
      selectedSourceSha: options.selectedSourceSha,
      toolchainImageDigest: toolchainImage['imageDigest'],
      toolchainReleaseKey: release['toolchainReleaseKey'],
      verifierFunctionVersion: runtimeFunction['functionVersion'],
      zkvmContractHash: zkvm['zkvmContractHash'],
    };
  }
  const selectedChain = options.releaseInputs === null ? null : selectedReleaseChainSha256(options.releaseInputs);
  const currentChain = releaseChainSha256(acceptedReleaseAuthority(options.selection));
  return {
    evidence: { context, summary, approval },
    authority,
    releaseComparison:
      options.mode === 'normal' && !options.semanticChange && selectedChain !== null
        ? {
            deploymentMode: 'normal',
            selectedReleaseChainSha256: selectedChain,
            currentAcceptedReleaseChainSha256: currentChain,
          }
        : null,
  };
}

function normalInput(options: { comparison?: 'changed' | 'equal'; semanticChange?: boolean } = {}) {
  const releaseInputs = createAppReleaseSelectionFixture();
  const semanticChange = options.semanticChange ?? true;
  const comparison = options.comparison ?? 'equal';
  const acceptanceSelection =
    !semanticChange && comparison === 'equal'
      ? currentSelectionForRelease(releaseInputs)
      : createBoundSelectionFixture('current');
  return {
    acceptanceSelection,
    currentVerifierReconciliation: null,
    emptyPlanAcceptanceSelection:
      !semanticChange && comparison === 'equal' ? structuredClone(acceptanceSelection) : null,
    releaseInputs,
    verifierPreflightSavedPlan: savedPlanInput({
      gate: 'verifier-preflight',
      mode: 'normal',
      controlSourceSha: CONTROL_SOURCE_SHA,
      selectedSourceSha: releaseInputs.selectedSourceSha,
      releaseInputs,
      selection: acceptanceSelection,
      semanticChange: true,
      verifierReconciliation: null,
    }),
    terraformSavedPlan: savedPlanInput({
      gate: 'terraform',
      mode: 'normal',
      controlSourceSha: CONTROL_SOURCE_SHA,
      selectedSourceSha: releaseInputs.selectedSourceSha,
      releaseInputs,
      selection: acceptanceSelection,
      semanticChange,
      verifierReconciliation: null,
    }),
  };
}

function rollbackInput(semanticChange = true) {
  const acceptanceSelection = createBoundSelectionFixture('retained');
  const verifierReconciliation = currentVerifierReconciliation(acceptanceSelection);
  return {
    acceptanceSelection,
    currentVerifierReconciliation: verifierReconciliation,
    emptyPlanAcceptanceSelection: null,
    releaseInputs: null,
    verifierPreflightSavedPlan: null,
    terraformSavedPlan: savedPlanInput({
      gate: 'terraform',
      mode: 'rollback',
      controlSourceSha: CONTROL_SOURCE_SHA,
      selectedSourceSha: String(acceptanceSelection.acceptance.selectedApplicationSourceSha),
      releaseInputs: null,
      selection: acceptanceSelection,
      semanticChange,
      verifierReconciliation,
    }),
  };
}

const OPERATIONS = [
  'select-source',
  'resolve-release',
  'plan-verifier-preflight',
  'approve-verifier-preflight',
  'apply-verifier-preflight',
  'verify-prover-signature',
  'plan-terraform',
  'approve-terraform',
  'apply-terraform',
  'deploy-static-frontend',
  'smoke-runtime-and-publish-acceptance',
  'publish-current-status',
];

describe('App pipeline execution composition', () => {
  it('binds the normal source, resolved releases, approvals, and exact artifact graph', () => {
    const input = normalInput();
    const result = composeAppPipelineExecution(input, TARGET.targetKey);
    const selected = selectedReleaseAuthority(input.releaseInputs);

    expect(result.deploymentMode).toBe('normal');
    expect(result.source).toEqual({ controlSourceSha: CONTROL_SOURCE_SHA, selectedSourceSha: CONTROL_SOURCE_SHA });
    expect(result.source.selectedSourceSha).not.toBe(input.acceptanceSelection.acceptance.selectedApplicationSourceSha);
    expect(result.releaseResolution).toMatchObject({
      currentAcceptance: { acceptanceKey: input.acceptanceSelection.acceptanceKey },
      retainedAcceptance: null,
      selectedReleaseInputs: {
        foundation: input.releaseInputs.foundation,
        toolchain: input.releaseInputs.toolchain,
        prover: input.releaseInputs.prover,
        selectedReleaseAuthority: selected,
      },
    });
    expect(result.approvals.verifierPreflight).toMatchObject({
      disposition: 'required',
      authority: selected,
    });
    expect(data(result.approvals.verifierPreflight.authority, 'preflight authority')['zkvmContractHash']).toBe(
      input.releaseInputs.prover.releaseRecord.zkvmContractHash,
    );
    expect(result.approvals.terraform).toEqual({ disposition: 'manual-approval', emptyPlanAuthority: null });
    expect(result.actions.map((action) => action.operation)).toEqual(OPERATIONS);
    expect(result.actions.at(-1)).toEqual({
      category: 'Build',
      execution: 'required',
      inputArtifacts: ['SourceOutput'],
      operation: 'publish-current-status',
      outputArtifacts: [],
      predecessors: ['smoke-runtime-and-publish-acceptance'],
      primarySource: 'SourceOutput',
      provider: 'CodeBuild',
      stage: 'PublishCurrentStatus',
    });
    expect(result.actions.flatMap((action) => action.outputArtifacts)).toEqual([
      'SourceOutput',
      'ReleaseResolutionOutput',
      'VerifierPreflightPlanOutput',
      'VerifierPreflightApplyOutput',
      'VerifierSignatureOutput',
      'PlanOutput',
      'ApplyOutput',
      'StaticDeployOutput',
    ]);
    const buildActions = result.actions.filter((action) => action.category === 'Build');
    expect(buildActions.every((action) => action.provider === 'CodeBuild')).toBe(true);
    expect(buildActions.every((action) => action.primarySource === 'SourceOutput')).toBe(true);
    expect(buildActions.every((action) => action.inputArtifacts.length >= 1 && action.inputArtifacts.length <= 5)).toBe(
      true,
    );
    expect(
      result.actions.filter((action) => action.category !== 'Build').every((action) => action.primarySource === null),
    ).toBe(true);
    const outputArtifacts = result.actions.flatMap((action) => action.outputArtifacts);
    expect(new Set(outputArtifacts).size).toBe(outputArtifacts.length);
    expect(result.terraformPlan.orderedWork.map((work) => work.operation)).toEqual([
      'verify-source-only-repository',
      'materialize-release-and-signature-authority',
      'materialize-app-execution-authority',
      'materialize-deployment-artifacts',
      'write-source-preflight',
      'create-saved-plan',
    ]);
    expect(result.terraformPlan.carriedAuthority).not.toEqual(
      expect.arrayContaining(['deployment-selection', 'selected-deployment', 'rollback-selection']),
    );
    const authorityOwners = result.terraformPlan.orderedWork.filter(
      (work) => work.operation === 'materialize-app-execution-authority',
    );
    expect(authorityOwners).toEqual([
      {
        operation: 'materialize-app-execution-authority',
        inputs: ['deployment-inputs'],
        outputs: ['app-execution-authority'],
      },
    ]);
    const planOutputs = result.terraformPlan.orderedWork.flatMap((work) => work.outputs);
    expect(new Set(planOutputs).size).toBe(planOutputs.length);
    expect(planOutputs.filter((output) => output === 'app-execution-authority')).toHaveLength(1);
    expect(result.terraformPlan.orderedWork.find((work) => work.operation === 'create-saved-plan')?.inputs).toContain(
      'app-execution-authority',
    );
    const authorityOwner = authorityOwners[0];
    if (authorityOwner === undefined) throw new Error('execution authority owner is missing');
    expect(result.terraformPlan.orderedWork.indexOf(authorityOwner)).toBeGreaterThan(
      result.terraformPlan.orderedWork.findIndex(
        (work) => work.operation === 'materialize-release-and-signature-authority',
      ),
    );
    expect(result.terraformPlan.sourceChecks).toEqual([
      'terraform-bootstrap-format',
      'terraform-app-format',
      'terraform-app-configuration',
      'node-runtime',
      'locked-dependencies',
      'repository-format',
      'repository-lint',
      'type-system',
      'public-safety',
      'unit-tests',
    ]);
    const savedPlan = data(input.terraformSavedPlan, 'Terraform saved plan');
    const authority = data(savedPlan['authority'], 'Terraform authority');
    const evidence = data(savedPlan['evidence'], 'Terraform evidence');
    const approval = data(evidence['approval'], 'Terraform approval');
    expect(result.terraformPlan.deploymentAuthority).toEqual({
      appExecutionAuthoritySha256: authority['appExecutionAuthoritySha256'],
      deploymentId: authority['deploymentId'],
      selectedSourceSha: CONTROL_SOURCE_SHA,
      reviewedPlanChecksum: approval['reviewedPlanChecksum'],
      lambdaSetSha256: authority['lambdaSetSha256'],
    });
    expect(
      result.actions
        .filter((action) => ['apply-terraform', 'smoke-runtime-and-publish-acceptance'].includes(action.operation))
        .every((action) => action.inputArtifacts.includes('PlanOutput')),
    ).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.terraformPlan.orderedWork)).toBe(true);
  });

  it('skips approval only after a fresh exact current release-chain observation', () => {
    const matchingInput = normalInput({ semanticChange: false });
    const matching = composeAppPipelineExecution(matchingInput, TARGET.targetKey);
    expect(matching.approvals.terraform).toMatchObject({
      disposition: 'exact-empty-plan-skip',
      emptyPlanAuthority: { currentAcceptance: { selectionType: 'current' } },
    });

    const changed = composeAppPipelineExecution(
      normalInput({ comparison: 'changed', semanticChange: false }),
      TARGET.targetKey,
    );
    expect(changed.approvals.terraform).toEqual({ disposition: 'manual-approval', emptyPlanAuthority: null });

    const stale = normalInput({ semanticChange: false });
    stale.emptyPlanAcceptanceSelection = createBoundSelectionFixture('current');
    expect(() => composeAppPipelineExecution(stale, TARGET.targetKey)).toThrow(
      /decision-time|release comparison|current acceptance/iu,
    );
  });

  it('keeps the mutable verifier package while selecting the retained runtime function during rollback', () => {
    for (const semanticChange of [true, false]) {
      const input = rollbackInput(semanticChange);
      const result = composeAppPipelineExecution(input, TARGET.targetKey);
      const savedPlan = data(input.terraformSavedPlan, 'rollback saved plan');
      const authority = data(savedPlan['authority'], 'rollback authority');

      expect(result.deploymentMode).toBe('rollback');
      expect(result.source).toEqual({
        controlSourceSha: CONTROL_SOURCE_SHA,
        selectedSourceSha: input.acceptanceSelection.acceptance.selectedApplicationSourceSha,
      });
      const currentVerifier = data(result.releaseResolution.currentVerifier, 'current verifier');
      expect(data(currentVerifier['selectedFunction'], 'selected function')['functionVersion']).toBe('42');
      expect(data(currentVerifier['runtimeFunction'], 'runtime function')['functionVersion']).toBe('39');
      const selectedPackage = data(
        data(currentVerifier['selectedFunction'], 'selected function')['resolvedS3Object'],
        'current selected verifier package',
      );
      const runtimePackage = data(
        data(currentVerifier['runtimeFunction'], 'runtime function')['resolvedS3Object'],
        'retained runtime verifier package',
      );
      const acceptedVerifier = data(input.acceptanceSelection.acceptance.verifier, 'accepted verifier');
      const acceptedPreflight = data(acceptedVerifier['signaturePreflight'], 'accepted verifier preflight');
      const acceptedPackage = data(acceptedPreflight['verifierPackage'], 'accepted verifier package');
      expect(selectedPackage['s3Key']).toContain(`/${CONTROL_SOURCE_SHA}/`);
      expect(selectedPackage['s3Key']).not.toBe(acceptedPackage['key']);
      expect(runtimePackage).toEqual({
        s3Bucket: acceptedPackage['bucket'],
        s3Key: acceptedPackage['key'],
        s3ObjectVersionId: acceptedPackage['versionId'],
      });
      expect(result.terraformPlan.deploymentAuthority).toMatchObject({
        lambdaSetSha256: hybridLambdaSetSha256(input.acceptanceSelection, input.currentVerifierReconciliation),
        verifierFunctionVersion: '39',
      });
      expect(authority['verifierFunctionVersion']).toBe('39');
      expect(result.approvals.verifierPreflight).toEqual({ disposition: 'retained-authority', authority: null });
      expect(result.approvals.terraform).toEqual({ disposition: 'manual-approval', emptyPlanAuthority: null });
      expect(result.actions.at(-1)).toMatchObject({
        operation: 'publish-current-status',
        predecessors: ['smoke-runtime-and-publish-acceptance'],
        stage: 'PublishCurrentStatus',
      });
      expect(result.terraformPlan.orderedWork.map((work) => work.operation)).toContain(
        'materialize-retained-execution-authority',
      );
      expect(result.terraformPlan.orderedWork.map((work) => work.operation)).not.toContain(
        'materialize-app-execution-authority',
      );
      expect(result.terraformPlan.deploymentAuthority).not.toHaveProperty('appDeploymentRecord');
      expect(result.terraformPlan.deploymentAuthority).not.toHaveProperty('executionIdentitySha256');
      expect(result.terraformPlan.carriedAuthority).not.toEqual(
        expect.arrayContaining(['deployment-selection', 'selected-deployment', 'rollback-selection']),
      );
    }
  });

  it('keeps rollback package authority when AWS omits native verifier metadata', () => {
    const input = rollbackInput();
    const observation = input.currentVerifierReconciliation.observation;
    const mutable = data(observation.mutableFunction, 'mutable verifier observation');
    mutable['awsConfigSha256'] = null;
    mutable['resolvedS3Object'] = null;
    for (const immutable of observation.immutableFunctions.items) {
      const item = data(immutable, 'immutable verifier observation');
      item['awsConfigSha256'] = null;
      item['resolvedS3Object'] = null;
    }

    const result = composeAppPipelineExecution(input, TARGET.targetKey);

    expect(result.releaseResolution.currentVerifier).toMatchObject({
      kind: 'validate-live-state',
      runtimeFunction: { functionVersion: '39', resolvedS3Object: null },
      selectedFunction: { functionVersion: '42', resolvedS3Object: null },
    });
    expect(result.terraformPlan.deploymentAuthority).toMatchObject({ verifierFunctionVersion: '39' });
  });

  it.each(['package', 'configuration', 'prover'] as const)(
    'rejects a retained runtime verifier detached from the accepted %s authority',
    (detachment) => {
      const input = rollbackInput();
      const reconciliation = input.currentVerifierReconciliation;
      const desiredAlias = data(reconciliation.desired.aliases.runtime, 'runtime alias');
      const target = data(desiredAlias['target'], 'runtime alias target');
      const exactFunction = data(target['function'], 'retained runtime function');
      if (detachment === 'package') {
        data(exactFunction['resolvedS3Object'], 'retained package')['s3Key'] =
          `${APP_AUTHORITY.names.lambdaArtifactPrefix}/${'c'.repeat(40)}/image-signature-verifier.zip`;
      } else {
        const configuration = data(exactFunction['functionConfigurationAuthority'], 'retained configuration');
        if (detachment === 'configuration') {
          configuration['timeout_seconds'] = 121;
        } else {
          data(configuration['environment'], 'retained environment')['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'] =
            `sha256:${'4'.repeat(64)}`;
        }
        exactFunction['functionConfigurationSha256'] = canonicalJsonSha256(configuration);
      }
      const inventory = data(reconciliation.observation.immutableFunctions, 'immutable inventory');
      const items = inventory['items'] as Data[];
      items[0] = immutableFunction('39', exactFunction);

      expect(() => composeAppPipelineExecution(input, TARGET.targetKey)).toThrow(
        /retained acceptance|runtime verifier/iu,
      );
    },
  );

  it('detaches admitted deployment authority from caller-owned evidence', () => {
    const input = normalInput();
    const result = composeAppPipelineExecution(input, TARGET.targetKey);
    const savedPlan = data(input.terraformSavedPlan, 'mutable Terraform saved plan');
    const authority = data(savedPlan['authority'], 'mutable Terraform authority');
    const admittedHash = result.terraformPlan.deploymentAuthority.appExecutionAuthoritySha256;

    authority['appExecutionAuthoritySha256'] = '0'.repeat(64);
    authority['deploymentId'] = `dep_${'f'.repeat(32)}`;

    expect(result.terraformPlan.deploymentAuthority.appExecutionAuthoritySha256).toBe(admittedHash);
    expect(result.terraformPlan.deploymentAuthority.deploymentId).not.toBe(authority['deploymentId']);
  });

  it('bounds primitive descriptor work before acceptance admission', () => {
    const normal = normalInput();
    const amplified = {
      ...normal,
      acceptanceSelection: {
        ...normal.acceptanceSelection,
        acceptance: {
          ...normal.acceptanceSelection.acceptance,
          releaseAuthority: {
            ...normal.acceptanceSelection.acceptance.releaseAuthority,
            amplified: Array.from({ length: 11 }, () => Array.from({ length: 10_000 }, (_entry, index) => index)),
          },
        },
      },
    };

    expect(() => composeAppPipelineExecution(amplified, TARGET.targetKey)).toThrow(/inspection bound/iu);

    const oversized = structuredClone(normal) as Data;
    const acceptance = data(oversized['acceptanceSelection'], 'oversized selection');
    data(acceptance['acceptance'], 'oversized acceptance')['overBound'] = 'x'.repeat(64 * 1024 * 1024 + 1);
    expect(() => composeAppPipelineExecution(oversized, TARGET.targetKey)).toThrow(/inspection bound/iu);
  });

  it('rejects detached releases, sources, shapes, proxies, and accessors without invoking hostile code', () => {
    const normal = normalInput();
    expect(() =>
      composeAppPipelineExecution(
        { ...normal, acceptanceSelection: createBoundSelectionFixture('retained') },
        TARGET.targetKey,
      ),
    ).toThrow(/current acceptance/iu);
    expect(() =>
      composeAppPipelineExecution({ ...rollbackInput(), releaseInputs: normal.releaseInputs }, TARGET.targetKey),
    ).toThrow(/rollback.*release/iu);

    const detachedRelease = structuredClone(normal) as Data;
    const releaseInputs = data(detachedRelease['releaseInputs'], 'detached release inputs');
    const prover = data(releaseInputs['prover'], 'detached Prover selection');
    data(prover['releaseRecord'], 'detached Prover release')['imageDigest'] = `sha256:${'0'.repeat(64)}`;
    expect(() => composeAppPipelineExecution(detachedRelease, TARGET.targetKey)).toThrow(
      /content-addressed|detached/iu,
    );

    const detachedPreflight = structuredClone(normal) as Data;
    const preflight = data(detachedPreflight['verifierPreflightSavedPlan'], 'detached preflight');
    data(preflight['authority'], 'detached preflight authority')['foundationContractHash'] = '0'.repeat(64);
    expect(() => composeAppPipelineExecution(detachedPreflight, TARGET.targetKey)).toThrow(
      /preflight.*release|detached/iu,
    );

    const detachedPlan = structuredClone(normal) as Data;
    const terraform = data(detachedPlan['terraformSavedPlan'], 'detached Terraform saved plan');
    data(terraform['authority'], 'detached Terraform authority')['toolchainReleaseKey'] =
      `artifacts/toolchain/releases/${'0'.repeat(64)}.json`;
    expect(() => composeAppPipelineExecution(detachedPlan, TARGET.targetKey)).toThrow(
      /Terraform plan.*release|detached/iu,
    );

    const detachedSource = structuredClone(normal) as Data;
    const sourcePreflight = data(detachedSource['verifierPreflightSavedPlan'], 'detached preflight');
    const sourceEvidence = data(sourcePreflight['evidence'], 'detached preflight evidence');
    data(sourceEvidence['context'], 'detached preflight context')['sourceSha'] = 'c'.repeat(40);
    expect(() => composeAppPipelineExecution(detachedSource, TARGET.targetKey)).toThrow(/source|approval/iu);

    const trap = vi.fn(() => []);
    const proxied = {
      ...normal,
      acceptanceSelection: {
        ...normal.acceptanceSelection,
        acceptance: {
          ...normal.acceptanceSelection.acceptance,
          releaseAuthority: new Proxy(normal.acceptanceSelection.acceptance.releaseAuthority, { ownKeys: trap }),
        },
      },
    };
    expect(() => composeAppPipelineExecution(proxied, TARGET.targetKey)).toThrow(/proxy/iu);
    expect(trap).not.toHaveBeenCalled();

    const getter = vi.fn(() => normal.releaseInputs);
    const accessor = Object.defineProperty(
      {
        acceptanceSelection: normal.acceptanceSelection,
        currentVerifierReconciliation: null,
        emptyPlanAcceptanceSelection: null,
        terraformSavedPlan: normal.terraformSavedPlan,
        verifierPreflightSavedPlan: normal.verifierPreflightSavedPlan,
      },
      'releaseInputs',
      { enumerable: true, get: getter },
    );
    expect(() => composeAppPipelineExecution(accessor, TARGET.targetKey)).toThrow(/data shape/iu);
    expect(getter).not.toHaveBeenCalled();
  });
});

it('composes production releases and plans with mandatory approval, including no-op plans', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const ledger = await import('./app-acceptance-ledger.js');
    const acceptanceFixtures = await import('./testdata/app-acceptance-ledger-fixture.js');
    const releaseFixtures = await import('./testdata/app-release-selection-fixture.js');
    const planFixtures = await import('./testdata/saved-plan-fixture.js');
    const pipeline = await import('./app-pipeline-composition.js');
    const target = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const app = targets.resolveDeploymentLaneAuthority(target, 'app');
    const record = acceptanceFixtures.createProductionAppAcceptanceFixture();
    const key = ledger.deriveAppAcceptanceRecordKey(record, target.targetKey);
    const observation = { etag: 'pointer-etag', versionId: 'pointer-version' };
    const pointer = ledger.projectInitialAppAcceptancePointer(
      { history: [key], predecessor: observation },
      target.targetKey,
    );
    const acceptanceSelection = ledger.bindAppAcceptanceSelection(
      { pointer, pointerObservation: observation, recordKey: key, record, recordObservation: observation },
      target.targetKey,
    );
    const releaseInputs = releaseFixtures.createAppReleaseSelectionFixture(target.targetKey);
    const facts = selectedReleaseAuthority(releaseInputs);
    const packageSha256 = '9'.repeat(64);
    const preflightFixture = planFixtures.buildSavedPlanFixture({
      targetKey: target.targetKey,
      lane: 'app',
      gate: 'verifier-preflight',
    });
    const preflightEvidence = preflightFixture.correspondence.expected.contract.review;
    const verifierPreflightSavedPlan = {
      evidence: {
        context: { ...preflightEvidence.context, sourceSha: CONTROL_SOURCE_SHA },
        summary: preflightEvidence.summary,
        approval: { ...preflightEvidence.approval, sourceSha: CONTROL_SOURCE_SHA },
      },
      authority: {
        ...facts,
        assetManifestSha256: '7'.repeat(64),
        expectedFunctionVersion: '42',
        reconciliationDesiredSha256: '8'.repeat(64),
        package: {
          key: `${app.names.lambdaArtifactPrefix}/${CONTROL_SOURCE_SHA}/image-signature-verifier.zip`,
          versionId: 'preflight-package-version',
          sha256: packageSha256,
        },
        packageSourceSha: CONTROL_SOURCE_SHA,
        releaseAuthoritySha256: canonicalJsonSha256(facts),
        sourceCodeHash: Buffer.from(packageSha256, 'hex').toString('base64'),
        trustRootSha256: 'a'.repeat(64),
      },
      releaseComparison: null,
    };
    for (const semanticChange of [true, false]) {
      const fixture = planFixtures.buildSavedPlanFixture({ targetKey: target.targetKey, lane: 'app', semanticChange });
      const review = fixture.correspondence.expected.contract.review;
      const context = { ...review.context, sourceSha: CONTROL_SOURCE_SHA };
      const terraformSavedPlan = {
        evidence: {
          context,
          summary: review.summary,
          approval: { ...review.approval, controlSourceSha: CONTROL_SOURCE_SHA, selectedSourceSha: CONTROL_SOURCE_SHA },
        },
        authority: normalDeploymentAuthority(releaseInputs, context, CONTROL_SOURCE_SHA),
        releaseComparison: null,
      };
      const input = {
        acceptanceSelection,
        currentVerifierReconciliation: null,
        emptyPlanAcceptanceSelection: null,
        releaseInputs,
        verifierPreflightSavedPlan,
        terraformSavedPlan,
      };
      const result = pipeline.composeAppPipelineExecution(input, target.targetKey);
      expect(result.approvals.terraform).toEqual({ disposition: 'manual-approval', emptyPlanAuthority: null });
      expect(result.approvals.verifierPreflight.disposition).toBe('required');
      expect(result.actions.find((action) => action.operation === 'approve-terraform')?.execution).toBe('required');
      for (const wrongTarget of [undefined, 'unreviewed/main', TARGET.targetKey]) {
        expect(() => pipeline.composeAppPipelineExecution(input, wrongTarget)).toThrow();
      }
      const development = normalInput();
      for (const field of [
        'acceptanceSelection',
        'releaseInputs',
        'verifierPreflightSavedPlan',
        'terraformSavedPlan',
      ] as const) {
        expect(() =>
          pipeline.composeAppPipelineExecution({ ...input, [field]: development[field] }, target.targetKey),
        ).toThrow();
      }
      expect(() =>
        pipeline.composeAppPipelineExecution(
          { ...input, emptyPlanAcceptanceSelection: acceptanceSelection },
          target.targetKey,
        ),
      ).toThrow();
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
