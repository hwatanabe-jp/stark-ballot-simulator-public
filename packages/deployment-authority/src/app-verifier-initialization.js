/** Closed first-verifier configuration; it never authorizes an ordinary App Apply. */
import {
  admitAppImageSignatureVerifierRetainedState,
  projectAppImageSignatureVerifierRuntimeBranches,
} from './app-image-signature-verifier-reconciliation.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { assertProxyFreePortData } from './conditional-object-ledger.js';
import {
  parseDeploymentLaneContext,
  renderDeploymentLaneContext,
  parseDigestPinnedImageReference,
  parseS3VersionId,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  validateAwsSsoCallerIdentityForPermissionSet,
} from './index.js';
import {
  assertNeverPublishedS3Object,
  canonicalJson,
  deepFreeze,
  isPlainRecord,
  parseGitCommitSha,
  requireGroupedLowercaseUuid,
} from './internal.js';

export const APP_INITIALIZATION_VARIABLE = 'AppInputMode';
const APP_EXECUTION_VARIABLE_NAMES = Object.freeze([
  'DeploymentMode',
  'DynamoDbRecoveryPhase',
  'SelectedAcceptanceKey',
  'DynamoDbRecoveryManifestKey',
  'DynamoDbRecoveryManifestVersionId',
  'DynamoDbRecoveryManifestSha256',
  APP_INITIALIZATION_VARIABLE,
]);

/**
 * Admit an explicit initial production execution before selecting any missing
 * authority. An accepted execution never falls back based on S3 errors.
 * @param {unknown} value
 * @param {unknown} contextValue
 * @param {unknown} executionIdValue
 * @param {string} expectedTargetKey
 */
export function selectAppInitializationExecution(value, contextValue, executionIdValue, expectedTargetKey) {
  assertProxyFreePortData(value, 'App initialization execution response');
  resolveAppVerifierInitializationScope('prerequisite', expectedTargetKey);
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const context = parseDeploymentLaneContext(contextValue);
  const executionId = requireGroupedLowercaseUuid(executionIdValue, 'App initialization execution ID');
  if (
    context.root.lane !== 'app' ||
    context.target.accountLabel !== target.accountLabel ||
    context.target.environmentId !== target.environmentId ||
    context.source.requestedControlSourceSha !== context.source.frameworkSourceSha
  ) {
    throw new Error('App initialization context does not match its independently selected target/source.');
  }
  const response = record(
    snapshotDataTree(value, 'App initialization execution response'),
    'App initialization execution response',
  );
  const execution = record(response['pipelineExecution'], 'App initialization execution');
  if (
    execution['pipelineName'] !== context.names.pipeline ||
    execution['pipelineExecutionId'] !== executionId ||
    execution['status'] !== 'InProgress' ||
    (Object.hasOwn(execution, 'executionType') && execution['executionType'] !== 'STANDARD') ||
    Object.hasOwn(execution, 'rollbackMetadata')
  ) {
    throw new Error('App initialization requires the exact running standard pipeline execution.');
  }
  const revisions = execution['artifactRevisions'];
  if (
    !Array.isArray(revisions) ||
    revisions.length !== 1 ||
    !isPlainRecord(revisions[0]) ||
    revisions[0]['name'] !== 'SourceOutput' ||
    revisions[0]['revisionId'] !== context.source.requestedControlSourceSha
  ) {
    throw new Error('App initialization execution is detached from its exact source.');
  }
  const variables = execution['variables'];
  if (!Array.isArray(variables) || variables.length !== APP_EXECUTION_VARIABLE_NAMES.length)
    throw new Error('App initialization execution variables must use the exact reviewed shape.');
  const selected = new Map();
  for (const entry of variables) {
    const variable = exact(entry, ['name', 'resolvedValue'], 'App initialization variable');
    const name = variable['name'];
    if (
      typeof name !== 'string' ||
      !APP_EXECUTION_VARIABLE_NAMES.includes(name) ||
      selected.has(name) ||
      typeof variable['resolvedValue'] !== 'string'
    )
      throw new Error('App initialization variable is unknown, duplicated, or malformed.');
    selected.set(name, variable['resolvedValue']);
  }
  const mode = selected.get(APP_INITIALIZATION_VARIABLE);
  if (mode === 'accepted') return null;
  if (mode !== 'verifier-prerequisite' && mode !== 'initial')
    throw new Error('App input mode must be accepted, verifier-prerequisite, or initial.');
  if (
    context.source.selectedApplicationSourceSha !== context.source.requestedControlSourceSha ||
    selected.get('DeploymentMode') !== 'normal' ||
    selected.get('DynamoDbRecoveryPhase') !== 'primary_active' ||
    selected.get('SelectedAcceptanceKey') !== '__NOT_APPLICABLE__' ||
    ['DynamoDbRecoveryManifestKey', 'DynamoDbRecoveryManifestVersionId', 'DynamoDbRecoveryManifestSha256'].some(
      (name) => selected.get(name) !== '__DISABLED__',
    )
  ) {
    throw new Error(
      'App initialization requires normal deployment with primary tables and no recovery or rollback selection.',
    );
  }
  const trigger = record(execution['trigger'], 'App initialization trigger');
  if (trigger['triggerType'] !== 'StartPipelineExecution')
    throw new Error('App initialization requires an explicit administrator start.');
  const { arn: administratorArn } = validateAwsSsoCallerIdentityForPermissionSet(
    { Account: target.accountId, Arn: trigger['triggerDetail'] },
    target,
    'AdministratorAccess',
  );
  return deepFreeze({
    mode,
    pipelineExecutionId: executionId,
    sourceSha: context.source.requestedControlSourceSha,
    administratorArn,
  });
}

const RESOURCE_ADDRESSES = Object.freeze([
  'aws_cloudwatch_log_group.image_signature_verifier',
  'aws_iam_role.image_signature_verifier',
  'aws_iam_role_policy.image_signature_verifier',
  'aws_lambda_alias.image_signature_verifier_preflight',
  'aws_lambda_alias.image_signature_verifier_runtime',
  'aws_lambda_function.image_signature_verifier',
  'terraform_data.image_signature_verifier_permissions_boundary_authority',
  'terraform_data.image_signature_verifier_reconciliation_authority',
]);
const DATA_ADDRESSES = Object.freeze([
  'data.aws_caller_identity.current',
  'data.aws_iam_policy.image_signature_verifier_permissions_boundary',
  'data.aws_iam_policy_document.image_signature_verifier',
  'data.aws_iam_policy_document.target_lambda_assume_role',
  'data.aws_region.current',
]);
const SOURCE_FILES = Object.freeze([
  'backend.tf',
  'deployment_authority.tf',
  'image_signature_verifier.tf',
  'image_signature_verifier_iam.tf',
  'image_signature_verifier_inputs.tf',
  'image_signature_verifier_locals.tf',
  'image_signature_verifier_logs.tf',
  'image_signature_verifier_variables.tf',
  'storage_retention.tf',
  'target_identity.tf',
  'target_identity_variables.tf',
  'versions.tf',
]);

/** @param {unknown} value @param {string} label */
function record(value, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}
/** @param {unknown} value @param {string} label */
function snapshot(value, label) {
  assertProxyFreePortData(value, label);
  return snapshotDataTree(value, label);
}
/** @param {unknown} value @param {readonly string[]} expected @param {string} label */
function exact(value, expected, label) {
  return snapshotExactRecord(snapshot(value, label), expected, label);
}
/** @param {unknown} value @param {readonly string[]} expected @param {string} label */
function exactStrings(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string') ||
    canonicalJson([...value].sort()) !== canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label} must contain exactly the governed values.`);
  }
}

/** @param {unknown} phase @param {string} expectedTargetKey */
export function resolveAppVerifierInitializationScope(phase, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  if (target.environmentTier !== 'production' || target.environmentId !== 'main') {
    throw new Error('Verifier initialization requires the reviewed production target.');
  }
  if (phase !== 'prerequisite' && phase !== 'preflight') {
    throw new Error('Verifier initialization phase must be prerequisite or preflight.');
  }
  return deepFreeze({
    phase,
    sourceFiles: SOURCE_FILES,
    resourceAddresses: RESOURCE_ADDRESSES,
    dataAddresses: DATA_ADDRESSES,
  });
}

/** @param {unknown} value @param {unknown} sourceValue @param {string} expectedTargetKey */
function admitInitializationPackage(value, sourceValue, expectedTargetKey) {
  const sourceSha = parseGitCommitSha(sourceValue, 'Verifier initialization package source SHA');
  const app = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget(expectedTargetKey), 'app');
  const artifact = exact(
    value,
    ['s3_bucket', 's3_key', 's3_object_version', 'source_code_hash', 'asset_manifest_sha256', 'trust_root_sha256'],
    'Verifier initialization package',
  );
  if (
    artifact['s3_bucket'] !== app.names.appRetainedArtifactBucket ||
    artifact['s3_key'] !== `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip`
  ) {
    throw new Error('Verifier initialization package must use its exact source-addressed target family.');
  }
  const sourceCodeHash = artifact['source_code_hash'];
  if (
    typeof sourceCodeHash !== 'string' ||
    Buffer.from(sourceCodeHash, 'base64').length !== 32 ||
    Buffer.from(sourceCodeHash, 'base64').toString('base64') !== sourceCodeHash
  ) {
    throw new Error('Verifier initialization source-code hash must be a canonical base64 SHA-256.');
  }
  return {
    s3_bucket: app.names.appRetainedArtifactBucket,
    s3_key: `${app.names.lambdaArtifactPrefix}/${sourceSha}/image-signature-verifier.zip`,
    s3_object_version: parseS3VersionId(artifact['s3_object_version'], 'Verifier initialization package VersionId'),
    source_code_hash: sourceCodeHash,
    asset_manifest_sha256: parseSha256(
      artifact['asset_manifest_sha256'],
      'Verifier initialization asset manifest SHA-256',
    ),
    trust_root_sha256: parseSha256(artifact['trust_root_sha256'], 'Verifier initialization trust-root SHA-256'),
  };
}

/** @param {unknown} value @param {string} expectedTargetKey */
export function buildAppVerifierInitializationInputs(value, expectedTargetKey) {
  const input = exact(value, ['context', 'phase', 'package', 'proverImageUri'], 'Verifier initialization inputs');
  const scope = resolveAppVerifierInitializationScope(input['phase'], expectedTargetKey);
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const context = parseDeploymentLaneContext(input['context']);
  if (
    context.root.lane !== 'app' ||
    `${context.target.accountLabel}/${context.target.environmentId}` !== expectedTargetKey ||
    context.source.requestedControlSourceSha !== context.source.selectedApplicationSourceSha ||
    context.source.frameworkSourceSha !== context.source.selectedApplicationSourceSha
  ) {
    throw new Error('Verifier initialization requires the exact main App source and target.');
  }
  const admittedArtifact = admitInitializationPackage(
    input['package'],
    context.source.selectedApplicationSourceSha,
    expectedTargetKey,
  );
  const prover = resolveDeploymentLaneAuthority(target, 'prover');
  const proverImage = parseDigestPinnedImageReference(input['proverImageUri'], {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: prover.names.proverRepository,
  });
  return deepFreeze({
    aws_account_id: target.accountId,
    aws_region: target.region,
    account_alias: target.accountLabel,
    deployment_environment: target.environmentId,
    state_scope: app.scope,
    project_name: target.projectId,
    state_backend_key: app.backendKey,
    deploy_mode: 'normal',
    verifier_phase: scope.phase,
    image_signature_verifier_permissions_boundary_arn: `arn:${target.partition}:iam::${target.accountId}:policy/${app.names.signatureVerifierPermissionsBoundary}`,
    lambda_runtime: 'nodejs24.x',
    image_signature_verifier_lambda_timeout_seconds: 120,
    image_signature_verifier_step_timeout_seconds: 130,
    image_signature_verifier_handler_deadline_ms: 100000,
    image_signature_verifier_process_timeout_ms: 60000,
    image_signature_status_max_attempts: 4,
    image_signature_status_attempt_timeout_ms: 4000,
    image_signature_status_retry_delay_ms: 5000,
    image_signature_verifier_base_prover_image_uri: null,
    image_signature_verifier_reconciled_function_version: null,
    image_signature_verifier_reconciliation_desired_json: null,
    image_signature_verifier_reconciliation_desired_sha256: null,
    image_signature_verifier_selected_authority: null,
    lambda_artifacts: { image_signature_verifier: admittedArtifact },
    prover_image_uri: proverImage.imageUri,
    image_signature_preflight_prover_image_uri: proverImage.imageUri,
  });
}

/** @param {unknown} value */
function sensitive(value) {
  return (
    value === true ||
    (Array.isArray(value) ? value.some(sensitive) : isPlainRecord(value) && Object.values(value).some(sensitive))
  );
}

/** @param {unknown} value @param {unknown} inputValue @param {string} expectedTargetKey */
export function validateAppVerifierPrerequisitePlan(value, inputValue, expectedTargetKey) {
  const inputs = buildAppVerifierInitializationInputs(inputValue, expectedTargetKey);
  if (inputs.verifier_phase !== 'prerequisite') throw new Error('Only prerequisite inputs admit verifier creation.');
  const scope = resolveAppVerifierInitializationScope('prerequisite', expectedTargetKey);
  const plan = record(snapshot(value, 'Verifier prerequisite saved plan'), 'Verifier prerequisite saved plan');
  if (plan['format_version'] !== '1.2' || plan['errored'] === true || plan['applyable'] === false)
    throw new Error('Verifier prerequisite saved plan must be complete and applyable.');
  if (plan['resource_drift'] !== undefined && canonicalJson(plan['resource_drift']) !== '[]')
    throw new Error('Verifier prerequisite rejects resource drift.');
  const variables = record(plan['variables'], 'Verifier prerequisite variables');
  exactStrings(Object.keys(variables), Object.keys(inputs), 'Verifier prerequisite complete variable set');
  for (const [name, expected] of Object.entries(inputs)) {
    const actual = exact(variables[name], ['value'], `Verifier prerequisite variable ${name}`);
    if (canonicalJson(actual['value']) !== canonicalJson(expected))
      throw new Error(`Verifier prerequisite variable ${name} is detached from its reviewed inputs.`);
  }
  const configuration = record(
    record(plan['configuration'], 'Verifier prerequisite configuration')['root_module'],
    'Verifier prerequisite root',
  );
  if (
    configuration['module_calls'] !== undefined &&
    Object.keys(record(configuration['module_calls'], 'Verifier prerequisite modules')).length > 0
  )
    throw new Error('Verifier prerequisite rejects modules.');
  if (!Array.isArray(configuration['resources']))
    throw new Error('Verifier prerequisite configuration resources are required.');
  exactStrings(
    configuration['resources'].map((entry) => record(entry, 'Verifier prerequisite resource')['address']),
    [...scope.resourceAddresses, ...scope.dataAddresses],
    'Verifier prerequisite configuration',
  );
  const changes = plan['resource_changes'];
  if (!Array.isArray(changes)) throw new Error('Verifier prerequisite resource changes are required.');
  const managed = [];
  for (const entry of changes) {
    const resource = record(entry, 'Verifier prerequisite resource change');
    const change = record(resource['change'], 'Verifier prerequisite change');
    if (
      Object.hasOwn(resource, 'previous_address') ||
      Object.hasOwn(change, 'importing') ||
      sensitive(change['before_sensitive']) ||
      sensitive(change['after_sensitive'])
    )
      throw new Error('Verifier prerequisite rejects moves, imports and sensitive changes.');
    if (resource['mode'] === 'data') {
      if (
        typeof resource['address'] !== 'string' ||
        !scope.dataAddresses.includes(resource['address']) ||
        !['["read"]', '["no-op"]'].includes(canonicalJson(change['actions']))
      )
        throw new Error('Verifier prerequisite data read is outside its scope.');
      continue;
    }
    if (
      resource['mode'] !== 'managed' ||
      change['before'] !== null ||
      canonicalJson(change['actions']) !== '["create"]'
    )
      throw new Error('Verifier prerequisite requires every managed resource to be newly created.');
    managed.push(resource['address']);
    if (
      resource['address'] === 'terraform_data.image_signature_verifier_reconciliation_authority' &&
      record(change['after'], 'Initial reconciliation record')['input'] !== null
    )
      throw new Error('Verifier prerequisite cannot fabricate reconciliation authority.');
    if (
      resource['address'] === 'aws_lambda_function.image_signature_verifier' &&
      record(change['after'], 'Initial verifier function')['publish'] !== true
    )
      throw new Error('Verifier prerequisite must publish its real immutable FunctionVersion.');
  }
  exactStrings(managed, scope.resourceAddresses, 'Verifier prerequisite managed changes');
  const outputs = record(plan['output_changes'], 'Verifier prerequisite outputs');
  exactStrings(Object.keys(outputs), ['image_signature_preflight'], 'Verifier prerequisite output names');
  const output = record(outputs['image_signature_preflight'], 'Verifier prerequisite output');
  if (
    canonicalJson(output['actions']) !== '["create"]' ||
    output['before'] !== null ||
    sensitive(output['after_sensitive'])
  )
    throw new Error('Verifier prerequisite must create only its nonsecret verifier output.');
  return deepFreeze({
    evidenceType: 'image-signature-verifier-prerequisite-plan',
    disposition: 'create-only',
    changedResources: [...scope.resourceAddresses],
    changedOutputs: ['image_signature_preflight'],
  });
}

/**
 * Distinguish the initial review without making ordinary reconciled authority
 * nullable. The caller still admits the complete review shape and context.
 * @param {unknown} value
 * @param {string} expectedTargetKey
 */
export function isAppVerifierPrerequisiteReview(value, expectedTargetKey) {
  const authority = record(snapshot(value, 'Verifier review authority'), 'Verifier review authority');
  if (authority['authorityType'] !== 'app-verifier-prerequisite') return false;
  resolveAppVerifierInitializationScope('prerequisite', expectedTargetKey);
  if (authority['expectedFunctionVersion'] !== null || authority['reconciliationDesiredSha256'] !== null) {
    throw new Error('Verifier prerequisite review requires explicit null version and reconciliation authority.');
  }
  return true;
}

/**
 * Reproduce the initial review from actual evaluated plan variables and the
 * independently admitted source/package/release authority.
 * @param {unknown} planValue
 * @param {unknown} authorityValue
 * @param {unknown} contextValue
 * @param {string} expectedTargetKey
 */
export function assertAppVerifierPrerequisiteReviewPlan(planValue, authorityValue, contextValue, expectedTargetKey) {
  if (!isAppVerifierPrerequisiteReview(authorityValue, expectedTargetKey))
    throw new Error('Verifier prerequisite review discriminator is required.');
  const authority = record(authorityValue, 'Verifier prerequisite review');
  const context = record(contextValue, 'Verifier prerequisite review context');
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  const prover = resolveDeploymentLaneAuthority(target, 'prover');
  if (
    context['lane'] !== 'app' ||
    context['gate'] !== 'verifier-preflight' ||
    context['accountId'] !== target.accountId ||
    context['region'] !== target.region ||
    context['stateIdentity'] !== app.stateIdentity ||
    context['backendKey'] !== app.backendKey ||
    context['deploymentEnvironment'] !== target.environmentId ||
    context['sourceSha'] !== authority['packageSourceSha']
  )
    throw new Error('Verifier prerequisite review is detached from its source and target context.');
  const plan = record(planValue, 'Verifier prerequisite plan');
  const variables = record(plan['variables'], 'Verifier prerequisite variables');
  const imageUri = record(variables['prover_image_uri'], 'Verifier prerequisite Prover image')['value'];
  const image = parseDigestPinnedImageReference(imageUri, {
    partition: target.partition,
    accountId: target.accountId,
    region: target.region,
    repository: prover.names.proverRepository,
  });
  if (image.digest !== authority['proverImageDigest'])
    throw new Error('Verifier prerequisite plan is detached from its reviewed Prover digest.');
  const packageReference = record(authority['package'], 'Verifier prerequisite reviewed package');
  const packageSha256 = parseSha256(packageReference['sha256'], 'Verifier prerequisite package SHA-256');
  if (Buffer.from(packageSha256, 'hex').toString('base64') !== authority['sourceCodeHash'])
    throw new Error('Verifier prerequisite package and Lambda code hashes disagree.');
  const laneContext = renderDeploymentLaneContext({
    target,
    lane: 'app',
    accountId: target.accountId,
    requestedControlSourceSha: context['sourceSha'],
    selectedApplicationSourceSha: context['sourceSha'],
    frameworkSourceSha: context['sourceSha'],
  });
  return validateAppVerifierPrerequisitePlan(
    plan,
    {
      context: laneContext,
      phase: 'prerequisite',
      proverImageUri: imageUri,
      package: {
        s3_bucket: app.names.appRetainedArtifactBucket,
        s3_key: packageReference['key'],
        s3_object_version: packageReference['versionId'],
        source_code_hash: authority['sourceCodeHash'],
        asset_manifest_sha256: authority['assetManifestSha256'],
        trust_root_sha256: authority['trustRootSha256'],
      },
    },
    expectedTargetKey,
  );
}

/**
 * Admit complete read-only S3 evidence, never a failed HEAD/GET, for one of
 * the two exact objects that must never have existed before initialization.
 * @param {unknown} value
 * @param {'state' | 'acceptance'} kind
 * @param {string} expectedTargetKey
 */
export function assertAppInitializationObjectNeverPublished(value, kind, expectedTargetKey) {
  resolveAppVerifierInitializationScope('prerequisite', expectedTargetKey);
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const app = resolveDeploymentLaneAuthority(target, 'app');
  if (kind !== 'state' && kind !== 'acceptance') throw new Error('App initialization object family is invalid.');
  const bucket = kind === 'state' ? app.names.terraformStateBucket : app.names.appRetainedArtifactBucket;
  const key = kind === 'state' ? app.backendKey : app.names.acceptedDeploymentPointerKey;
  assertNeverPublishedS3Object(
    snapshotDataTree(value, 'App initialization absence observations'),
    { bucket, key, allowStateLockSuffix: kind === 'state' },
    'App initialization',
  );
  return deepFreeze({ bucket, key });
}

/**
 * Project real prerequisite or successfully applied preflight state into the
 * ordinary reconciler's retained function input. This is available only during an explicit initial execution;
 * it does not invent a target_runtime output or historical reconciliation.
 * @param {unknown} value
 * @param {string} expectedTargetKey
 */
export function selectInitialVerifierRuntimeAuthority(value, expectedTargetKey) {
  const input = exact(
    value,
    ['context', 'state', 'execution', 'executionId', 'package', 'proverImageUri'],
    'Initial verifier state selection',
  );
  const context = parseDeploymentLaneContext(input['context']);
  const selection = selectAppInitializationExecution(
    input['execution'],
    context,
    input['executionId'],
    expectedTargetKey,
  );
  if (selection?.mode !== 'initial')
    throw new Error('Initial verifier state requires an explicit initial App execution.');
  const expected = buildAppVerifierInitializationInputs(
    { context, phase: 'prerequisite', package: input['package'], proverImageUri: input['proverImageUri'] },
    expectedTargetKey,
  );
  const target = resolveAllowedDeploymentTarget(expectedTargetKey);
  const scope = resolveAppVerifierInitializationScope('prerequisite', expectedTargetKey);
  const state = record(snapshot(input['state'], 'Initial verifier state'), 'Initial verifier state');
  const values = record(state['values'], 'Initial verifier state values');
  const root = record(values['root_module'], 'Initial verifier state root');
  if (root['child_modules'] !== undefined && canonicalJson(root['child_modules']) !== '[]')
    throw new Error('Initial verifier state must not contain child modules.');
  if (!Array.isArray(root['resources'])) throw new Error('Initial verifier state resources are required.');
  const resources = new Map();
  const managed = [];
  for (const entry of root['resources']) {
    const resource = record(entry, 'Initial verifier state resource');
    const address = resource['address'];
    if (typeof address !== 'string') throw new Error('Initial verifier resource address is invalid.');
    if (resources.has(address)) throw new Error('Initial verifier state contains duplicate resources.');
    if (resource['mode'] === 'managed' && scope.resourceAddresses.includes(address)) managed.push(address);
    else if (resource['mode'] !== 'data' || !scope.dataAddresses.includes(address))
      throw new Error('Initial verifier state contains unrelated resources.');
    resources.set(address, record(resource['values'], 'Initial verifier resource values'));
  }
  exactStrings(managed, scope.resourceAddresses, 'Initial verifier managed state');
  const outputs = record(values['outputs'], 'Initial verifier outputs');
  exactStrings(Object.keys(outputs), ['image_signature_preflight'], 'Initial verifier output set');
  const output = record(
    record(outputs['image_signature_preflight'], 'Initial verifier output')['value'],
    'Initial verifier authority',
  );
  const version = output['function_version'];
  if (typeof version !== 'string' || !/^[1-9][0-9]{0,19}$/.test(version))
    throw new Error('Initial verifier must retain a real immutable FunctionVersion.');
  const functionArn = `arn:${target.partition}:lambda:${target.region}:${target.accountId}:function:${context.names.signatureVerifierFunction}`;
  const retainedPackage = record(output['package'], 'Initial verifier retained package');
  const key = retainedPackage['s3_key'];
  const sourceSha = typeof key === 'string' ? key.split('/').at(-2) : null;
  const artifact = admitInitializationPackage(retainedPackage, sourceSha, expectedTargetKey);
  if (output['function_arn'] !== functionArn || output['preflight_alias_arn'] !== `${functionArn}:preflight`)
    throw new Error('Initial verifier output is detached from its target function.');
  const fn = resources.get('aws_lambda_function.image_signature_verifier');
  if (
    fn['publish'] !== true ||
    fn['function_name'] !== context.names.signatureVerifierFunction ||
    fn['arn'] !== functionArn
  )
    throw new Error('Initial verifier state function is detached from its governed identity.');
  const reconciliation = resources.get('terraform_data.image_signature_verifier_reconciliation_authority');
  const untouched =
    reconciliation['input'] === null &&
    reconciliation['output'] === null &&
    reconciliation['triggers_replace'] === null;
  const desired = untouched
    ? null
    : admitAppImageSignatureVerifierRetainedState(
        {
          input: reconciliation['input'],
          output: reconciliation['output'],
          triggers_replace: reconciliation['triggers_replace'],
        },
        expectedTargetKey,
      );
  const branches =
    desired === null ? null : projectAppImageSignatureVerifierRuntimeBranches(desired, expectedTargetKey);
  for (const name of ['preflight', 'runtime']) {
    const alias = resources.get(`aws_lambda_alias.image_signature_verifier_${name}`);
    const expectedVersion =
      branches === null
        ? version
        : name === 'runtime'
          ? branches.retained.functionVersion
          : branches.candidate.functionVersion;
    if (
      alias['name'] !== name ||
      alias['function_name'] !== context.names.signatureVerifierFunction ||
      alias['function_version'] !== expectedVersion ||
      alias['arn'] !== `${functionArn}:${name}`
    )
      throw new Error('Initial verifier alias is detached from its retained immutable FunctionVersion.');
  }
  const role = resources.get('aws_iam_role.image_signature_verifier');
  if (
    role['arn'] !== `arn:${target.partition}:iam::${target.accountId}:role/${context.names.signatureVerifierRole}` ||
    role['permissions_boundary'] !== expected.image_signature_verifier_permissions_boundary_arn
  )
    throw new Error('Initial verifier role is detached from its governed boundary.');
  const observedOutput = {
    functionVersion: version,
    package: {
      assetManifestSha256: artifact.asset_manifest_sha256,
      codeSha256: artifact.source_code_hash,
      s3Bucket: artifact.s3_bucket,
      s3Key: artifact.s3_key,
      s3ObjectVersionId: artifact.s3_object_version,
      trustRootSha256: artifact.trust_root_sha256,
      zipSha256: Buffer.from(artifact.source_code_hash, 'base64').toString('hex'),
    },
  };
  if (branches !== null) {
    // A targeted preflight leaves the mutable function outside its saved plan.
    // The root output may still describe the retained function after a failed
    // post-check, or the candidate after the ordinary output rendering succeeds.
    // Neither selects runtime: applied reconciliation and both aliases do.
    const matchesBranch = [branches.candidate, branches.retained].some(
      (branch) =>
        canonicalJson(observedOutput) ===
        canonicalJson({ functionVersion: branch.functionVersion, package: branch.package }),
    );
    if (!matchesBranch)
      throw new Error('Initial verifier output is detached from its applied reconciliation branches.');
    return branches.retained;
  }
  if (
    fn['version'] !== version ||
    fn['s3_bucket'] !== artifact.s3_bucket ||
    fn['s3_key'] !== artifact.s3_key ||
    fn['s3_object_version'] !== artifact.s3_object_version ||
    fn['source_code_hash'] !== artifact.source_code_hash
  )
    throw new Error('Initial verifier state function is detached from its real version/package.');
  const environment = fn['environment'];
  if (!Array.isArray(environment) || environment.length !== 1)
    throw new Error('Initial verifier function environment is invalid.');
  const variables = record(
    record(environment[0], 'Initial verifier environment')['variables'],
    'Initial verifier environment variables',
  );
  if (
    variables['IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256'] !== artifact.asset_manifest_sha256 ||
    variables['IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256'] !== artifact.trust_root_sha256
  )
    throw new Error('Initial verifier state signing inputs are detached from its selected package/image.');
  const imagePrefix = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${context.names.proverRepository}@`;
  const retainedImage = parseDigestPinnedImageReference(
    `${imagePrefix}${String(variables['IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST'])}`,
    {
      partition: target.partition,
      accountId: target.accountId,
      region: target.region,
      repository: context.names.proverRepository,
    },
  );
  return deepFreeze({ ...observedOutput, proverImageUri: retainedImage.imageUri });
}
