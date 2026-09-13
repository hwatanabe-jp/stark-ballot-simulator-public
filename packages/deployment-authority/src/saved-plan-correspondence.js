import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { snapshotBoundedBytes } from './exact-bytes.js';
import {
  assertMatchingSourcePins,
  canonicalJson,
  canonicalJsonSha256,
  canonicalRecordJson,
  deepFreeze,
  parseGitCommitSha,
  parseSha256,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { parseDeploymentLaneContext, resolveAllowedDeploymentTarget } from './index.js';
import { PROVER_RELEASE_KIND, TOOLCHAIN_RELEASE_KIND, admitReleaseRecordKey } from './release-ledger.js';
import {
  validateCodeBuildBuildId,
  validateCodeBuildRuntimeEvidence,
  validateTerraformBaselineIdentityEvidence,
  validateTerraformBaselineProviderLock,
} from './terraform-authority.js';
import { FOUNDATION_ACCEPTANCE_KIND, admitTerraformAcceptanceRecordKey } from './terraform-acceptance.js';
import { classifySavedPlanDisposition } from './saved-plan-disposition.js';
import { SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS } from './saved-plan-correspondence-byte-policy.js';
import { buildSavedPlanSemanticReview } from './saved-plan-semantic-review.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const TERRAFORM_VERSION = '1.15.8';
const TERRAFORM_PLATFORM = 'linux_amd64';
const PROVIDER_ADDRESS = 'registry.terraform.io/hashicorp/aws';
const PROVIDER_VERSION = '6.58.0';
const GATE_CONTRACTS = Object.freeze({
  'bootstrap/terraform': Object.freeze({
    planStageName: 'TerraformPlan',
    planActionName: 'Plan',
    projectKey: 'terraformPlanProject',
  }),
  'foundation/terraform': Object.freeze({
    planStageName: 'TerraformPlan',
    planActionName: 'PlanFoundationState',
    projectKey: 'terraformPlanProject',
  }),
  'app/verifier-preflight': Object.freeze({
    planStageName: 'VerifierPreflightPlan',
    planActionName: 'PlanVerifierPreflight',
    projectKey: 'appSignaturePreflightPlanProject',
  }),
  'app/terraform': Object.freeze({
    planStageName: 'TerraformPlan',
    planActionName: 'PlanAppState',
    projectKey: 'terraformPlanProject',
  }),
});

const BUILD_INPUT_KEYS = [
  'backend',
  'contract',
  'execution',
  'files',
  'providerIdentity',
  'resolvedInputs',
  'runtime',
  'source',
  'targetContext',
  'terraformIdentity',
];
const EXPECTED_KEYS = BUILD_INPUT_KEYS.filter((key) => key !== 'files');
const FILE_KEYS = ['backend', 'providerLock', 'providerSelections', 'terraformIdentity', 'tfplan', 'tfplanJson'];
const MANIFEST_KEYS = [
  'backend',
  'contract',
  'execution',
  'files',
  'providerIdentity',
  'resolvedInputs',
  'runtime',
  'source',
  'target',
  'terraformIdentity',
];

/** @param {unknown} value @param {string} label @param {Set<object>} ancestors */
function rejectProxyTree(value, label, ancestors = new Set()) {
  if (typeof value !== 'object' || value === null) return;
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a Proxy.`);
  }
  if (value instanceof Uint8Array) return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch (error) {
      throw new Error(`${label} cannot be inspected safely.`, { cause: error });
    }
    for (const key of keys) {
      let descriptor;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        throw new Error(`${label} cannot be inspected safely.`, { cause: error });
      }
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxyTree(descriptor.value, label, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  rejectProxyTree(value, label);
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function authorityTree(value, label) {
  rejectProxyTree(value, label);
  try {
    return snapshotDataTree(value, label);
  } catch (error) {
    throw new Error(`${label} must contain only canonical authority data.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function sourceSha(value, label) {
  try {
    return parseGitCommitSha(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function sha256(value, label) {
  try {
    return parseSha256(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  try {
    return requireGroupedLowercaseUuid(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

/** @param {Uint8Array} value */
function bytesSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @param {keyof typeof SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS} name */
function boundedBytes(value, name) {
  const label = `Saved-plan correspondence ${name}`;
  return snapshotBoundedBytes(value, { label, maxBytes: SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS[name] });
}

/** @param {Uint8Array} bytes @param {string} label */
function utf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8.`, { cause: error });
  }
}

/** @param {Uint8Array} bytes @param {string} label */
function jsonBytes(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(utf8(bytes, label));
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`, { cause: error });
  }
  return parsed;
}

/** @param {unknown} value */
function semanticContract(value) {
  const contract = exactRecord(value, ['disposition', 'review'], 'Saved-plan correspondence contract');
  if (contract['disposition'] !== 'REVIEWABLE' && contract['disposition'] !== 'EMPTY_PLAN_SKIP') {
    throw new Error('Saved-plan correspondence disposition is invalid.');
  }
  const review = exactRecord(
    authorityTree(contract['review'], 'Saved-plan semantic review'),
    ['approval', 'authority', 'context', 'reviewType', 'summary'],
    'Saved-plan semantic review',
  );
  if (review['reviewType'] !== 'saved-plan-semantic-review') {
    throw new Error('Saved-plan correspondence requires the admitted semantic review.');
  }
  const context = exactRecord(
    review['context'],
    [
      'accountId',
      'backendKey',
      'deploymentEnvironment',
      'gate',
      'lane',
      'pipelineExecutionId',
      'region',
      'sourceSha',
      'stateIdentity',
    ],
    'Saved-plan semantic review context',
  );
  const summary = exactRecord(
    review['summary'],
    [
      'actionCounts',
      'applyable',
      'changedAddresses',
      'checkStatusCounts',
      'complete',
      'deferredChangeCount',
      'drift',
      'errored',
      'formatVersion',
      'foundationBootstrapImpact',
      'omittedChangedAddressCount',
      'outputChanges',
      'planJsonSha256',
      'terraformVersion',
      'tfplanSha256',
    ],
    'Saved-plan semantic review summary',
  );
  if (summary['formatVersion'] !== '1.2' || summary['terraformVersion'] !== TERRAFORM_VERSION) {
    throw new Error('Saved-plan semantic review tool identity is unsupported.');
  }
  return {
    disposition: /** @type {'REVIEWABLE' | 'EMPTY_PLAN_SKIP'} */ (contract['disposition']),
    review: /** @type {Readonly<Record<string, unknown>>} */ (review),
    context,
    summary,
  };
}

/** @param {Readonly<Record<string, unknown>>} context */
function gateContract(context) {
  switch (`${String(context['lane'])}/${String(context['gate'])}`) {
    case 'bootstrap/terraform':
      return GATE_CONTRACTS['bootstrap/terraform'];
    case 'foundation/terraform':
      return GATE_CONTRACTS['foundation/terraform'];
    case 'app/verifier-preflight':
      return GATE_CONTRACTS['app/verifier-preflight'];
    case 'app/terraform':
      return GATE_CONTRACTS['app/terraform'];
    default:
      throw new Error('Saved-plan correspondence lane and gate are unsupported.');
  }
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context */
function sourceBinding(value, context) {
  const source = exactRecord(
    value,
    [
      'frameworkSourceSha',
      'requestedControlSourceSha',
      'resolvedControlSourceSha',
      'selectedApplicationSourceSha',
      'sourceActionControlSourceSha',
    ],
    'Saved-plan correspondence source',
  );
  const requestedControlSourceSha = sourceSha(
    source['requestedControlSourceSha'],
    'Saved-plan requested control source SHA',
  );
  const sourceActionControlSourceSha = sourceSha(
    source['sourceActionControlSourceSha'],
    'Saved-plan Source action control source SHA',
  );
  const resolvedControlSourceSha = sourceSha(
    source['resolvedControlSourceSha'],
    'Saved-plan resolved control source SHA',
  );
  const frameworkSourceSha = sourceSha(source['frameworkSourceSha'], 'Saved-plan framework source SHA');
  assertMatchingSourcePins({
    requestedSourceSha: requestedControlSourceSha,
    sourceActionSourceSha: sourceActionControlSourceSha,
    resolvedSourceSha: resolvedControlSourceSha,
  });
  if (
    requestedControlSourceSha !== context.source.requestedControlSourceSha ||
    frameworkSourceSha !== requestedControlSourceSha ||
    frameworkSourceSha !== context.source.frameworkSourceSha
  ) {
    throw new Error('Saved-plan correspondence control source is detached from its target context.');
  }
  let selectedApplicationSourceSha = null;
  if (context.root.lane === 'app') {
    selectedApplicationSourceSha = sourceSha(
      source['selectedApplicationSourceSha'],
      'Saved-plan selected application source SHA',
    );
    if (selectedApplicationSourceSha !== context.source.selectedApplicationSourceSha) {
      throw new Error('Saved-plan selected application source is detached from its target context.');
    }
  } else if (source['selectedApplicationSourceSha'] !== null) {
    throw new Error('Saved-plan non-App source must not contain a selected application source.');
  }
  return deepFreeze({
    requestedControlSourceSha,
    sourceActionControlSourceSha,
    resolvedControlSourceSha,
    frameworkSourceSha,
    selectedApplicationSourceSha,
  });
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context */
function backendBinding(value, context) {
  const backend = exactRecord(
    value,
    ['backendKey', 'bucketName', 'encrypt', 'kmsKeyId', 'region', 'useLockfile'],
    'Saved-plan correspondence backend',
  );
  if (
    backend['bucketName'] !== context.names.terraformStateBucket ||
    backend['backendKey'] !== context.root.backendKey ||
    backend['region'] !== context.target.region ||
    backend['kmsKeyId'] !== context.names.terraformStateKmsAlias ||
    backend['encrypt'] !== true ||
    backend['useLockfile'] !== true
  ) {
    throw new Error('Saved-plan correspondence backend is detached from its target context.');
  }
  return deepFreeze({
    bucketName: /** @type {string} */ (backend['bucketName']),
    backendKey: /** @type {string} */ (backend['backendKey']),
    region: /** @type {string} */ (backend['region']),
    encrypt: /** @type {const} */ (true),
    kmsKeyId: /** @type {string} */ (backend['kmsKeyId']),
    useLockfile: /** @type {const} */ (true),
  });
}

/** @param {ReturnType<typeof backendBinding>} backend */
function renderBackend(backend) {
  return (
    `bucket       = "${backend.bucketName}"\n` +
    `key          = "${backend.backendKey}"\n` +
    `region       = "${backend.region}"\n` +
    'encrypt      = true\n' +
    `kms_key_id   = "${backend.kmsKeyId}"\n` +
    'use_lockfile = true\n'
  );
}

/** @param {unknown} value */
function terraformIdentityBinding(value) {
  const identity = exactRecord(
    value,
    ['outdated', 'platform', 'terraformVersion'],
    'Saved-plan correspondence Terraform identity',
  );
  if (
    identity['terraformVersion'] !== TERRAFORM_VERSION ||
    identity['platform'] !== TERRAFORM_PLATFORM ||
    identity['outdated'] !== false
  ) {
    throw new Error('Saved-plan correspondence Terraform identity is unsupported.');
  }
  return deepFreeze({ terraformVersion: TERRAFORM_VERSION, platform: TERRAFORM_PLATFORM, outdated: false });
}

/** @param {unknown} value */
function providerIdentityBinding(value) {
  const provider = exactRecord(
    value,
    ['address', 'providerLockSha256', 'providerSelectionsSha256', 'providerVersion'],
    'Saved-plan correspondence provider identity',
  );
  if (provider['address'] !== PROVIDER_ADDRESS || provider['providerVersion'] !== PROVIDER_VERSION) {
    throw new Error('Saved-plan correspondence provider identity is unsupported.');
  }
  return deepFreeze({
    address: PROVIDER_ADDRESS,
    providerVersion: PROVIDER_VERSION,
    providerLockSha256: sha256(provider['providerLockSha256'], 'Saved-plan provider lock SHA-256'),
    providerSelectionsSha256: sha256(
      provider['providerSelectionsSha256'],
      'Saved-plan provider-selection evidence SHA-256',
    ),
  });
}

/** @param {unknown} value @param {string} lane @param {AllowedDeploymentTarget} target */
function resolvedInputsForLane(value, lane, target) {
  if (lane !== 'app') {
    if (value !== null) {
      throw new Error('Saved-plan non-App correspondence resolved inputs must be null.');
    }
    return null;
  }
  const inputs = exactRecord(
    value,
    [
      'currentAcceptedReleaseChainSha256',
      'foundationAcceptanceKey',
      'foundationContractHash',
      'inputType',
      'proverReleaseKey',
      'releaseChainSha256',
      'toolchainReleaseKey',
    ],
    'Saved-plan App resolved inputs',
  );
  if (inputs['inputType'] !== 'app-release-chain') {
    throw new Error('Saved-plan App resolved-input type is invalid.');
  }
  const foundationAcceptanceKey = admitTerraformAcceptanceRecordKey(
    FOUNDATION_ACCEPTANCE_KIND,
    inputs['foundationAcceptanceKey'],
    target.targetKey,
  );
  const foundationContractHash = sha256(inputs['foundationContractHash'], 'Saved-plan Foundation contract hash');
  const proverReleaseKey = admitReleaseRecordKey(PROVER_RELEASE_KIND, inputs['proverReleaseKey'], target.targetKey);
  const toolchainReleaseKey = admitReleaseRecordKey(
    TOOLCHAIN_RELEASE_KIND,
    inputs['toolchainReleaseKey'],
    target.targetKey,
  );
  const releaseChainSha256 = sha256(inputs['releaseChainSha256'], 'Saved-plan release-chain SHA-256');
  const currentAcceptedReleaseChainSha256 =
    inputs['currentAcceptedReleaseChainSha256'] === null
      ? null
      : sha256(inputs['currentAcceptedReleaseChainSha256'], 'Saved-plan current accepted release-chain SHA-256');
  const expectedSha256 = canonicalJsonSha256({
    foundationAcceptanceKey,
    foundationContractHash,
    proverReleaseKey,
    toolchainReleaseKey,
  });
  if (releaseChainSha256 !== expectedSha256) {
    throw new Error('Saved-plan release-chain SHA-256 is detached from its immutable inputs.');
  }
  return deepFreeze({
    inputType: /** @type {const} */ ('app-release-chain'),
    foundationAcceptanceKey,
    foundationContractHash,
    proverReleaseKey,
    toolchainReleaseKey,
    releaseChainSha256,
    currentAcceptedReleaseChainSha256,
  });
}

/**
 * Exact-admits the closed immutable input projection carried by one saved-plan lane.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitSavedPlanResolvedInputs(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan correspondence expected target'),
  );
  const input = exactRecord(value, ['lane', 'resolvedInputs'], 'Saved-plan resolved-input admission');
  if (input['lane'] !== 'app' && input['lane'] !== 'bootstrap' && input['lane'] !== 'foundation') {
    throw new Error('Saved-plan resolved-input lane is invalid.');
  }
  return resolvedInputsForLane(input['resolvedInputs'], input['lane'], target);
}

/** @param {unknown} value @param {import('./index.js').DeploymentLaneContext} context @param {ReturnType<typeof gateContract>} gate */
function executionBinding(value, context, gate) {
  const execution = exactRecord(
    value,
    ['buildId', 'pipelineExecutionId', 'planActionExecutionId'],
    'Saved-plan correspondence execution',
  );
  const projectName = context.names[gate['projectKey']];
  const buildId = validateCodeBuildBuildId(execution['buildId'], projectName);
  return deepFreeze({
    pipelineExecutionId: uuid(execution['pipelineExecutionId'], 'Saved-plan pipeline execution ID'),
    planStageName: gate['planStageName'],
    planActionName: gate['planActionName'],
    planActionExecutionId: uuid(execution['planActionExecutionId'], 'Saved-plan Plan action execution ID'),
    buildId,
  });
}

/**
 * @param {unknown} value
 * @param {import('./index.js').DeploymentLaneContext} context
 * @param {ReturnType<typeof gateContract>} gate
 * @param {ReturnType<typeof executionBinding>} execution
 */
function runtimeBinding(value, context, gate, execution) {
  const runtime = validateCodeBuildRuntimeEvidence(
    authorityTree(value, 'Saved-plan inline Plan runtime'),
    context,
    gate['projectKey'] === 'appSignaturePreflightPlanProject'
      ? { projectKey: 'appSignaturePreflightPlanProject' }
      : undefined,
  );
  if (runtime.project.buildId !== execution.buildId) {
    throw new Error('Saved-plan inline Plan runtime is detached from its Plan action build.');
  }
  return runtime;
}

/** @param {unknown} value */
function fileBindings(value) {
  const files = exactRecord(value, FILE_KEYS, 'Saved-plan correspondence files');
  /** @type {Record<string, Uint8Array>} */
  const bytes = {};
  for (const name of FILE_KEYS) {
    bytes[name] = boundedBytes(files[name], /** @type {keyof typeof SAVED_PLAN_CORRESPONDENCE_BYTE_LIMITS} */ (name));
  }
  const terraformIdentityValue = jsonBytes(
    /** @type {Uint8Array} */ (bytes['terraformIdentity']),
    'Saved-plan Terraform identity evidence',
  );
  const admittedTerraformIdentity = validateTerraformBaselineIdentityEvidence(terraformIdentityValue);
  if (
    admittedTerraformIdentity.terraformVersion !== TERRAFORM_VERSION ||
    admittedTerraformIdentity.platform !== TERRAFORM_PLATFORM ||
    admittedTerraformIdentity.terraformOutdated !== false ||
    admittedTerraformIdentity.providerSelections[PROVIDER_ADDRESS] !== PROVIDER_VERSION
  ) {
    throw new Error('Saved-plan Terraform identity evidence is unsupported.');
  }
  validateTerraformBaselineProviderLock(/** @type {Uint8Array} */ (bytes['providerLock']), terraformIdentityValue);
  const providerSelectionsText = utf8(
    /** @type {Uint8Array} */ (bytes['providerSelections']),
    'Saved-plan provider-selection evidence',
  );
  if (
    providerSelectionsText.includes('\0') ||
    !providerSelectionsText.includes(`provider[${PROVIDER_ADDRESS}] ${PROVIDER_VERSION}`)
  ) {
    throw new Error('Saved-plan provider-selection evidence is unsupported.');
  }
  return {
    bytes,
    metadata: deepFreeze(
      Object.fromEntries(
        FILE_KEYS.map((name) => [
          name,
          deepFreeze({
            byteLength: /** @type {Uint8Array} */ (bytes[name]).byteLength,
            sha256: bytesSha256(/** @type {Uint8Array} */ (bytes[name])),
          }),
        ]),
      ),
    ),
  };
}

/** @param {ReturnType<typeof fileBindings>} fileSet @param {string} name */
function boundFileBytes(fileSet, name) {
  const value = fileSet.bytes[name];
  if (value === undefined) {
    throw new Error('Saved-plan correspondence file binding is incomplete.');
  }
  return value;
}

/** @param {ReturnType<typeof fileBindings>} fileSet @param {string} name */
function boundFileMetadata(fileSet, name) {
  const value = fileSet.metadata[name];
  if (value === undefined) {
    throw new Error('Saved-plan correspondence file metadata is incomplete.');
  }
  return value;
}

/**
 * Builds the exact correspondence between a saved Terraform binary and its review inputs.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function buildSavedPlanCorrespondence(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan correspondence expected target'),
  );
  const input = exactRecord(value, BUILD_INPUT_KEYS, 'Saved-plan correspondence input');
  const semantic = semanticContract(input['contract']);
  const context = parseDeploymentLaneContext(
    authorityTree(input['targetContext'], 'Saved-plan correspondence target context'),
  );
  if (context.target.accountLabel !== target.accountLabel || context.target.environmentId !== target.environmentId) {
    throw new Error('Saved-plan correspondence target context does not match the expected target.');
  }
  const gate = gateContract(semantic.context);
  if (
    semantic.context['accountId'] !== context.target.accountId ||
    semantic.context['backendKey'] !== context.root.backendKey ||
    semantic.context['deploymentEnvironment'] !== context.target.environmentId ||
    semantic.context['lane'] !== context.root.lane ||
    semantic.context['region'] !== context.target.region ||
    semantic.context['sourceSha'] !== context.source.requestedControlSourceSha ||
    semantic.context['stateIdentity'] !== context.root.stateIdentity
  ) {
    throw new Error('Saved-plan semantic review is detached from its target context.');
  }
  const source = sourceBinding(input['source'], context);
  const backend = backendBinding(input['backend'], context);
  const execution = executionBinding(input['execution'], context, gate);
  if (semantic.context['pipelineExecutionId'] !== execution.pipelineExecutionId) {
    throw new Error('Saved-plan semantic review is detached from its pipeline execution.');
  }
  const terraformIdentity = terraformIdentityBinding(input['terraformIdentity']);
  const providerIdentity = providerIdentityBinding(input['providerIdentity']);
  const runtime = runtimeBinding(input['runtime'], context, gate, execution);
  const resolvedInputs = resolvedInputsForLane(input['resolvedInputs'], context.root.lane, target);
  const fileSet = fileBindings(input['files']);
  if (utf8(boundFileBytes(fileSet, 'backend'), 'Saved-plan backend evidence') !== renderBackend(backend)) {
    throw new Error('Saved-plan backend bytes do not match the exact structured backend.');
  }
  const tfplanSha256 = boundFileMetadata(fileSet, 'tfplan').sha256;
  const tfplanJsonSha256 = boundFileMetadata(fileSet, 'tfplanJson').sha256;
  if (
    sha256(semantic.summary['tfplanSha256'], 'Saved-plan semantic review tfplan SHA-256') !== tfplanSha256 ||
    sha256(semantic.summary['planJsonSha256'], 'Saved-plan semantic review plan JSON SHA-256') !== tfplanJsonSha256
  ) {
    throw new Error('Saved-plan binary or JSON bytes do not match the semantic review.');
  }
  const rebuiltReview = (() => {
    try {
      return buildSavedPlanSemanticReview(
        {
          context: semantic.review['context'],
          plan: {
            planJson: jsonBytes(boundFileBytes(fileSet, 'tfplanJson'), 'Saved-plan Terraform plan JSON'),
            planJsonSha256: tfplanJsonSha256,
            tfplanSha256,
          },
          approval: semantic.review['approval'],
          authority: semantic.review['authority'],
        },
        target.targetKey,
      );
    } catch (error) {
      throw new Error('Saved-plan semantic review does not admit the exact Terraform plan JSON.', { cause: error });
    }
  })();
  if (canonicalJson(rebuiltReview) !== canonicalJson(semantic.review)) {
    throw new Error('Saved-plan semantic review does not match the exact Terraform plan JSON.');
  }
  const classified = classifySavedPlanDisposition(
    {
      review: rebuiltReview,
      appReleaseChain:
        resolvedInputs === null || resolvedInputs.currentAcceptedReleaseChainSha256 === null
          ? null
          : {
              deploymentMode: 'normal',
              selectedReleaseChainSha256: resolvedInputs.releaseChainSha256,
              currentAcceptedReleaseChainSha256: resolvedInputs.currentAcceptedReleaseChainSha256,
            },
    },
    target.targetKey,
  );
  if (classified.disposition !== semantic.disposition) {
    throw new Error('Saved-plan correspondence disposition is detached from its semantic review.');
  }
  if (context.root.lane === 'app') {
    const selectedReviewSource =
      semantic.context['gate'] === 'terraform'
        ? exactRecord(
            classified.review.approval,
            [
              'accountId',
              'controlSourceSha',
              'deploymentEnvironment',
              'deploymentMode',
              'reviewedPlanChecksum',
              'selectedSourceSha',
            ],
            'Saved-plan App semantic approval',
          )['selectedSourceSha']
        : exactRecord(
            classified.review.authority,
            [
              'assetManifestSha256',
              'authorityType',
              'expectedFunctionVersion',
              'foundationAcceptance',
              'package',
              'packageSourceSha',
              'proverImageDigest',
              'reconciliationDesiredSha256',
              'sourceCodeHash',
              'trustRootSha256',
            ],
            'Saved-plan verifier semantic authority',
          )['packageSourceSha'];
    if (
      sourceSha(selectedReviewSource, 'Saved-plan semantic review selected source SHA') !==
      source.selectedApplicationSourceSha
    ) {
      throw new Error('Saved-plan semantic review is detached from its selected application source.');
    }
  }
  const approval = exactRecord(
    semantic.review['approval'],
    context.root.lane === 'app' && semantic.context['gate'] === 'terraform'
      ? [
          'accountId',
          'controlSourceSha',
          'deploymentEnvironment',
          'deploymentMode',
          'reviewedPlanChecksum',
          'selectedSourceSha',
        ]
      : ['accountId', 'deploymentEnvironment', 'reviewedPlanChecksum', 'sourceSha'],
    'Saved-plan semantic approval',
  );
  if (approval['reviewedPlanChecksum'] !== tfplanSha256) {
    throw new Error('Saved-plan semantic approval checksum does not match the saved binary.');
  }
  if (
    providerIdentity.providerLockSha256 !== boundFileMetadata(fileSet, 'providerLock').sha256 ||
    providerIdentity.providerSelectionsSha256 !== boundFileMetadata(fileSet, 'providerSelections').sha256
  ) {
    throw new Error('Saved-plan provider identity is detached from its exact evidence bytes.');
  }
  const manifest = {
    target: {
      targetKey: target.targetKey,
      accountId: context.target.accountId,
      region: context.target.region,
      deploymentEnvironment: context.target.environmentId,
      lane: context.root.lane,
      gate: semantic.context['gate'],
      stateIdentity: context.root.stateIdentity,
      targetConfigurationSha256: context.targetConfigurationSha256,
      targetContextSha256: canonicalJsonSha256(context),
    },
    contract: {
      disposition: semantic.disposition,
      review: semantic.review,
    },
    source,
    backend,
    execution,
    terraformIdentity,
    providerIdentity,
    resolvedInputs,
    runtime,
    files: fileSet.metadata,
  };
  exactRecord(manifest, MANIFEST_KEYS, 'Saved-plan correspondence manifest');
  return deepFreeze(manifest);
}

/**
 * Exact-admits canonical correspondence bytes and every raw file they bind.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 */
export function admitSavedPlanCorrespondence(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Saved-plan correspondence expected target'),
  );
  const input = exactRecord(value, ['expected', 'files', 'manifestBody'], 'Saved-plan correspondence admission input');
  const expected = exactRecord(input['expected'], EXPECTED_KEYS, 'Saved-plan correspondence expectations');
  const manifestBody = boundedBytes(input['manifestBody'], 'manifest');
  const admitted = buildSavedPlanCorrespondence({ ...expected, files: input['files'] }, target.targetKey);
  if (utf8(manifestBody, 'Saved-plan correspondence manifest') !== canonicalRecordJson(admitted)) {
    throw new Error('Saved-plan correspondence manifest does not match its expected authority and files.');
  }
  return admitted;
}
