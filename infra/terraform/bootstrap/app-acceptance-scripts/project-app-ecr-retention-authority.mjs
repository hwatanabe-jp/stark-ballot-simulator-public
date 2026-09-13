import { admitAppCurrentAcceptancePointer } from '../../../../packages/deployment-authority/src/app-acceptance-ledger.js';
import { projectRetainedAppImageAuthority } from '../../../../packages/deployment-authority/src/app-acceptance-projections.js';
import {
  snapshotDataTree,
  snapshotDenseArray,
  snapshotExactRecord,
} from '../../../../packages/deployment-authority/src/descriptor-snapshot.js';
import {
  canonicalRecordJson,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '../../../../packages/deployment-authority/src/index.js';

/**
 * Project the complete current/retained App image authority consumed by the
 * Foundation-owned retention controller. No release pointer is resolved here;
 * every digest comes directly from the already bound App acceptances.
 *
 * @param {unknown} input
 * @param {string} expectedTargetKey
 */
export function projectAppEcrRetentionAuthority(input, expectedTargetKey) {
  const TARGET = resolveAllowedDeploymentTarget(expectedTargetKey);
  const APP_AUTHORITY = resolveDeploymentLaneAuthority(TARGET, 'app');
  const CURRENT_POINTER_KEY = APP_AUTHORITY.names.acceptedDeploymentPointerKey;
  const history = snapshotExactRecord(
    snapshotDataTree(input, 'App ECR-retention acceptance history'),
    ['pointer', 'pointerKey', 'pointerObservation', 'resolutionType', 'selections'],
    'App ECR-retention acceptance history',
  );
  if (history['resolutionType'] !== 'app-acceptance-history' || history['pointerKey'] !== CURRENT_POINTER_KEY) {
    throw new Error('App ECR-retention acceptance history is invalid.');
  }
  const pointer = admitAppCurrentAcceptancePointer(history['pointer'], TARGET.targetKey);
  const selections = snapshotDenseArray(history['selections'], 'App ECR-retention acceptance selections');
  if (selections.length !== pointer.history.length) {
    throw new Error('App ECR-retention acceptance selections do not match the observed history.');
  }
  const pointerJson = canonicalRecordJson(pointer);
  const pointerObservationJson = canonicalRecordJson(history['pointerObservation']);
  const admittedSelections = selections.map((value, index) => {
    const selection = snapshotExactRecord(
      value,
      [
        'acceptance',
        'acceptanceKey',
        'acceptanceObservation',
        'pointer',
        'pointerObservation',
        'selectionType',
        'targetKey',
      ],
      `App ECR-retention acceptance selection ${index}`,
    );
    const expectedType = index === 0 ? 'current' : 'retained';
    if (
      selection['selectionType'] !== expectedType ||
      selection['acceptanceKey'] !== pointer.history[index] ||
      selection['targetKey'] !== TARGET.targetKey ||
      canonicalRecordJson(selection['pointer']) !== pointerJson ||
      canonicalRecordJson(selection['pointerObservation']) !== pointerObservationJson
    ) {
      throw new Error('App ECR-retention acceptance selections do not match the observed history.');
    }
    return selection;
  });
  const retainedImageAuthorities = Object.freeze(
    admittedSelections.map((selection) => projectRetainedAppImageAuthority(selection, TARGET.targetKey)),
  );
  return Object.freeze({
    authorityType: /** @type {const} */ ('app-ecr-retention-authority'),
    targetKey: TARGET.targetKey,
    currentAcceptanceKey: pointer.headKey,
    retainedImageAuthorities,
  });
}
