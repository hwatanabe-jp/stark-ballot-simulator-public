import { types } from 'node:util';

import { snapshotDataTree } from './descriptor-snapshot.js';
import { canonicalRecordJson, deepFreeze, parseGitCommitSha, requireExactKeys, requireString } from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';

const APP_DEPLOYMENT_STATUS_TTL_DAYS = 30;
export const APP_DEPLOYMENT_STATUS_MAX_BYTES = 4096;

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const STATUS_KEYS = [
  'acceptedAt',
  'deploymentId',
  'deploymentMode',
  'planDisposition',
  'prover',
  'smokeOutcome',
  'source',
  'staleAfter',
  'updatedAt',
];
const SOURCE_KEYS = ['commitUrl', 'shortSha'];
const PROVER_KEYS = ['imageDigestPrefix', 'imageId', 'methodVersion'];
const DEPLOYMENT_ID_PATTERN = /^dep_[0-9a-f]{32}$/u;
const SHORT_SHA_PATTERN = /^[0-9a-f]{12}$/u;
const IMAGE_DIGEST_PREFIX_PATTERN = /^sha256:[0-9a-f]{12}$/u;
const IMAGE_ID_PATTERN = /^0x[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TTL_MILLISECONDS = APP_DEPLOYMENT_STATUS_TTL_DAYS * 24 * 60 * 60 * 1_000;

/**
 * @typedef {{
 *   readonly shortSha: string;
 *   readonly commitUrl: string;
 * }} AppDeploymentStatusSource
 * @typedef {{
 *   readonly imageDigestPrefix: string;
 *   readonly imageId: string;
 *   readonly methodVersion: number;
 * }} AppDeploymentStatusProver
 * @typedef {{
 *   readonly deploymentId: string;
 *   readonly source: AppDeploymentStatusSource;
 *   readonly prover: AppDeploymentStatusProver;
 *   readonly deploymentMode: 'normal';
 *   readonly planDisposition: 'changed' | 'empty';
 *   readonly smokeOutcome: 'passed';
 *   readonly acceptedAt: string;
 *   readonly updatedAt: string;
 *   readonly staleAfter: string;
 * }} AppDeploymentStatus
 */

/**
 * Reject proxies recursively without reading through their property access
 * paths. The descriptor snapshot performs the remaining data-shape checks.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {Set<object>} [ancestors]
 */
function rejectProxies(value, label, ancestors = new Set()) {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (ancestors.has(value)) {
    return;
  }
  ancestors.add(value);
  try {
    const keys = inspectStatusOwnKeys(value, label);
    for (const key of keys) {
      let descriptor;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        throw new Error(`${label} must contain only inspectable data.`, { cause: error });
      }
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxies(descriptor.value, label, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {string} label */
function snapshotInput(value, label) {
  rejectProxies(value, label);
  try {
    return snapshotDataTree(value, `${label} descriptor snapshot`);
  } catch (error) {
    throw new Error(`${label} must use the exact enumerable data shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function canonicalTimestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {string} acceptedAt */
function deriveStaleAfter(acceptedAt) {
  const staleAfter = new Date(Date.parse(acceptedAt) + TTL_MILLISECONDS).toISOString();
  if (!CANONICAL_TIMESTAMP_PATTERN.test(staleAfter)) {
    throw new Error('App deployment status expiry exceeds the admitted timestamp range.');
  }
  return staleAfter;
}

/** @param {unknown} value @param {string} label */
function positiveSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

/** @param {unknown} value @returns {AppDeploymentStatusSource} @param {AllowedDeploymentTarget} target */
function admitSource(value, target) {
  const source = exactKeys(value, SOURCE_KEYS, 'App deployment status source');
  const shortSha = requireString(source['shortSha'], 'App deployment status short source SHA', SHORT_SHA_PATTERN);
  const commitUrl = requireString(source['commitUrl'], 'App deployment status commit URL');
  const expectedPrefix = `${target.repositoryUrl}/commit/`;
  if (!commitUrl.startsWith(expectedPrefix)) {
    throw new Error('App deployment status commit URL is outside the governed repository.');
  }
  const fullSha = parseGitCommitSha(
    commitUrl.slice(expectedPrefix.length),
    'App deployment status commit URL source SHA',
  );
  if (commitUrl !== `${expectedPrefix}${fullSha}` || shortSha !== fullSha.slice(0, 12)) {
    throw new Error('App deployment status source fields are detached.');
  }
  return deepFreeze({ shortSha, commitUrl });
}

/** @param {unknown} value @returns {AppDeploymentStatusProver} */
function admitProver(value) {
  const prover = exactKeys(value, PROVER_KEYS, 'App deployment status Prover');
  return deepFreeze({
    imageDigestPrefix: requireString(
      prover['imageDigestPrefix'],
      'App deployment status Prover digest prefix',
      IMAGE_DIGEST_PREFIX_PATTERN,
    ),
    imageId: requireString(prover['imageId'], 'App deployment status ImageID', IMAGE_ID_PATTERN),
    methodVersion: positiveSafeInteger(prover['methodVersion'], 'App deployment status methodVersion'),
  });
}

/**
 * Admit one exact public-safe App deployment status DTO.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {AppDeploymentStatus}
 */
export function admitAppDeploymentStatus(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App deployment status expected target'),
  );
  const status = exactKeys(snapshotInput(value, 'App deployment status'), STATUS_KEYS, 'App deployment status');
  const deploymentId = requireString(
    status['deploymentId'],
    'App deployment status deployment ID',
    DEPLOYMENT_ID_PATTERN,
  );
  const source = admitSource(status['source'], target);
  const prover = admitProver(status['prover']);
  const deploymentMode = status['deploymentMode'];
  if (deploymentMode !== 'normal') {
    throw new Error('App deployment status deployment mode is invalid.');
  }
  const planDisposition = status['planDisposition'];
  if (planDisposition !== 'changed' && planDisposition !== 'empty') {
    throw new Error('App deployment status plan disposition is invalid.');
  }
  if (status['smokeOutcome'] !== 'passed') {
    throw new Error('App deployment status smoke outcome must be passed.');
  }
  const acceptedAt = canonicalTimestamp(status['acceptedAt'], 'App deployment status acceptedAt');
  const updatedAt = canonicalTimestamp(status['updatedAt'], 'App deployment status updatedAt');
  if (updatedAt !== acceptedAt) {
    throw new Error('App deployment status updatedAt must equal acceptedAt.');
  }
  const staleAfter = canonicalTimestamp(status['staleAfter'], 'App deployment status staleAfter');
  if (staleAfter !== deriveStaleAfter(acceptedAt)) {
    throw new Error('App deployment status staleAfter is detached from acceptedAt.');
  }
  return deepFreeze({
    deploymentId,
    source,
    prover,
    deploymentMode,
    planDisposition,
    smokeOutcome: /** @type {const} */ ('passed'),
    acceptedAt,
    updatedAt,
    staleAfter,
  });
}

/**
 * Project the established public DTO from one successful App checkpoint.
 * Stored checkpoint bytes are admitted once at their read boundary.
 * @param {import('./root-checkpoint.js').RootCheckpoint} value
 * @param {unknown} expectedTargetKey
 * @returns {AppDeploymentStatus}
 */
export function projectAppDeploymentStatus(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(requireString(expectedTargetKey, 'App status target'));
  const checkpoint = value;
  if (checkpoint.targetKey !== target.targetKey) throw new Error('App status target mismatch.');
  if (checkpoint.root !== 'app') throw new Error('App status requires an App checkpoint.');
  const { sourceSha, acceptedAt, outputs } = checkpoint;
  return admitAppDeploymentStatus(
    {
      deploymentId: outputs.deploymentId,
      source: { shortSha: sourceSha.slice(0, 12), commitUrl: `${target.repositoryUrl}/commit/${sourceSha}` },
      prover: {
        imageDigestPrefix: outputs.proverImageDigest.slice(0, 19),
        imageId: outputs.imageId,
        methodVersion: outputs.methodVersion,
      },
      deploymentMode: 'normal',
      planDisposition: outputs.planDisposition,
      smokeOutcome: 'passed',
      acceptedAt,
      updatedAt: acceptedAt,
      staleAfter: deriveStaleAfter(acceptedAt),
    },
    target.targetKey,
  );
}

/**
 * Parse only byte-canonical, newline-terminated App deployment status JSON.
 *
 * @param {unknown} body
 * @param {unknown} expectedTargetKey
 * @returns {AppDeploymentStatus}
 */
export function parseCanonicalAppDeploymentStatus(body, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App deployment status expected target'),
  );
  if (typeof body !== 'string') {
    throw new Error('Canonical App deployment status body must be a string.');
  }
  if (Buffer.byteLength(body, 'utf8') > APP_DEPLOYMENT_STATUS_MAX_BYTES) {
    throw new Error('Canonical App deployment status body exceeds its byte limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error('Canonical App deployment status body is malformed.', { cause: error });
  }
  const admitted = admitAppDeploymentStatus(parsed, target.targetKey);
  if (body !== canonicalRecordJson(admitted)) {
    throw new Error('App deployment status body must use canonical newline-terminated JSON.');
  }
  return admitted;
}

/**
 * Render one admitted App deployment status as canonical newline-terminated
 * JSON.
 *
 * @param {unknown} value
 * @param {unknown} expectedTargetKey
 * @returns {string}
 */
export function canonicalAppDeploymentStatusJson(value, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App deployment status expected target'),
  );
  const body = canonicalRecordJson(admitAppDeploymentStatus(value, target.targetKey));
  if (Buffer.byteLength(body, 'utf8') > APP_DEPLOYMENT_STATUS_MAX_BYTES) {
    throw new Error('Canonical App deployment status body exceeds its byte limit.');
  }
  return body;
}

/** @param {object} value @param {string} label */
function inspectStatusOwnKeys(value, label) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    throw new Error(`${label} must contain only inspectable data.`, { cause: error });
  }
  return keys;
}
