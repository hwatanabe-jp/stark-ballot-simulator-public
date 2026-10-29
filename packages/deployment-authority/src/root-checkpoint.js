import {
  canonicalRecordJson,
  deepFreeze,
  parseGitCommitSha,
  parseImageDigest,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';
import {
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
  resolveImageSigningIdentity,
} from './index.js';
import { admitFoundationConsumerContract, computeFoundationSourceContract } from './foundation-contract.js';
import {
  validateTerraformBackendAuthority,
  decodeTerraformBaselineNonsecretInputValues,
} from './terraform-authority.js';
import {
  admitObjectReference,
  assertPlanPackageReference,
  admitPlanExecution,
  admitTerraformRecipe,
  admitTerraformRoot,
  deploymentRootPrefix,
  packageRecord,
  storedBytesSha256,
} from './plan-package.js';

/** @typedef {import('./plan-package.js').TerraformRoot} TerraformRoot */
/** @typedef {import('./plan-package.js').ObjectReference} ObjectReference */
export const ROOT_CHECKPOINT_MAX_BYTES = 256 * 1024;
/** @param {string} targetKey @param {TerraformRoot} root */
export function deriveRootCheckpointKey(targetKey, root) {
  return `${deploymentRootPrefix(targetKey, root)}/checkpoint.json`;
}
/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const text = requireString(value, label);
  if (new Date(text).toISOString() !== text) throw new Error(`${label} must use a canonical timestamp.`);
  return text;
}
/** @param {unknown} value @param {string} targetKey */
function foundationOutputs(value, targetKey) {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const names = resolveDeploymentLaneAuthority(target, 'foundation').names;
  const input = packageRecord(
    value,
    ['consumerContract', 'networking', 'imageAuthority'],
    'Foundation checkpoint outputs',
  );
  const consumerContract = admitFoundationConsumerContract(input['consumerContract']);
  const networking = admitFoundationNetworking(input['networking'], target);
  const imageAuthority = admitFoundationImages(input['imageAuthority'], target, names);
  return deepFreeze({ consumerContract, networking, imageAuthority });
}
/** @param {unknown} value */
function appOutputs(value) {
  const input = packageRecord(
    value,
    ['deploymentId', 'proverImageDigest', 'imageId', 'methodVersion', 'planDisposition', 'runtimeIdentity'],
    'App checkpoint outputs',
  );
  const runtime = packageRecord(
    input['runtimeIdentity'],
    ['outputsSha256', 'frontendManifestSha256'],
    'App runtime identity',
  );
  if (!Number.isSafeInteger(input['methodVersion']) || /** @type {number} */ (input['methodVersion']) < 1)
    throw new Error('App method version invalid.');
  if (input['planDisposition'] !== 'changed' && input['planDisposition'] !== 'empty')
    throw new Error('App plan disposition invalid.');
  return deepFreeze({
    deploymentId: requireString(input['deploymentId'], 'Deployment ID', /^dep_[0-9a-f]{32}$/u),
    proverImageDigest: parseImageDigest(input['proverImageDigest']),
    imageId: requireString(input['imageId'], 'ImageID', /^0x[0-9a-f]{64}$/u),
    methodVersion: /** @type {number} */ (input['methodVersion']),
    planDisposition: input['planDisposition'],
    runtimeIdentity: {
      outputsSha256: parseSha256(runtime['outputsSha256']),
      frontendManifestSha256: parseSha256(runtime['frontendManifestSha256']),
    },
  });
}
/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} selectedRoot */
export function admitRootCheckpoint(value, targetKey, selectedRoot) {
  const root = admitTerraformRoot(selectedRoot);
  const input = packageRecord(
    value,
    ['targetKey', 'root', 'sourceSha', 'execution', 'backend', 'planPackage', 'acceptedAt', 'recipe', 'outputs'],
    'Root checkpoint',
  );
  if (input['targetKey'] !== targetKey || input['root'] !== root) throw new Error('Checkpoint target/root mismatch.');
  const common = {
    targetKey: resolveAllowedDeploymentTarget(targetKey).targetKey,
    sourceSha: parseGitCommitSha(input['sourceSha']),
    execution: admitPlanExecution(input['execution'], targetKey, root),
    backend: validateTerraformBackendAuthority(input['backend'], root, targetKey),
    planPackage: admitObjectReference(input['planPackage']),
    acceptedAt: timestamp(input['acceptedAt'], 'Checkpoint acceptedAt'),
    recipe: admitTerraformRecipe(input['recipe'], targetKey, root),
  };
  if (
    common.planPackage.key !==
    `${deploymentRootPrefix(targetKey, root)}/plan-packages/${common.execution.executionId}.json`
  )
    throw new Error('Checkpoint plan reference mismatch.');
  if (root === 'foundation') {
    const outputs = foundationOutputs(input['outputs'], targetKey);
    const values = decodeTerraformBaselineNonsecretInputValues(common.recipe.nonsecretInputs);
    const expected = computeFoundationSourceContract({
      nonsecretInputs: {
        accountAlias: values['account_alias'],
        awsAccountId: values['aws_account_id'],
        awsRegion: values['aws_region'],
        deploymentEnvironment: values['deployment_environment'],
        deploymentTargetKey: targetKey,
        projectName: values['project_name'],
        publicHostnameDisposition: values['public_hostname_disposition'],
        stateBackendKey: values['state_backend_key'],
        stateScope: values['state_scope'],
      },
      requirements: outputs.consumerContract.requirements,
    });
    if (canonicalRecordJson(expected) !== canonicalRecordJson(outputs.consumerContract))
      throw new Error('Foundation consumer contract is detached from the admitted recipe.');
    return deepFreeze({ ...common, root, outputs });
  }
  if (root === 'app') {
    const outputs = appOutputs(input['outputs']);
    const values = decodeTerraformBaselineNonsecretInputValues(common.recipe.nonsecretInputs);
    if (
      values['app_source_sha'] !== common.sourceSha ||
      values['deployment_id'] !== outputs.deploymentId ||
      values['expected_image_id'] !== outputs.imageId ||
      /** @type {{current_method_version:number}} */ (values['image_id_mapping_evidence']).current_method_version !==
        outputs.methodVersion ||
      typeof values['prover_image_uri'] !== 'string' ||
      !values['prover_image_uri'].endsWith(`@${outputs.proverImageDigest}`)
    )
      throw new Error('App checkpoint image identity differs from the approved inputs.');
    return deepFreeze({ ...common, root, outputs });
  }
  if (input['outputs'] !== null) throw new Error('Bootstrap checkpoint has no consumer output.');
  return deepFreeze({ ...common, root, outputs: null });
}
/** @typedef {ReturnType<typeof admitRootCheckpoint>} RootCheckpoint */
/** @param {string} body @param {ObjectReference} reference @param {string} targetKey @param {TerraformRoot} root */
export function parseRootCheckpoint(body, reference, targetKey, root) {
  const ref = admitObjectReference(reference);
  if (
    ref.key !== deriveRootCheckpointKey(targetKey, root) ||
    Buffer.byteLength(body) > ROOT_CHECKPOINT_MAX_BYTES ||
    storedBytesSha256(body) !== ref.sha256
  )
    throw new Error('Checkpoint immutable byte reference mismatch.');
  const result = admitRootCheckpoint(JSON.parse(body), targetKey, root);
  if (canonicalRecordJson(result) !== body) throw new Error('Checkpoint bytes must be canonical.');
  return result;
}
/** @param {{plan:import('./plan-package.js').PlanPackage,reference:ObjectReference,acceptedAt:string,outputs:unknown,smoke:{status:string,executionId:string,packageSha256:string}}} input */
export function buildRootCheckpoint(input) {
  const { plan, reference, smoke } = input;
  assertPlanPackageReference(plan, reference);
  if (
    smoke.status !== 'Succeeded' ||
    smoke.executionId !== plan.execution.executionId ||
    smoke.packageSha256 !== reference.sha256
  )
    throw new Error('Checkpoint requires successful owning smoke for the exact execution/package.');
  return admitRootCheckpoint(
    {
      targetKey: plan.targetKey,
      root: plan.root,
      sourceSha: plan.sourceSha,
      execution: plan.execution,
      backend: plan.backend,
      planPackage: reference,
      acceptedAt: input.acceptedAt,
      recipe: plan.recipe,
      outputs: input.outputs,
    },
    plan.targetKey,
    plan.root,
  );
}

/** @param {Pick<RootCheckpoint,'root'|'targetKey'|'acceptedAt'|'execution'|'outputs'>} checkpoint */
export function projectAppCheckpointEvent(checkpoint) {
  if (checkpoint.root !== 'app' || !checkpoint.outputs || !('deploymentId' in checkpoint.outputs))
    throw new Error('Deployment event requires a successful App checkpoint.');
  const target = resolveAllowedDeploymentTarget(checkpoint.targetKey);
  return deepFreeze({
    Source: 'stark-ballot.observability',
    DetailType: 'Accepted Deployment',
    EventBusName: 'default',
    Detail: JSON.stringify({
      ts: checkpoint.acceptedAt,
      event_type: 'deployment_accepted',
      env: target.environmentId,
      deployment_id: checkpoint.outputs.deploymentId,
      deployment_mode: 'normal',
      pipeline_execution_id: checkpoint.execution.executionId,
      plan_disposition: checkpoint.outputs.planDisposition,
      resource_name: 'app',
      state: 'ACCEPTED',
    }),
  });
}

/** @param {unknown} value @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target */
function admitFoundationNetworking(value, target) {
  const net = requireExactKeys(
    value,
    ['vpcId', 'proverSubnetIds', 'proverSecurityGroupIds', 'networkAuthority', 'publicSubnetException'],
    'Foundation networking',
  );
  const vpcId = requireString(net['vpcId'], 'Foundation VPC', /^vpc-[0-9a-f]{8,17}$/u);
  /** @param {unknown} values @param {RegExp} pattern @param {number} count */
  function identifiers(values, pattern, count) {
    if (!Array.isArray(values) || values['length'] !== count || new Set(values).size !== count)
      throw new Error('Foundation network inventory invalid.');
    return values['map']((v) => requireString(v, 'Network ID', pattern));
  }
  const proverSubnetIds = identifiers(net['proverSubnetIds'], /^subnet-[0-9a-f]{8,17}$/u, 2);
  const proverSecurityGroupIds = identifiers(net['proverSecurityGroupIds'], /^sg-[0-9a-f]{8,17}$/u, 1);
  if (
    net['networkAuthority'] !== 'foundation-owned' ||
    net['publicSubnetException'] !==
      (target.environmentId === 'develop'
        ? 'accepted-for-develop-prover-egress'
        : 'accepted-for-production-prover-egress')
  )
    throw new Error('Foundation networking posture mismatch.');
  return {
    vpcId,
    proverSubnetIds,
    proverSecurityGroupIds,
    networkAuthority: 'foundation-owned',
    publicSubnetException: /** @type {string} */ (net['publicSubnetException']),
  };
}
/** @param {unknown} value @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target @param {ReturnType<typeof resolveDeploymentLaneAuthority>['names']} names */
function admitFoundationImages(value, target, names) {
  const image = requireExactKeys(
    value,
    [
      'repositories',
      'signingProfileName',
      'signingProfileArn',
      'signingRepositoryFilters',
      'tagMutability',
      'scanOnPush',
      'proverSigningStatusRequired',
      'retentionPolicy',
    ],
    'Foundation image authority',
  );
  const repos = requireExactKeys(image['repositories'], ['prover', 'toolchain'], 'Foundation repositories');
  /** @param {'prover'|'toolchain'} kind */
  function repository(kind) {
    const repo = requireExactKeys(repos[kind], ['name', 'url'], 'Foundation repository');
    const name = names[`${kind}Repository`];
    const url = `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${name}`;
    if (repo['name'] !== name || repo['url'] !== url) throw new Error('Foundation repository target mismatch.');
    return { name: requireString(name, 'Repository name'), url };
  }
  const { signingProfileName, signingProfileArn } = admitFoundationSigningPosture(image, target);
  if (!Array.isArray(image['signingRepositoryFilters']) || image['signingRepositoryFilters'].length !== 1)
    throw new Error('Foundation signing filter missing.');
  const filter = requireExactKeys(
    image['signingRepositoryFilters'][0],
    ['filter', 'filterType'],
    'Foundation signing filter',
  );
  if (filter['filterType'] !== 'WILDCARD_MATCH' || filter['filter'] !== names['proverRepository'])
    throw new Error('Foundation signing repository mismatch.');
  return {
    repositories: { prover: repository('prover'), toolchain: repository('toolchain') },
    signingProfileName,
    signingProfileArn,
    signingRepositoryFilters: [{ filter: /** @type {string} */ (filter['filter']), filterType: 'WILDCARD_MATCH' }],
    tagMutability: 'IMMUTABLE',
    scanOnPush: true,
    proverSigningStatusRequired: 'COMPLETE',
    retentionPolicy: 'newest-five-images',
  };
}

/** @param {Record<string,unknown>} image @param {ReturnType<typeof resolveAllowedDeploymentTarget>} target */
function admitFoundationSigningPosture(image, target) {
  const signingProfileName = requireString(
    image['signingProfileName'],
    'Signing profile name',
    /^[A-Za-z0-9_]{2,64}$/u,
  );
  const signingProfileArn = requireString(image['signingProfileArn'], 'Signing profile ARN');
  if (
    signingProfileName !== resolveImageSigningIdentity(target).signingProfileName ||
    signingProfileArn !==
      `arn:${target.partition}:signer:${target.region}:${target.accountId}:/signing-profiles/${signingProfileName}` ||
    image['tagMutability'] !== 'IMMUTABLE' ||
    image['scanOnPush'] !== true ||
    image['proverSigningStatusRequired'] !== 'COMPLETE' ||
    image['retentionPolicy'] !== 'newest-five-images'
  )
    throw new Error('Foundation image posture mismatch.');
  return { signingProfileName, signingProfileArn };
}
