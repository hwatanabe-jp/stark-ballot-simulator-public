import { canonicalRecordJson, deepFreeze, requireGroupedLowercaseUuid, requireString } from './internal.js';
import {
  assertPlanPackageReference,
  admitObjectObservation,
  deploymentRootPrefix,
  packageRecord,
  storedBytesSha256,
} from './plan-package.js';
/** @typedef {import('./plan-package.js').TerraformRoot} TerraformRoot */
/** @typedef {import('./plan-package.js').ObjectObservation} ObjectObservation */
/** @param {string} targetKey @param {TerraformRoot} root */
export function deriveMutationOwnerKey(targetKey, root) {
  return `${deploymentRootPrefix(targetKey, root)}/mutation-owner.json`;
}
/** @param {string} targetKey @param {TerraformRoot} root @param {string} executionId @param {string} stage @param {string} action */
export function deriveMutationActionKey(targetKey, root, executionId, stage, action) {
  requireGroupedLowercaseUuid(executionId, 'Mutation execution ID');
  const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u;
  return `${deploymentRootPrefix(targetKey, root)}/actions/${executionId}/${requireString(stage, 'Mutation stage', namePattern)}/${requireString(action, 'Mutation action', namePattern)}.json`;
}
/** @param {unknown} value @param {string} targetKey @param {TerraformRoot} root */
export function admitMutationOwner(value, targetKey, root) {
  const input = packageRecord(value, ['targetKey', 'root', 'executionId', 'packageSha256'], 'Mutation owner');
  if (input['targetKey'] !== targetKey || input['root'] !== root)
    throw new Error('Mutation owner belongs to another target/root.');
  return deepFreeze({
    targetKey,
    root,
    executionId: requireGroupedLowercaseUuid(input['executionId'], 'Mutation execution ID'),
    packageSha256: requireString(input['packageSha256'], 'Mutation package SHA256', /^[a-f0-9]{64}$/u),
  });
}
/** @param {ObjectObservation|null} expected @param {ObjectObservation|null} actual */
export function assertObjectPrecondition(expected, actual) {
  if (expected === null && actual === null) return;
  if (
    expected === null ||
    actual === null ||
    canonicalRecordJson(admitObjectObservation(expected)) !== canonicalRecordJson(admitObjectObservation(actual))
  )
    throw new Error('Object changed since the plan fixed its publication precondition.');
}
/** @param {import('./plan-package.js').PlanPackage} plan @param {import('./plan-package.js').ObjectReference} reference @param {ObjectObservation|null} current */
export function prepareMutationOwner(plan, reference, current) {
  assertPlanPackageReference(plan, reference);
  assertObjectPrecondition(plan.publication.mutationOwner, current);
  if (current === null && !plan.publication.initialPublication)
    throw new Error('Missing owner does not authorize initialization.');
  return admitMutationOwner(
    {
      targetKey: plan.targetKey,
      root: plan.root,
      executionId: plan.execution.executionId,
      packageSha256: reference.sha256,
    },
    plan.targetKey,
    plan.root,
  );
}
/** @param {import('./plan-package.js').PlanPackage} plan @param {import('./plan-package.js').ObjectReference} reference @param {unknown} owner @param {{executionId:string,stage:string,action:string,status:string}|null} predecessor */
export function assertMutationContinuation(plan, reference, owner, predecessor) {
  assertPlanPackageReference(plan, reference);
  const current = admitMutationOwner(owner, plan.targetKey, plan.root);
  if (current.executionId !== plan.execution.executionId || current.packageSha256 !== reference.sha256)
    throw new Error('Mutation continuation is not the current owner.');
  if (predecessor !== null && (predecessor.status !== 'Succeeded' || predecessor.executionId !== current.executionId))
    throw new Error('Mutation predecessor has not succeeded in this execution.');
  return current;
}
/** @param {string} body @param {ObjectObservation} observation @param {string} targetKey @param {TerraformRoot} root */
export function parseMutationOwner(body, observation, targetKey, root) {
  const observed = admitObjectObservation(observation);
  if (
    observed.key !== deriveMutationOwnerKey(targetKey, root) ||
    storedBytesSha256(body) !== observed.sha256 ||
    Buffer.byteLength(body) > 4096
  )
    throw new Error('Mutation owner byte reference mismatch.');
  const owner = admitMutationOwner(JSON.parse(body), targetKey, root);
  if (canonicalRecordJson(owner) !== body) throw new Error('Mutation owner bytes are not canonical.');
  return owner;
}
