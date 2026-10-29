import { createHash } from 'node:crypto';
import { snapshotDataTree } from './descriptor-snapshot.js';
import {
  canonicalRecordJson,
  deepFreeze,
  parseGitCommitSha,
  parseS3VersionId,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
} from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  validateTerraformBackendAuthority,
  validateTerraformBaselineNonsecretInputs,
  decodeTerraformBaselineNonsecretInputValues,
  validateTerraformBaselineProviderLock,
} from './terraform-authority.js';

/** @typedef {'bootstrap'|'foundation'|'app'} TerraformRoot */
/** @typedef {{readonly key:string,readonly versionId:string,readonly sha256:string}} ObjectReference */
/** @typedef {ObjectReference & {readonly etag:string}} ObjectObservation */
/** @typedef {{readonly kind:'local',readonly executionId:string}|{readonly kind:'pipeline',readonly executionId:string,readonly pipelineName:string,readonly planActionExecutionId:string,readonly buildId:string}} PlanExecution */
/** @typedef {{readonly runtime:{readonly terraformVersion:string,readonly terraformArchiveSha256:string,readonly platform:'linux_amd64'},readonly providerLock:string,readonly nonsecretInputs:import('./terraform-authority.js').TerraformNonsecretInputs,readonly artifacts:readonly {readonly path:string,readonly bucket:string,readonly reference:ObjectReference}[]}} TerraformRecipe */
export const PLAN_TERRAFORM_RUNTIME = Object.freeze({
  terraformVersion: '1.17.0',
  terraformArchiveSha256: 'c168cab7c637a8769fdb90089ddd19de701bc6ff8aca64dc2e2185fe46f59f67',
  platform: 'linux_amd64',
});
export const PLAN_AWS_PROVIDER_VERSION = '6.70.0';
const PLAN_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const FRONTEND_ARTIFACT_NAMES = Object.freeze(['dist.tar.gz', 'manifest.json', 'config.json']);
/** @param {string} targetKey @param {unknown} sourceSha @param {unknown} deploymentId */
export function deriveFrontendArtifactCoordinates(targetKey, sourceSha, deploymentId) {
  const names = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget(targetKey), 'app').names;
  const source = parseGitCommitSha(sourceSha, 'Frontend source');
  const deployment = requireString(deploymentId, 'Frontend deployment', /^dep_[0-9a-f]{32}$/u);
  return FRONTEND_ARTIFACT_NAMES.map((name) =>
    Object.freeze({
      path: `.artifacts/static-frontend-${name}`,
      bucket: names.appRetainedArtifactBucket,
      key: `${names.staticFrontendArtifactPrefix}/${source}/${deployment}/${name}`,
    }),
  );
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
export function packageRecord(value, keys, label) {
  return requireExactKeys(snapshotDataTree(value, label), keys, label);
}
/** @param {unknown} value @param {string} label @param {number} maximum */
function textFile(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximum ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    })
  )
    throw new Error(`${label} must be bounded UTF-8 text.`);
  return value;
}
/** @param {unknown} value @returns {TerraformRoot} */
export function admitTerraformRoot(value) {
  if (value !== 'bootstrap' && value !== 'foundation' && value !== 'app')
    throw new Error('Unsupported Terraform root.');
  return value;
}
/** @param {unknown} value @param {string} label */
export function admitRelativePath(value, label) {
  const result = requireString(value, label, /^[A-Za-z0-9._/-]{1,1024}$/u);
  if (result.startsWith('/') || result.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new Error(`${label} must be a normalized relative path.`);
  return result;
}
/** @param {unknown} value @returns {ObjectReference} */
export function admitObjectReference(value) {
  const input = packageRecord(value, ['key', 'versionId', 'sha256'], 'Immutable object reference');
  return deepFreeze({
    key: admitRelativePath(input['key'], 'Object key'),
    versionId: parseS3VersionId(input['versionId']),
    sha256: parseSha256(input['sha256']),
  });
}
/** @param {unknown} value @returns {ObjectObservation} */
export function admitObjectObservation(value) {
  const input = packageRecord(value, ['key', 'versionId', 'sha256', 'etag'], 'Object observation');
  return deepFreeze({
    ...admitObjectReference({ key: input['key'], versionId: input['versionId'], sha256: input['sha256'] }),
    etag: requireString(input['etag'], 'Object ETag', /^"[^"\s]{1,128}"$/u),
  });
}
/** @param {string | Uint8Array} body */
export function storedBytesSha256(body) {
  return createHash('sha256').update(body).digest('hex');
}
/** @param {string} targetKey @param {TerraformRoot} root */
export function deploymentRootPrefix(targetKey, root) {
  resolveAllowedDeploymentTarget(targetKey);
  admitTerraformRoot(root);
  return `deployment/${targetKey}/${root}`;
}
/** @param {string} targetKey @param {TerraformRoot} root @param {string} executionId */
export function derivePlanPackageKey(targetKey, root, executionId) {
  return `${deploymentRootPrefix(targetKey, root)}/plan-packages/${requireGroupedLowercaseUuid(executionId, 'Plan execution ID')}.json`;
}
/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} root @returns {PlanExecution} */
export function admitPlanExecution(value, targetKey, root) {
  const data = snapshotDataTree(value, 'Plan execution');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('Missing plan execution.');
  const input = requireExactKeys(
    data,
    'kind' in data && data['kind'] === 'local'
      ? ['kind', 'executionId']
      : ['kind', 'executionId', 'pipelineName', 'planActionExecutionId', 'buildId'],
    'Plan execution',
  );
  const executionId = requireGroupedLowercaseUuid(input['executionId'], 'Plan execution ID');
  if (input['kind'] === 'local' && root === 'bootstrap') return deepFreeze({ kind: 'local', executionId });
  if (input['kind'] !== 'pipeline' || root === 'bootstrap') throw new Error('Execution kind does not match the root.');
  const authority = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget(targetKey), root);
  const pipelineName = requireString(input['pipelineName'], 'Plan pipeline name');
  const buildId = requireString(input['buildId'], 'Plan build ID');
  if (
    pipelineName !== authority.names['pipeline'] ||
    !buildId.startsWith(`${authority.names['terraformPlanProject']}:`)
  )
    throw new Error('Plan producer does not match the selected target/root.');
  requireGroupedLowercaseUuid(buildId.slice(buildId.indexOf(':') + 1), 'Plan build UUID');
  return deepFreeze({
    kind: 'pipeline',
    executionId,
    pipelineName,
    buildId,
    planActionExecutionId: requireGroupedLowercaseUuid(input['planActionExecutionId'], 'Plan action execution ID'),
  });
}
/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} root @returns {TerraformRecipe} */
export function admitTerraformRecipe(value, targetKey, root) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const input = packageRecord(value, ['runtime', 'providerLock', 'nonsecretInputs', 'artifacts'], 'Terraform recipe');
  const runtime = admitRecipeRuntime(input['runtime']);
  const providerLock = textFile(input['providerLock'], 'Terraform provider lock', 256 * 1024);
  validateTerraformBaselineProviderLock(providerLock, {
    terraform_version: runtime.terraformVersion,
    platform: 'linux_amd64',
    terraform_outdated: false,
    provider_selections: { 'registry.terraform.io/hashicorp/aws': PLAN_AWS_PROVIDER_VERSION },
  });
  const nonsecretInputs = validateTerraformBaselineNonsecretInputs(input['nonsecretInputs']);
  if (nonsecretInputs.root !== root) throw new Error('Terraform recipe inputs belong to a different root.');
  const variables = decodeTerraformBaselineNonsecretInputValues(nonsecretInputs);
  assertRecipeVariableIdentity(variables, target, root);

  const artifacts = admitRecipeArtifacts(input['artifacts'], target, root);

  if (root !== 'app' && artifacts.length !== 0)
    throw new Error('Only App recipes admit retained deployment artifacts.');
  if (root === 'app') assertAppRecipeArtifacts(artifacts, variables, targetKey);
  return deepFreeze({
    runtime,
    providerLock,
    nonsecretInputs,
    artifacts,
  });
}
/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} selectedRoot */
export function admitPlanPackage(value, targetKey, selectedRoot) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const root = admitTerraformRoot(selectedRoot);
  const input = packageRecord(
    value,
    [
      'targetKey',
      'root',
      'accountId',
      'region',
      'backend',
      'sourceSha',
      'execution',
      'recipe',
      'files',
      'references',
      'publication',
    ],
    'Plan package',
  );
  if (
    input['targetKey'] !== targetKey ||
    input['root'] !== root ||
    input['accountId'] !== target.accountId ||
    input['region'] !== target.region
  )
    throw new Error('Plan package target identity mismatch.');
  const backend = validateTerraformBackendAuthority(input['backend'], root, targetKey);
  if (backend.bucketName !== resolveDeploymentLaneAuthority(target, root).names['terraformStateBucket'])
    throw new Error('Plan package state bucket mismatch.');
  const sourceSha = parseGitCommitSha(input['sourceSha']);
  const execution = admitPlanExecution(input['execution'], targetKey, root);
  const recipe = admitTerraformRecipe(input['recipe'], targetKey, root);
  if (
    root === 'app' &&
    decodeTerraformBaselineNonsecretInputValues(recipe.nonsecretInputs)['app_source_sha'] !== sourceSha
  )
    throw new Error('App artifact source differs from the reviewed plan source.');
  const files = admitPlanFiles(input['files'], backend, recipe, target, root);
  const references = admitPlanDependencies(input['references'], targetKey, root);
  const publication = admitPlanPublication(input['publication'], targetKey, root);
  return deepFreeze({
    targetKey: target.targetKey,
    root,
    accountId: target.accountId,
    region: target.region,
    backend,
    sourceSha,
    execution,
    recipe,
    files,
    references,
    publication,
  });
}
/**
 * @param {unknown} value
 * @param {ReturnType<typeof validateTerraformBackendAuthority>} backend
 * @param {ReturnType<typeof admitTerraformRecipe>} recipe
 * @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target
 * @param {TerraformRoot} root
 */
function admitPlanFiles(value, backend, recipe, target, root) {
  const files = requireExactKeys(value, ['backend', 'tfplan', 'tfplanJson'], 'Plan package files');
  const backendFile = admitPlanBackendFile(
    files['backend'],
    backend,
    resolveDeploymentLaneAuthority(target, root).names.terraformStateKmsAlias,
  );
  const tfplan = requireString(files['tfplan'], 'Saved binary plan', /^[A-Za-z0-9+/]+={0,2}$/u);
  if (Buffer.from(tfplan, 'base64').toString('base64') !== tfplan)
    throw new Error('Saved plan must use canonical base64.');
  const tfplanJson = admitSavedPlanJson(files['tfplanJson'], recipe.runtime.terraformVersion);
  return { backend: backendFile, tfplan, tfplanJson };
}

/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} root */
function admitPlanDependencies(value, targetKey, root) {
  const refs = requireExactKeys(value, ['foundation', 'toolchain', 'prover'], 'Plan dependency references');
  const references = {
    foundation: refs['foundation'] === null ? null : admitObjectReference(refs['foundation']),
    toolchain: refs['toolchain'] === null ? null : admitObjectReference(refs['toolchain']),
    prover: refs['prover'] === null ? null : admitObjectReference(refs['prover']),
  };
  if (root === 'app' && Object.values(references).some((ref) => ref === null))
    throw new Error('App plan requires exact Foundation and image references.');
  if (root === 'app') assertAppDependencyKeys(references, targetKey);
  if (root !== 'app' && Object.values(references).some((ref) => ref !== null))
    throw new Error('Non-App plan has unexpected dependency references.');
  return references;
}

/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} root */
function admitPlanPublication(value, targetKey, root) {
  const expected = requireExactKeys(
    value,
    ['checkpoint', 'mutationOwner', 'initialPublication'],
    'Plan publication preconditions',
  );
  const checkpoint = expected['checkpoint'] === null ? null : admitObjectObservation(expected['checkpoint']);
  const mutationOwner = expected['mutationOwner'] === null ? null : admitObjectObservation(expected['mutationOwner']);
  if (
    typeof expected['initialPublication'] !== 'boolean' ||
    (!expected['initialPublication'] && (checkpoint === null || mutationOwner === null))
  )
    throw new Error('Missing publication authority requires an explicit initial/cutover plan.');
  assertPlanPublicationKeys(checkpoint, mutationOwner, targetKey, root);
  return { checkpoint, mutationOwner, initialPublication: expected['initialPublication'] };
}

/** @param {unknown} value @param {ReturnType<typeof validateTerraformBackendAuthority>} backend @param {string} kmsAlias */
function admitPlanBackendFile(value, backend, kmsAlias) {
  const backendFile = textFile(value, 'Backend file', 16384);
  const values = parseBackendAssignments(backendFile);
  const kmsValue = values['kms_key_id'];
  if (
    Object.keys(values).length !== 6 ||
    values['bucket'] !== backend.bucketName ||
    values['key'] !== backend.backendKey ||
    values['region'] !== backend.region ||
    values['encrypt'] !== 'true' ||
    values['use_lockfile'] !== 'true' ||
    (kmsValue !== backend.kmsKeyArn && kmsValue !== kmsAlias)
  )
    throw new Error('Backend file is detached from selected state authority.');
  return backendFile;
}

/** @param {string} backendFile */
function parseBackendAssignments(backendFile) {
  const backendLines = backendFile
    .trim()
    .split('\n')
    .map((line) => /^\s*([a-z_]+)\s*=\s*(?:"([^"\r\n]+)"|(true|false))\s*$/u.exec(line));
  if (backendLines.some((line) => line === null) || backendLines.length !== 6)
    throw new Error('Backend file must contain exactly the six admitted fields.');
  const values = Object.fromEntries(backendLines.map((line) => [line?.[1], line?.[2] ?? line?.[3]]));
  return values;
}

/** @param {{foundation: ObjectReference | null, toolchain: ObjectReference | null, prover: ObjectReference | null}} references @param {string} targetKey */
function assertAppDependencyKeys(references, targetKey) {
  if (
    references.foundation?.key !== `${deploymentRootPrefix(targetKey, 'foundation')}/checkpoint.json` ||
    references.toolchain?.key !== 'promotions/toolchain/current.json' ||
    references.prover?.key !== 'promotions/prover/current.json'
  )
    throw new Error('App plan dependency references use foreign semantic keys.');
}

/** @typedef {ReturnType<typeof admitPlanPackage>} PlanPackage */
/** @param {string} body @param {ObjectReference} reference @param {string} targetKey @param {TerraformRoot} root */
export function parsePlanPackage(body, reference, targetKey, root) {
  const ref = admitObjectReference(reference);
  if (Buffer.byteLength(body) > PLAN_PACKAGE_MAX_BYTES || storedBytesSha256(body) !== ref.sha256)
    throw new Error('Plan package bytes do not match the selected immutable object.');
  const result = admitPlanPackage(JSON.parse(body), targetKey, root);
  if (
    body !== canonicalRecordJson(result) ||
    ref.key !== derivePlanPackageKey(targetKey, root, result.execution.executionId)
  )
    throw new Error('Plan package bytes/key are not canonical for this execution.');
  return result;
}
/** @param {PlanPackage} plan @param {ObjectReference} reference */
export function assertPlanPackageReference(plan, reference) {
  const ref = admitObjectReference(reference);
  if (
    ref.key !== derivePlanPackageKey(plan.targetKey, plan.root, plan.execution.executionId) ||
    ref.sha256 !== storedBytesSha256(canonicalRecordJson(plan))
  )
    throw new Error('Immutable package reference differs from the admitted plan.');
  return ref;
}
/** @param {PlanPackage} plan @param {ObjectReference} reference @param {string} approvalActionExecutionId */
export function renderPlanPackageApprovalSummary(plan, reference, approvalActionExecutionId) {
  const ref = assertPlanPackageReference(plan, reference);
  const summary = `plan-package ${plan.targetKey} ${plan.root} ${plan.execution.executionId} ${requireGroupedLowercaseUuid(approvalActionExecutionId, 'Approval action execution ID')} ${ref.sha256}`;
  if (summary.length > 512) throw new Error('Approval summary exceeds AWS limit.');
  return summary;
}
/** @param {unknown} value */
export function parseSavedPlanChecksum(value) {
  return parseSha256(value, 'Saved plan checksum');
}
/** @param {unknown} value */
export function parseSavedPlanChecksumSidecar(value) {
  const body = textFile(value, 'Saved plan checksum sidecar', 4096);
  const match = /^([0-9a-f]{64}) {2}[^\r\n]+\n?$/u.exec(body);
  if (!match?.[1]) throw new Error('Saved plan checksum sidecar invalid.');
  return parseSha256(match[1]);
}

/** @param {unknown} value */
function admitRecipeRuntime(value) {
  const runtime = requireExactKeys(
    value,
    ['terraformVersion', 'terraformArchiveSha256', 'platform'],
    'Terraform runtime',
  );
  if (runtime['platform'] !== 'linux_amd64') throw new Error('Terraform runtime must be fixed Linux amd64.');
  const terraformVersion = requireString(runtime['terraformVersion'], 'Terraform version', /^\d+\.\d+\.\d+$/u);
  const terraformArchiveSha256 = parseSha256(runtime['terraformArchiveSha256'], 'Terraform archive SHA256');
  if (
    terraformVersion !== PLAN_TERRAFORM_RUNTIME.terraformVersion ||
    terraformArchiveSha256 !== PLAN_TERRAFORM_RUNTIME.terraformArchiveSha256
  )
    throw new Error('Terraform runtime does not match the reviewed source pin.');
  return { terraformVersion, terraformArchiveSha256, platform: /** @type {const} */ ('linux_amd64') };
}
/** @param {Record<string, unknown>} variables @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target @param {TerraformRoot} root */
function assertRecipeVariableIdentity(variables, target, root) {
  const authority = resolveDeploymentLaneAuthority(target, root);
  const identity = {
    account_alias: target.accountLabel,
    aws_account_id: target.accountId,
    aws_region: target.region,
    deployment_environment: target.environmentId,
    project_name: target.projectId,
    state_backend_key: authority.backendKey,
    state_scope: authority.scope,
  };
  for (const [key, expected] of Object.entries(identity))
    if (variables[key] !== expected)
      throw new Error('Terraform recipe variable identity differs from the target/root.');
}
/** @param {unknown} value @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target @param {TerraformRoot} root */
function admitRecipeArtifacts(value, target, root) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Terraform recipe artifact inventory is invalid.');
  const paths = new Set();
  const artifacts = value.map((entry) => {
    const artifact = requireExactKeys(entry, ['path', 'bucket', 'reference'], 'Recipe artifact');
    const path = admitRelativePath(artifact['path'], 'Artifact path');
    if (
      paths.has(path) ||
      path === '.terraform.lock.hcl' ||
      path === 'pipeline.auto.tfvars.json' ||
      path === 'backend.pipeline.hcl' ||
      path.startsWith('.terraform/')
    )
      throw new Error('Artifact overwrites recipe authority.');
    paths.add(path);
    const bucket = requireString(artifact['bucket'], 'Artifact bucket', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u);
    if (
      !Object.entries(resolveDeploymentLaneAuthority(target, root).names).some(
        ([name, value]) => name.toLowerCase().endsWith('bucket') && value === bucket,
      )
    )
      throw new Error('Artifact bucket belongs to a different target.');
    return { path, bucket, reference: admitObjectReference(artifact['reference']) };
  });

  return artifacts;
}
/** @param {TerraformRecipe['artifacts']} artifacts @param {Record<string, unknown>} variables @param {string} targetKey */
function assertAppRecipeArtifacts(artifacts, variables, targetKey) {
  const lambdas =
    /** @type {Record<string,{s3_bucket:string,s3_key:string,s3_object_version:string,source_code_hash:string}>} */ (
      variables['lambda_artifacts']
    );
  if (artifacts.length !== Object.keys(lambdas).length + FRONTEND_ARTIFACT_NAMES.length)
    throw new Error('App recipe artifact inventory omits required Lambda or frontend artifacts.');
  assertRecipeLambdaArtifacts(artifacts, lambdas);
  for (const coordinate of deriveFrontendArtifactCoordinates(
    targetKey,
    variables['app_source_sha'],
    variables['deployment_id'],
  )) {
    const artifact = artifacts.find((entry) => entry.path === coordinate.path);
    if (!artifact || artifact.bucket !== coordinate.bucket || artifact.reference.key !== coordinate.key)
      throw new Error('Frontend artifact does not match the reviewed source/deployment.');
  }
}
/** @param {TerraformRecipe['artifacts']} artifacts @param {Record<string,{s3_bucket:string,s3_key:string,s3_object_version:string,source_code_hash:string}>} lambdas */
function assertRecipeLambdaArtifacts(artifacts, lambdas) {
  for (const [name, lambda] of Object.entries(lambdas)) {
    const artifact = artifacts.find((entry) => entry.path === `.artifacts/${name}.zip`);
    if (
      !artifact ||
      artifact.bucket !== lambda.s3_bucket ||
      artifact.reference.key !== lambda.s3_key ||
      artifact.reference.versionId !== lambda.s3_object_version ||
      artifact.reference.sha256 !== Buffer.from(lambda.source_code_hash, 'base64').toString('hex')
    )
      throw new Error('App recipe artifact does not match the immutable Terraform Lambda input.');
  }
}

/** @param {unknown} value @param {string} terraformVersion */
function admitSavedPlanJson(value, terraformVersion) {
  const tfplanJson = textFile(value, 'Saved plan JSON', 48 * 1024 * 1024);
  const plan = JSON.parse(tfplanJson);
  if (
    plan.terraform_version !== terraformVersion ||
    plan.complete !== true ||
    plan.errored !== false ||
    hasDeferredPlanActions(plan)
  )
    throw new Error('Saved plan is incomplete or uses an unsupported runtime/action.');
  return tfplanJson;
}
/** @param {Record<string, {length?:unknown} | undefined>} plan */
function hasDeferredPlanActions(plan) {
  return (plan['deferred_changes']?.length ?? 0) !== 0 || (plan['action_invocations']?.length ?? 0) !== 0;
}

/** @param {ObjectObservation|null} checkpoint @param {ObjectObservation|null} mutationOwner @param {string} targetKey @param {TerraformRoot} root */
function assertPlanPublicationKeys(checkpoint, mutationOwner, targetKey, root) {
  if (checkpoint !== null && checkpoint.key !== `${deploymentRootPrefix(targetKey, root)}/checkpoint.json`)
    throw new Error('Wrong checkpoint key.');
  if (mutationOwner !== null && mutationOwner.key !== `${deploymentRootPrefix(targetKey, root)}/mutation-owner.json`)
    throw new Error('Wrong mutation owner key.');
}
