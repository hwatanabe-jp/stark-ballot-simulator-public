import { isDeepStrictEqual } from 'node:util';
import {
  canonicalRecordJson,
  canonicalJsonSha256,
  deepFreeze,
  parseFullSourceSha,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';
import { validateAcceptedDeploymentCurrentAuthority } from './app-acceptance.js';
import {
  parseDeploymentLaneContext,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from './index.js';
import { validateTerraformDriftSummary } from './terraform-drift.js';

const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const ROLLBACK_READINESS_DEPENDENCY_CATEGORIES = Object.freeze([
  'accepted-baseline',
  'app-deployment-record',
  'approval',
  'candidate-record',
  'foundation-handoff',
  'image-id-method',
  'lambda-finalization-writer',
  'lambda-image-signature-verifier',
  'lambda-proof-dispatcher',
  'lambda-public-api',
  'lambda-semaphore-janitor',
  'lambda-verification-worker',
  'plan-inputs',
  'prover-image-digest',
  'prover-image-signature',
  'prover-release',
  'rollback-history',
  'smoke',
  'static-archive',
  'toolchain-release',
  'verifier-authority',
]);

const OBJECT_DEPENDENCY_CATEGORIES = new Set([
  'accepted-baseline',
  'app-deployment-record',
  'approval',
  'candidate-record',
  'foundation-handoff',
  'lambda-finalization-writer',
  'lambda-image-signature-verifier',
  'lambda-proof-dispatcher',
  'lambda-public-api',
  'lambda-semaphore-janitor',
  'lambda-verification-worker',
  'prover-release',
  'smoke',
  'static-archive',
  'toolchain-release',
  'verifier-authority',
]);

const INPUT_KEYS = [
  'acceptedBaseline',
  'candidate',
  'currentAuthority',
  'currentControlSourceSha',
  'dependencies',
  'finishedAt',
  'planSummary',
  'reviewedControlSourceSha',
  'startedAt',
  'targetContext',
];
const CURRENT_AUTHORITY_KEYS = ['body', 'pointerAfter', 'pointerBefore'];
const CANDIDATE_KEYS = [
  'acceptanceAttemptId',
  'accountId',
  'backendKey',
  'controlSourceSha',
  'deploymentEnvironment',
  'pipelineExecutionId',
  'planChecksum',
  'recordType',
  'reference',
  'region',
  'selectedSourceSha',
  'sourceSha',
  'stateIdentity',
];
const BASELINE_KEYS = [
  'acceptanceAttemptId',
  'acceptedPlanChecksum',
  'backendKey',
  'controlSourceSha',
  'pipelineExecutionId',
  'recordType',
  'reference',
  'stateIdentity',
];
const DEPENDENCY_KEYS = [
  'category',
  'expectedValueSha256',
  'observedReference',
  'observedValueSha256',
  'reference',
  'status',
];
const EVIDENCE_KEYS = [
  'acceptedAppBaseline',
  'candidate',
  'controlSourceSha',
  'currentAcceptedAuthority',
  'dependencies',
  'evidenceType',
  'finishedAt',
  'planSummary',
  'rejectedDependencies',
  'reportOnly',
  'result',
  'startedAt',
  'target',
];
const EVIDENCE_AUTHORITY_KEYS = ['bodySha256', 'currentHead', 'pointer'];
const EVIDENCE_CANDIDATE_KEYS = ['acceptanceAttemptId', 'pipelineExecutionId', 'reference', 'selectedSourceSha'];
const EVIDENCE_TARGET_KEYS = [
  'accountId',
  'backendKey',
  'deploymentEnvironment',
  'region',
  'stateIdentity',
  'targetContextSha256',
  'targetKey',
];

function exactRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact semantic shape.`, { cause: error });
  }
}

function denseDataArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const entries = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-property array.`);
    }
    entries.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== entries.length + 1) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  return entries;
}

function parseCanonicalTimestamp(value, label) {
  const timestamp = requireString(value, label, CANONICAL_TIMESTAMP_PATTERN);
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

function parseTargetContext(value) {
  const context = parseDeploymentLaneContext(value);
  if (context.root.lane !== 'app' || context.root.scope !== 'app') {
    throw new Error('Rollback readiness target context must select the App lane.');
  }
  return context;
}

function parseCurrentAuthority(value, context) {
  const observation = exactRecord(value, CURRENT_AUTHORITY_KEYS, 'Rollback current accepted authority');
  let authority;
  try {
    authority = validateAcceptedDeploymentCurrentAuthority(observation.body);
  } catch (error) {
    throw new Error('Rollback current accepted authority body is invalid.', { cause: error });
  }
  if (authority.stateIdentity !== context.root.stateIdentity) {
    throw new Error('Rollback current accepted authority state identity is invalid.');
  }
  const bodySha256 = sha256Text(canonicalRecordJson(authority));
  const pointerBefore = parseImmutableObjectReference(observation.pointerBefore);
  const pointerAfter = parseImmutableObjectReference(observation.pointerAfter);
  if (
    pointerBefore.key !== context.names.acceptedDeploymentPointerKey ||
    pointerBefore.sha256 !== bodySha256 ||
    !isDeepStrictEqual(pointerBefore, pointerAfter)
  ) {
    throw new Error('Rollback current accepted authority pointer changed or does not bind its admitted body.');
  }
  const acceptedDeployments = denseDataArray(
    authority.acceptedDeployments,
    'Rollback current accepted authority deployments',
  );
  if (acceptedDeployments.length === 0 || acceptedDeployments.length > 10) {
    throw new Error('Rollback reachable candidate references are invalid.');
  }
  const reachableCandidates = acceptedDeployments.map((entry) =>
    parseImmutableObjectReference({
      key: entry.manifestPath,
      versionId: entry.manifestVersionId,
      sha256: entry.manifestSha256,
    }),
  );
  if (new Set(reachableCandidates.map((reference) => JSON.stringify(reference))).size !== reachableCandidates.length) {
    throw new Error('Rollback reachable candidate references must be unique.');
  }
  return { bodySha256, currentHead: reachableCandidates[0], pointer: pointerBefore, reachableCandidates };
}

export function deriveRollbackHistoryDependencyObservation(currentHeadValue, candidateValue) {
  const currentHead = parseImmutableObjectReference(currentHeadValue);
  const candidate = parseImmutableObjectReference(candidateValue);
  const expectedSemanticValue = {
    candidate,
    currentHead,
    requirement: 'retained-candidate-is-not-current-head',
    satisfied: true,
  };
  const historyAvailable = !isDeepStrictEqual(currentHead, candidate);
  const observedSemanticValue = historyAvailable
    ? expectedSemanticValue
    : { ...expectedSemanticValue, satisfied: false };
  return deepFreeze({
    category: 'rollback-history',
    status: historyAvailable ? 'available' : 'rejected',
    reference: null,
    observedReference: null,
    expectedValueSha256: canonicalJsonSha256(expectedSemanticValue),
    observedValueSha256: canonicalJsonSha256(observedSemanticValue),
  });
}

function parseCandidate(value, context, currentAuthority) {
  const candidate = exactRecord(value, CANDIDATE_KEYS, 'Rollback candidate');
  if (candidate.recordType !== 'app-accepted-deployment') {
    throw new Error('Rollback candidate record type is invalid.');
  }
  const reference = parseImmutableObjectReference(candidate.reference);
  const pipelineExecutionId = requireGroupedLowercaseUuid(
    candidate.pipelineExecutionId,
    'Rollback candidate pipeline execution ID',
  );
  const acceptanceAttemptId = requireGroupedLowercaseUuid(
    candidate.acceptanceAttemptId,
    'Rollback candidate acceptance attempt ID',
  );
  const expectedCandidateKey =
    `${context.names.acceptedDeploymentPrefix}/executions/${pipelineExecutionId}/attempts/` +
    `${acceptanceAttemptId}/authoritative-app-deployment.json`;
  if (reference.key !== expectedCandidateKey) {
    throw new Error('Rollback candidate immutable key is not canonical for its acceptance identity.');
  }
  if (!currentAuthority.reachableCandidates.some((reachable) => isDeepStrictEqual(reachable, reference))) {
    throw new Error('Rollback candidate is outside current retained semantic reachability.');
  }
  const sourceSha = parseFullSourceSha(candidate.sourceSha, 'Rollback candidate source SHA');
  const selectedSourceSha = parseFullSourceSha(candidate.selectedSourceSha, 'Rollback candidate selected source SHA');
  const controlSourceSha = parseFullSourceSha(candidate.controlSourceSha, 'Rollback candidate control source SHA');
  const planChecksum = parseSha256(candidate.planChecksum, 'Rollback candidate plan checksum');
  if (
    selectedSourceSha !== sourceSha ||
    candidate.accountId !== context.target.accountId ||
    candidate.region !== context.target.region ||
    candidate.deploymentEnvironment !== context.target.environmentId ||
    candidate.stateIdentity !== context.root.stateIdentity ||
    candidate.backendKey !== context.root.backendKey ||
    context.source.selectedApplicationSourceSha !== sourceSha
  ) {
    throw new Error('Rollback candidate contradicts its exact target or selected application source.');
  }
  return {
    reference,
    pipelineExecutionId,
    acceptanceAttemptId,
    sourceSha,
    selectedSourceSha,
    controlSourceSha,
    planChecksum,
  };
}

function parseAcceptedBaseline(value, context, candidate) {
  const baseline = exactRecord(value, BASELINE_KEYS, 'Rollback accepted App baseline');
  if (baseline.recordType !== 'accepted-terraform-baseline') {
    throw new Error('Rollback accepted App baseline record type is invalid.');
  }
  const reference = parseImmutableObjectReference(baseline.reference);
  const expectedBaselineKey =
    `${context.names.terraformBaselinePrefix}/${context.root.stateIdentity}/executions/` +
    `${candidate.pipelineExecutionId}/attempts/${candidate.acceptanceAttemptId}/baseline.json`;
  if (
    reference.key !== expectedBaselineKey ||
    baseline.pipelineExecutionId !== candidate.pipelineExecutionId ||
    baseline.acceptanceAttemptId !== candidate.acceptanceAttemptId ||
    baseline.acceptedPlanChecksum !== candidate.planChecksum ||
    baseline.controlSourceSha !== candidate.controlSourceSha ||
    baseline.stateIdentity !== context.root.stateIdentity ||
    baseline.backendKey !== context.root.backendKey
  ) {
    throw new Error('Rollback accepted App baseline contradicts the selected candidate.');
  }
  return reference;
}

function parseDependency(value) {
  const dependency = exactRecord(value, DEPENDENCY_KEYS, 'Rollback dependency observation');
  if (!ROLLBACK_READINESS_DEPENDENCY_CATEGORIES.includes(dependency.category)) {
    throw new Error('Rollback dependency category is invalid.');
  }
  if (!['available', 'missing', 'rejected'].includes(dependency.status)) {
    throw new Error('Rollback dependency status is invalid.');
  }
  const objectDependency = OBJECT_DEPENDENCY_CATEGORIES.has(dependency.category);
  const reference = dependency.reference === null ? null : parseImmutableObjectReference(dependency.reference);
  const observedReference =
    dependency.observedReference === null ? null : parseImmutableObjectReference(dependency.observedReference);
  const expectedValueSha256 =
    dependency.expectedValueSha256 === null
      ? null
      : parseSha256(dependency.expectedValueSha256, 'Rollback dependency expected value SHA-256');
  const observedValueSha256 =
    dependency.observedValueSha256 === null
      ? null
      : parseSha256(dependency.observedValueSha256, 'Rollback dependency observed value SHA-256');
  if (
    (objectDependency && (reference === null || expectedValueSha256 !== null || observedValueSha256 !== null)) ||
    (!objectDependency && (reference !== null || observedReference !== null || expectedValueSha256 === null)) ||
    (dependency.status === 'available' && objectDependency && !isDeepStrictEqual(reference, observedReference)) ||
    (dependency.status === 'available' && !objectDependency && observedValueSha256 !== expectedValueSha256) ||
    (dependency.status === 'missing' && (observedReference !== null || observedValueSha256 !== null)) ||
    (dependency.status === 'rejected' && objectDependency && isDeepStrictEqual(reference, observedReference)) ||
    (dependency.status === 'rejected' && !objectDependency && observedValueSha256 === expectedValueSha256)
  ) {
    throw new Error('Rollback dependency observation is inconsistent with its category and status.');
  }
  return deepFreeze({
    category: dependency.category,
    status: dependency.status,
    reference,
    observedReference,
    expectedValueSha256,
    observedValueSha256,
  });
}

function parseDependencies(value) {
  const entries = denseDataArray(value, 'Rollback dependency observations');
  if (entries.length !== ROLLBACK_READINESS_DEPENDENCY_CATEGORIES.length) {
    throw new Error('Rollback dependency observations must cover every closed category exactly once.');
  }
  const dependencies = entries
    .map(parseDependency)
    .sort((left, right) => (left.category < right.category ? -1 : left.category > right.category ? 1 : 0));
  if (
    dependencies.some((dependency, index) => dependency.category !== ROLLBACK_READINESS_DEPENDENCY_CATEGORIES[index])
  ) {
    throw new Error('Rollback dependency observations must cover every closed category exactly once.');
  }
  return dependencies;
}

function parsePlanSummary(value) {
  return value === null ? null : validateTerraformDriftSummary(value);
}

function parseEvidenceTarget(value) {
  const target = exactRecord(value, EVIDENCE_TARGET_KEYS, 'Rollback readiness target');
  const parsed = {
    targetKey: requireString(target.targetKey, 'Rollback readiness target key'),
    accountId: requireString(target.accountId, 'Rollback readiness account ID', /^[0-9]{12}$/u),
    region: requireString(target.region, 'Rollback readiness region'),
    deploymentEnvironment: requireString(target.deploymentEnvironment, 'Rollback readiness environment'),
    stateIdentity: requireString(target.stateIdentity, 'Rollback readiness state identity'),
    backendKey: requireString(target.backendKey, 'Rollback readiness backend key'),
    targetContextSha256: parseSha256(target.targetContextSha256, 'Rollback readiness target context SHA-256'),
  };
  const allowedTarget = resolveAllowedDeploymentTarget('stark-dev/develop');
  const appAuthority = resolveDeploymentLaneAuthority(allowedTarget, 'app');
  if (
    parsed.targetKey !== allowedTarget.targetKey ||
    parsed.accountId !== allowedTarget.accountId ||
    parsed.region !== allowedTarget.region ||
    parsed.deploymentEnvironment !== allowedTarget.environmentId ||
    parsed.stateIdentity !== appAuthority.stateIdentity ||
    parsed.backendKey !== appAuthority.backendKey
  ) {
    throw new Error('Rollback readiness target does not match the reviewed App lane.');
  }
  return deepFreeze(parsed);
}

export function validateRollbackReadinessEvidence(value) {
  const evidence = exactRecord(value, EVIDENCE_KEYS, 'Rollback readiness evidence');
  if (evidence.evidenceType !== 'app-rollback-readiness' || evidence.reportOnly !== true) {
    throw new Error('Rollback readiness evidence type or report-only boundary is invalid.');
  }
  const target = parseEvidenceTarget(evidence.target);
  const currentAuthority = exactRecord(
    evidence.currentAcceptedAuthority,
    EVIDENCE_AUTHORITY_KEYS,
    'Rollback readiness current authority',
  );
  const parsedCurrentAuthority = deepFreeze({
    pointer: parseImmutableObjectReference(currentAuthority.pointer),
    bodySha256: parseSha256(currentAuthority.bodySha256, 'Rollback readiness current authority body SHA-256'),
    currentHead: parseImmutableObjectReference(currentAuthority.currentHead),
  });
  if (parsedCurrentAuthority.pointer.sha256 !== parsedCurrentAuthority.bodySha256) {
    throw new Error('Rollback readiness current authority pointer does not bind its body.');
  }
  const allowedTarget = resolveAllowedDeploymentTarget('stark-dev/develop');
  const appAuthority = resolveDeploymentLaneAuthority(allowedTarget, 'app');
  if (parsedCurrentAuthority.pointer.key !== appAuthority.names.acceptedDeploymentPointerKey) {
    throw new Error('Rollback readiness current authority pointer key is invalid.');
  }
  const candidate = exactRecord(evidence.candidate, EVIDENCE_CANDIDATE_KEYS, 'Rollback readiness candidate');
  const parsedCandidate = deepFreeze({
    reference: parseImmutableObjectReference(candidate.reference),
    pipelineExecutionId: requireGroupedLowercaseUuid(
      candidate.pipelineExecutionId,
      'Rollback readiness pipeline execution ID',
    ),
    acceptanceAttemptId: requireGroupedLowercaseUuid(
      candidate.acceptanceAttemptId,
      'Rollback readiness acceptance attempt ID',
    ),
    selectedSourceSha: parseFullSourceSha(candidate.selectedSourceSha, 'Rollback readiness selected source SHA'),
  });
  const acceptedAppBaseline = parseImmutableObjectReference(evidence.acceptedAppBaseline);
  const expectedCandidateKey =
    `${appAuthority.names.acceptedDeploymentPrefix}/executions/${parsedCandidate.pipelineExecutionId}/attempts/` +
    `${parsedCandidate.acceptanceAttemptId}/authoritative-app-deployment.json`;
  const expectedBaselineKey =
    `${appAuthority.names.terraformBaselinePrefix}/${appAuthority.stateIdentity}/executions/` +
    `${parsedCandidate.pipelineExecutionId}/attempts/${parsedCandidate.acceptanceAttemptId}/baseline.json`;
  if (parsedCandidate.reference.key !== expectedCandidateKey || acceptedAppBaseline.key !== expectedBaselineKey) {
    throw new Error('Rollback readiness candidate or baseline key is not canonical.');
  }
  const controlSourceSha = parseFullSourceSha(evidence.controlSourceSha, 'Rollback readiness control source SHA');
  const evidenceTargetContext = renderDeploymentLaneContext({
    target: allowedTarget,
    lane: 'app',
    accountId: allowedTarget.accountId,
    requestedControlSourceSha: controlSourceSha,
    selectedApplicationSourceSha: parsedCandidate.selectedSourceSha,
    frameworkSourceSha: controlSourceSha,
  });
  if (canonicalJsonSha256(evidenceTargetContext) !== target.targetContextSha256) {
    throw new Error('Rollback readiness target context SHA-256 is invalid.');
  }
  const dependencies = parseDependencies(evidence.dependencies);
  const baselineDependency = dependencies.find(({ category }) => category === 'accepted-baseline');
  const candidateDependency = dependencies.find(({ category }) => category === 'candidate-record');
  if (baselineDependency === undefined || !isDeepStrictEqual(baselineDependency.reference, acceptedAppBaseline)) {
    throw new Error('Rollback accepted baseline dependency does not bind the admitted baseline.');
  }
  if (
    candidateDependency === undefined ||
    !isDeepStrictEqual(candidateDependency.reference, parsedCandidate.reference)
  ) {
    throw new Error('Rollback candidate dependency does not bind the admitted candidate.');
  }
  const historyDependency = dependencies.find(({ category }) => category === 'rollback-history');
  const expectedHistoryDependency = deriveRollbackHistoryDependencyObservation(
    parsedCurrentAuthority.currentHead,
    parsedCandidate.reference,
  );
  if (!isDeepStrictEqual(historyDependency, expectedHistoryDependency)) {
    throw new Error('Rollback history dependency does not bind the current accepted head.');
  }
  const rejectedDependencies = dependencies
    .filter((dependency) => dependency.status !== 'available')
    .map((dependency) => dependency.category);
  const reportedRejectedDependencies = denseDataArray(
    evidence.rejectedDependencies,
    'Rollback readiness rejected dependencies',
  );
  if (!isDeepStrictEqual(reportedRejectedDependencies, rejectedDependencies)) {
    throw new Error('Rollback readiness rejected dependency categories are inconsistent.');
  }
  const result = rejectedDependencies.length === 0 ? 'ready' : 'not-ready';
  if (evidence.result !== result) {
    throw new Error('Rollback readiness result is inconsistent with dependency observations.');
  }
  const startedAt = parseCanonicalTimestamp(evidence.startedAt, 'Rollback readiness startedAt');
  const finishedAt = parseCanonicalTimestamp(evidence.finishedAt, 'Rollback readiness finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Rollback readiness finishedAt must not precede startedAt.');
  }
  return deepFreeze({
    evidenceType: 'app-rollback-readiness',
    target,
    currentAcceptedAuthority: parsedCurrentAuthority,
    candidate: parsedCandidate,
    acceptedAppBaseline,
    controlSourceSha,
    dependencies,
    planSummary: parsePlanSummary(evidence.planSummary),
    startedAt,
    finishedAt,
    result,
    rejectedDependencies,
    reportOnly: true,
  });
}

export function evaluateRollbackReadiness(value) {
  const input = exactRecord(value, INPUT_KEYS, 'Rollback readiness input');
  const context = parseTargetContext(input.targetContext);
  const reviewedControlSourceSha = parseFullSourceSha(
    input.reviewedControlSourceSha,
    'Rollback readiness reviewed control source SHA',
  );
  const currentControlSourceSha = parseFullSourceSha(
    input.currentControlSourceSha,
    'Rollback readiness current control source SHA',
  );
  if (
    reviewedControlSourceSha !== currentControlSourceSha ||
    reviewedControlSourceSha !== context.source.requestedControlSourceSha ||
    reviewedControlSourceSha !== context.source.frameworkSourceSha
  ) {
    throw new Error('Rollback readiness current control source is not the explicitly reviewed source.');
  }
  const currentAuthority = parseCurrentAuthority(input.currentAuthority, context);
  const candidate = parseCandidate(input.candidate, context, currentAuthority);
  const acceptedAppBaseline = parseAcceptedBaseline(input.acceptedBaseline, context, candidate);
  const parsedDependencies = parseDependencies(input.dependencies);
  const derivedHistoryDependency = deriveRollbackHistoryDependencyObservation(
    currentAuthority.currentHead,
    candidate.reference,
  );
  const dependencies = parsedDependencies.map((dependency) =>
    dependency.category === 'rollback-history' ? derivedHistoryDependency : dependency,
  );
  const baselineDependency = dependencies.find(({ category }) => category === 'accepted-baseline');
  const candidateDependency = dependencies.find(({ category }) => category === 'candidate-record');
  if (baselineDependency === undefined || !isDeepStrictEqual(baselineDependency.reference, acceptedAppBaseline)) {
    throw new Error('Rollback accepted baseline dependency does not bind the admitted baseline.');
  }
  if (candidateDependency === undefined || !isDeepStrictEqual(candidateDependency.reference, candidate.reference)) {
    throw new Error('Rollback candidate dependency does not bind the admitted candidate.');
  }
  const rejectedDependencies = dependencies
    .filter((dependency) => dependency.status !== 'available')
    .map((dependency) => dependency.category);
  const startedAt = parseCanonicalTimestamp(input.startedAt, 'Rollback readiness startedAt');
  const finishedAt = parseCanonicalTimestamp(input.finishedAt, 'Rollback readiness finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('Rollback readiness finishedAt must not precede startedAt.');
  }
  return validateRollbackReadinessEvidence({
    evidenceType: 'app-rollback-readiness',
    target: {
      targetKey: `${context.target.accountLabel}/${context.target.environmentId}`,
      accountId: context.target.accountId,
      region: context.target.region,
      deploymentEnvironment: context.target.environmentId,
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
      targetContextSha256: canonicalJsonSha256(context),
    },
    currentAcceptedAuthority: {
      pointer: currentAuthority.pointer,
      bodySha256: currentAuthority.bodySha256,
      currentHead: currentAuthority.currentHead,
    },
    candidate: {
      reference: candidate.reference,
      pipelineExecutionId: candidate.pipelineExecutionId,
      acceptanceAttemptId: candidate.acceptanceAttemptId,
      selectedSourceSha: candidate.selectedSourceSha,
    },
    acceptedAppBaseline,
    controlSourceSha: currentControlSourceSha,
    dependencies,
    planSummary: parsePlanSummary(input.planSummary),
    startedAt,
    finishedAt,
    result: rejectedDependencies.length === 0 ? 'ready' : 'not-ready',
    rejectedDependencies,
    reportOnly: true,
  });
}
