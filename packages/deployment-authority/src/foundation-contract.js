import { createHash } from 'node:crypto';
import { snapshotDataTree } from './descriptor-snapshot.js';
import { canonicalJsonSha256, deepFreeze, parseSha256, requireExactKeys, requireString } from './internal.js';

const MAX_REPOSITORY_FILES = 20_000;
const MAX_DEPENDENCY_OBSERVATIONS = 20_000;
const MAX_PATH_BYTES = 1_024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SELECTED_BYTES = 64 * 1024 * 1024;

const OBSERVATION_KEYS = ['dependencies', 'files', 'nonsecretInputs', 'observationType', 'repositorySnapshotComplete'];
const FILE_KEYS = ['bytes', 'path', 'readable', 'tracked', 'type'];
const DEPENDENCY_KEYS = ['fromPath', 'resolution', 'specifier', 'toPath'];
const NONSECRET_INPUT_KEYS = [
  'accountAlias',
  'awsAccountId',
  'awsRegion',
  'deploymentEnvironment',
  'deploymentTargetKey',
  'projectName',
  'publicHostnameDisposition',
  'stateBackendKey',
  'stateScope',
];
const SOURCE_CONTRACT_KEYS = ['closureIdentity', 'foundationContractHash'];

/**
 * One reviewed inventory owns every repository path admitted to the Foundation
 * resource/output contract. Exact paths are mandatory. Rules deliberately
 * cover auto-loaded Terraform and bounded source families without turning the
 * contract into a repository-wide source hash.
 */
export const FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY = deepFreeze({
  exactPaths: [
    '.nvmrc',
    'infra/framework/buildspecs/terraform-drift-runner.yml',
    'infra/framework/terraform/modules/codebuild-log-groups/main.tf',
    'infra/framework/terraform/modules/codebuild-log-groups/outputs.tf',
    'infra/framework/terraform/modules/codebuild-log-groups/variables.tf',
    'infra/framework/terraform/modules/codebuild-log-groups/versions.tf',
    'infra/lambdas/ecr-retention/index.ts',
    'infra/terraform/bootstrap/app-acceptance-scripts/app-acceptance-ledger-aws.mjs',
    'infra/terraform/bootstrap/app-acceptance-scripts/prepare-app-terraform-drift.mjs',
    'infra/terraform/bootstrap/app-acceptance-scripts/project-app-ecr-retention-authority.mjs',
    'infra/terraform/bootstrap/app-acceptance-scripts/resolve-app-acceptance-history.mjs',
    'infra/terraform/bootstrap/app-pipeline-scripts/read-stable-local-file.mjs',
    'infra/terraform/bootstrap/app-status-scripts/app-status-aws.mjs',
    'infra/terraform/bootstrap/app-status-scripts/publish-current-app-status-runner.mjs',
    'infra/terraform/bootstrap/app-status-scripts/publish-current-app-status.mjs',
    'infra/terraform/bootstrap/app-status-scripts/publish-current-app-status.sh',
    'infra/terraform/bootstrap/buildspec-app-publish-current-status.yml',
    'infra/terraform/bootstrap/buildspec-foundation-apply.yml',
    'infra/terraform/bootstrap/buildspec-foundation-plan.yml',
    'infra/terraform/bootstrap/buildspec-foundation-signing-authority-resolver.yml',
    'infra/terraform/bootstrap/buildspec-foundation-smoke.yml',
    'infra/terraform/bootstrap/deployment_authority.tf',
    'infra/terraform/bootstrap/deployment_source_authority.tf',
    'infra/terraform/bootstrap/foundation_app_drift_inventory.tf',
    'infra/terraform/bootstrap/foundation_app_status_authority.tf',
    'infra/terraform/bootstrap/foundation_bootstrap_authority_inventory.tf',
    'infra/terraform/bootstrap/foundation_contract_outputs.tf',
    'infra/terraform/bootstrap/foundation_pipeline_apply_boundary.tf',
    'infra/terraform/bootstrap/foundation_pipeline_apply_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_artifacts.tf',
    'infra/terraform/bootstrap/foundation_pipeline_bootstrap_apply_foundation_lane_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_codebuild_log_groups.tf',
    'infra/terraform/bootstrap/foundation_pipeline_codebuild.tf',
    'infra/terraform/bootstrap/foundation_pipeline_codepipeline.tf',
    'infra/terraform/bootstrap/foundation_pipeline_deploy_boundary.tf',
    'infra/terraform/bootstrap/foundation_pipeline_ecr_retention_boundary.tf',
    'infra/terraform/bootstrap/foundation_pipeline_identity_guard.tf',
    'infra/terraform/bootstrap/foundation_pipeline_identity_locals.tf',
    'infra/terraform/bootstrap/foundation_pipeline_pipeline_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_plan_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_prover_release_codebuild.tf',
    'infra/terraform/bootstrap/foundation_pipeline_prover_release_codepipeline.tf',
    'infra/terraform/bootstrap/foundation_pipeline_prover_release_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_roles.tf',
    'infra/terraform/bootstrap/foundation_pipeline_signing_authority_resolver_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_signing_authority_resolver.tf',
    'infra/terraform/bootstrap/foundation_pipeline_smoke_boundary.tf',
    'infra/terraform/bootstrap/foundation_pipeline_smoke_policy.tf',
    'infra/terraform/bootstrap/foundation_pipeline_toolchain_release_codebuild.tf',
    'infra/terraform/bootstrap/foundation_pipeline_toolchain_release_codepipeline.tf',
    'infra/terraform/bootstrap/foundation_pipeline_toolchain_release_policy.tf',
    'infra/terraform/bootstrap/foundation_saved_plan_approval_authority.tf',
    'infra/terraform/bootstrap/foundation_terraform_acceptance_publisher.tf',
    'infra/terraform/bootstrap/foundation_terraform_authority_inventory.tf',
    'infra/terraform/bootstrap/foundation_terraform_drift_runner_inventory.tf',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/ecr-retention-trust-policy.mjs',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/foundation-apply.sh',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/foundation-plan.sh',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/foundation-smoke-evidence.mjs',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/foundation-smoke.sh',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/foundation-state-ownership.sh',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/resolve-foundation-signing-authority.sh',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/toolchain-release-ledger-adapter.mjs',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/verify-ecr-retention-saved-plan-artifact.mjs',
    'infra/terraform/bootstrap/foundation-pipeline-scripts/verify-foundation-post-apply.mjs',
    'infra/terraform/bootstrap/report-only-terraform-scripts/run-report-only-terraform-plan.sh',
    'infra/terraform/bootstrap/saved-plan-correspondence-scripts/saved-plan-apply-agreement.mjs',
    'infra/terraform/bootstrap/saved-plan-correspondence-scripts/saved-plan-correspondence-entrypoint.mjs',
    'infra/terraform/bootstrap/saved-plan-correspondence-scripts/saved-plan-correspondence-layout.mjs',
    'infra/terraform/bootstrap/saved-plan-correspondence-scripts/verify-saved-plan-correspondence.mjs',
    'infra/terraform/bootstrap/saved-plan-correspondence-scripts/write-saved-plan-correspondence.mjs',
    'infra/terraform/bootstrap/source_path_build_authority.tf',
    'infra/terraform/bootstrap/source-path-build-scripts/install-terraform.sh',
    'infra/terraform/bootstrap/state_backend.tf',
    'infra/terraform/bootstrap/storage_retention.tf',
    'infra/terraform/bootstrap/terraform_authority_storage.tf',
    'infra/terraform/bootstrap/terraform_drift_runner_authority.tf',
    'infra/terraform/bootstrap/terraform-acceptance-scripts/bootstrap-terraform-acceptance-inputs.mjs',
    'infra/terraform/bootstrap/terraform-acceptance-scripts/prepare-bootstrap-terraform-drift.mjs',
    'infra/terraform/bootstrap/terraform-drift-scripts/assert-terraform-drift-runner-runtime.mjs',
    'infra/terraform/bootstrap/terraform-drift-scripts/prepare-current-terraform-drift.mjs',
    'infra/terraform/bootstrap/terraform-drift-scripts/publish-terraform-drift-report.mjs',
    'infra/terraform/bootstrap/terraform-drift-scripts/run-terraform-drift.sh',
    'infra/terraform/bootstrap/variables.tf',
    'infra/terraform/foundation/ecr-retention-package.json',
    'packages/deployment-authority/deployment-targets.json',
    'packages/deployment-authority/src/app-acceptance-ledger.js',
    'packages/deployment-authority/src/app-acceptance-projections.js',
    'packages/deployment-authority/src/app-acceptance-publication.js',
    'packages/deployment-authority/src/app-deployment-status-publication.js',
    'packages/deployment-authority/src/app-deployment-status.js',
    'packages/deployment-authority/src/app-image-signature-verifier-reconciliation.js',
    'packages/deployment-authority/src/app-status-pipeline-authority.js',
    'packages/deployment-authority/src/app-verifier-initialization.js',
    'packages/deployment-authority/src/authority-bucket-policy.js',
    'packages/deployment-authority/src/conditional-object-ledger.js',
    'packages/deployment-authority/src/descriptor-snapshot.js',
    'packages/deployment-authority/src/dynamodb-recovery-phase.js',
    'packages/deployment-authority/src/ecr-retention.js',
    'packages/deployment-authority/src/exact-bytes.js',
    'packages/deployment-authority/src/foundation-bootstrap-impact.js',
    'packages/deployment-authority/src/foundation-contract.js',
    'packages/deployment-authority/src/index.js',
    'packages/deployment-authority/src/internal.js',
    'packages/deployment-authority/src/plan-approval.js',
    'packages/deployment-authority/src/release-ledger.js',
    'packages/deployment-authority/src/saved-plan-approval-evidence.js',
    'packages/deployment-authority/src/saved-plan-correspondence-byte-policy.js',
    'packages/deployment-authority/src/saved-plan-correspondence.js',
    'packages/deployment-authority/src/saved-plan-disposition.js',
    'packages/deployment-authority/src/saved-plan-review.js',
    'packages/deployment-authority/src/saved-plan-semantic-review.js',
    'packages/deployment-authority/src/source-path-build-authority.js',
    'packages/deployment-authority/src/terraform-acceptance-publication.js',
    'packages/deployment-authority/src/terraform-acceptance-selection.js',
    'packages/deployment-authority/src/terraform-acceptance.js',
    'packages/deployment-authority/src/terraform-authority.js',
    'packages/deployment-authority/src/terraform-drift.js',
    'packages/diagnostics/src/logger.ts',
    'packages/diagnostics/src/loggerTypes.ts',
    'packages/diagnostics/src/requestLogContext.ts',
    'packages/diagnostics/src/safeLogPayload.ts',
    'scripts/aws/assert-deployment-source-pins.js',
    'scripts/aws/assert-source-path-build-runtime.js',
    'scripts/aws/audit-authority-bucket-policies.mjs',
    'scripts/aws/load-deployment-context.sh',
    'scripts/aws/render-deployment-context.js',
    'scripts/build/build-ecr-retention-lambda.mjs',
    'scripts/terraform/terraform-guarded.sh',
    'tooling/tsconfig/paths.json',
  ],
  inventoryType: 'foundation-contract-dependency-inventory',
  rules: [
    {
      excludedSuffixes: [],
      prefix: 'infra/terraform/foundation/',
      recursive: false,
      suffixes: ['.tf', '.tf.json'],
    },
    {
      excludedSuffixes: ['.spec.ts', '.test.ts'],
      prefix: 'infra/lambdas/ecr-retention/',
      recursive: true,
      suffixes: ['.ts'],
    },
    {
      excludedSuffixes: ['.spec.js', '.spec.mjs', '.spec.ts', '.test.js', '.test.mjs', '.test.ts'],
      prefix: 'infra/terraform/bootstrap/foundation-acceptance-scripts/',
      recursive: true,
      suffixes: ['.js', '.mjs', '.sh'],
    },
  ],
});

export const FOUNDATION_CONTRACT_CLOSURE_IDENTITY = canonicalJsonSha256(FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY);

/** @param {unknown} value @param {string} label @returns {readonly unknown[]} */
function requireDenseArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    throw new Error(`${label} must contain only dense indexed data properties`);
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) {
    throw new Error(`${label} must contain only dense indexed data properties`);
  }
  /** @type {unknown[]} */
  const entries = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must contain only dense indexed data properties`);
    }
    entries.push(descriptor.value);
  }
  if (
    ownKeys.some(
      (key) =>
        typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
    )
  ) {
    throw new Error(`${label} must contain only dense indexed data properties`);
  }
  return entries;
}

/** @param {unknown} value @param {string} label @returns {string} */
function requireRepositoryPath(value, label) {
  const path = requireString(value, label);
  if (
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//u.test(path) ||
    path.includes('\\') ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a normalized POSIX repository-relative path`);
  }
  return path;
}

/** @param {string} path @returns {boolean} */
export function isFoundationContractDependencyPath(path) {
  let admittedPath;
  try {
    admittedPath = requireRepositoryPath(path, 'Foundation contract dependency path');
  } catch {
    return false;
  }
  if (FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.exactPaths.includes(admittedPath)) {
    return true;
  }
  return FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.rules.some((rule) => {
    if (!admittedPath.startsWith(rule.prefix)) {
      return false;
    }
    const relative = admittedPath.slice(rule.prefix.length);
    if (relative.length === 0 || (!rule.recursive && relative.includes('/'))) {
      return false;
    }
    return (
      rule.suffixes.some((suffix) => admittedPath.endsWith(suffix)) &&
      !rule.excludedSuffixes.some((suffix) => admittedPath.endsWith(suffix))
    );
  });
}

/** @param {unknown} value @returns {Readonly<Record<string, string>>} */
function admitNonsecretInputs(value) {
  const inputs = requireExactKeys(value, NONSECRET_INPUT_KEYS, 'Foundation contract nonsecret inputs');
  const admitted = {
    accountAlias: requireString(inputs['accountAlias'], 'Foundation account alias', /^[a-z][a-z0-9-]{1,62}$/u),
    awsAccountId: requireString(inputs['awsAccountId'], 'Foundation AWS account ID', /^[0-9]{12}$/u),
    awsRegion: requireString(inputs['awsRegion'], 'Foundation AWS region', /^[a-z]{2}-[a-z]+-[0-9]$/u),
    deploymentEnvironment: requireString(
      inputs['deploymentEnvironment'],
      'Foundation deployment environment',
      /^[a-z][a-z0-9-]{1,62}$/u,
    ),
    deploymentTargetKey: requireString(
      inputs['deploymentTargetKey'],
      'Foundation deployment target key',
      /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u,
    ),
    projectName: requireString(inputs['projectName'], 'Foundation project name'),
    publicHostnameDisposition: requireString(
      inputs['publicHostnameDisposition'],
      'Foundation public hostname disposition',
      /^(?:external-dns-acm|foundation-owned-dns-acm|generated-cloudfront-hostname)$/u,
    ),
    stateBackendKey: requireRepositoryPath(inputs['stateBackendKey'], 'Foundation state backend key'),
    stateScope: requireString(inputs['stateScope'], 'Foundation state scope', /^foundation$/u),
  };
  if (admitted.projectName.length > 128) {
    throw new Error('Foundation project name is too long');
  }
  return deepFreeze(admitted);
}

/**
 * Admit and detach the exact canonical nonsecret hash-input projection shared
 * by Foundation publication and forward consumers.
 *
 * @param {unknown} value
 * @returns {Readonly<Record<string, string>>}
 */
export function admitFoundationContractNonsecretInputs(value) {
  return admitNonsecretInputs(snapshotDataTree(value, 'Foundation contract nonsecret input snapshot'));
}

/**
 * @param {unknown} value
 * @returns {{ readonly path: string; readonly sha256: string; readonly size: number }}
 */
function admitSelectedFile(value) {
  const entry = requireExactKeys(value, FILE_KEYS, 'Foundation repository file observation');
  const path = requireRepositoryPath(entry['path'], 'Foundation repository file path');
  if (entry['tracked'] !== true) {
    throw new Error(`Foundation contract dependency ${path} is untracked`);
  }
  if (entry['readable'] !== true) {
    throw new Error(`Foundation contract dependency ${path} is unreadable`);
  }
  if (entry['type'] === 'symlink') {
    throw new Error(`Foundation contract dependency ${path} must not be a symlink`);
  }
  if (entry['type'] !== 'file') {
    throw new Error(`Foundation contract dependency ${path} must be a regular file`);
  }
  if (!(entry['bytes'] instanceof Uint8Array)) {
    throw new Error(`Foundation contract dependency ${path} bytes are unavailable`);
  }
  if (entry['bytes'].byteLength > MAX_FILE_BYTES) {
    throw new Error(`Foundation contract dependency ${path} exceeds the byte limit`);
  }
  const bytes = Buffer.from(entry['bytes']);
  return deepFreeze({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  });
}

/**
 * @param {unknown} value
 * @returns {{ readonly fromPath: string; readonly specifier: string; readonly toPath: string }}
 */
function admitDependencyObservation(value) {
  const dependency = requireExactKeys(value, DEPENDENCY_KEYS, 'Foundation dependency observation');
  const fromPath = requireRepositoryPath(dependency['fromPath'], 'Foundation dependency importer path');
  const specifier = requireString(dependency['specifier'], 'Foundation dependency specifier');
  if (specifier.length > MAX_PATH_BYTES) {
    throw new Error('Foundation dependency specifier is too long');
  }
  if (dependency['resolution'] !== 'resolved-repository-file') {
    throw new Error(`Foundation dependency ${specifier} from ${fromPath} is an unresolved dependency`);
  }
  const toPath = requireRepositoryPath(dependency['toPath'], 'Foundation resolved dependency path');
  if (!isFoundationContractDependencyPath(fromPath) || !isFoundationContractDependencyPath(toPath)) {
    throw new Error(`Foundation dependency ${fromPath} -> ${toPath} is outside the Foundation contract inventory`);
  }
  return deepFreeze({ fromPath, specifier, toPath });
}

/**
 * Compute the exact source contract from an injected, complete repository
 * observation. This function intentionally owns no filesystem, Git, process,
 * credential, or AWS transport.
 *
 * @param {unknown} value
 * @returns {{ readonly closureIdentity: string; readonly foundationContractHash: string }}
 */
export function computeFoundationSourceContract(value) {
  const snapshot = snapshotDataTree(value, 'Foundation contract repository observation snapshot');
  const observation = requireExactKeys(snapshot, OBSERVATION_KEYS, 'Foundation contract repository observation');
  if (observation['observationType'] !== 'foundation-contract-repository-observation') {
    throw new Error('Foundation contract repository observationType is invalid');
  }
  if (observation['repositorySnapshotComplete'] !== true) {
    throw new Error('Foundation contract repository snapshot must be complete');
  }

  const fileEntries = requireDenseArray(observation['files'], 'Foundation repository files');
  if (fileEntries.length > MAX_REPOSITORY_FILES) {
    throw new Error('Foundation repository observation has too many files');
  }
  /** @type {Map<string, unknown>} */
  const filesByPath = new Map();
  for (const value of fileEntries) {
    const entry = requireExactKeys(value, FILE_KEYS, 'Foundation repository file observation');
    const path = requireRepositoryPath(entry['path'], 'Foundation repository file path');
    if (filesByPath.has(path)) {
      throw new Error(`Foundation repository observation contains duplicate repository path ${path}`);
    }
    filesByPath.set(path, value);
  }

  for (const requiredPath of FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.exactPaths) {
    if (!filesByPath.has(requiredPath)) {
      throw new Error(`required Foundation contract dependency is missing: ${requiredPath}`);
    }
  }

  const selectedFiles = [...filesByPath.entries()]
    .filter(([path]) => isFoundationContractDependencyPath(path))
    .map(([, entry]) => admitSelectedFile(entry))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const totalBytes = selectedFiles.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > MAX_SELECTED_BYTES) {
    throw new Error('Foundation contract dependencies exceed the total byte limit');
  }

  const dependencyEntries = requireDenseArray(observation['dependencies'], 'Foundation dependency observations');
  if (dependencyEntries.length > MAX_DEPENDENCY_OBSERVATIONS) {
    throw new Error('Foundation repository observation has too many dependency observations');
  }
  const dependencies = dependencyEntries
    .map((entry) => admitDependencyObservation(entry))
    .sort((left, right) => {
      const leftKey = `${left.fromPath}\0${left.specifier}\0${left.toPath}`;
      const rightKey = `${right.fromPath}\0${right.specifier}\0${right.toPath}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  for (let index = 1; index < dependencies.length; index += 1) {
    const previous = dependencies[index - 1];
    const current = dependencies[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.fromPath === current.fromPath &&
      previous.specifier === current.specifier &&
      previous.toPath === current.toPath
    ) {
      throw new Error('Foundation repository observation contains a duplicate dependency');
    }
  }

  const selectedPaths = new Set(selectedFiles.map(({ path }) => path));
  for (const dependency of dependencies) {
    if (!selectedPaths.has(dependency.fromPath) || !selectedPaths.has(dependency.toPath)) {
      throw new Error(
        `Foundation dependency ${dependency.fromPath} -> ${dependency.toPath} is missing from the repository snapshot`,
      );
    }
  }

  const nonsecretInputs = admitNonsecretInputs(observation['nonsecretInputs']);
  const foundationContractHash = canonicalJsonSha256({
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    contractType: 'foundation-source-contract',
    dependencies,
    files: selectedFiles,
    nonsecretInputs,
  });
  return deepFreeze({
    closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
    foundationContractHash,
  });
}

/**
 * Strictly admit the pure source-contract observation returned by an injected
 * producer or consumer source observer.
 *
 * @param {unknown} value
 * @returns {{ readonly closureIdentity: string; readonly foundationContractHash: string }}
 */
export function admitFoundationSourceContract(value) {
  const snapshot = snapshotDataTree(value, 'Foundation source contract snapshot');
  const contract = requireExactKeys(snapshot, SOURCE_CONTRACT_KEYS, 'Foundation source contract');
  const closureIdentity = parseSha256(contract['closureIdentity'], 'Foundation closure identity');
  if (closureIdentity !== FOUNDATION_CONTRACT_CLOSURE_IDENTITY) {
    throw new Error('Foundation source contract closure identity is not current');
  }
  const foundationContractHash = parseSha256(contract['foundationContractHash'], 'Foundation contract hash');
  return deepFreeze({ closureIdentity, foundationContractHash });
}
