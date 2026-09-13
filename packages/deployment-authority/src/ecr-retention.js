/**
 * @typedef {{
    readonly artifactMediaType: string;
    readonly imageDigest: string;
    readonly imageManifestMediaType: string;
    readonly imagePushedAt: string;
    readonly imageStatus: string;
}} EcrRetentionImage
 */

/**
 * @typedef {{
    readonly artifactDigest: string;
    readonly artifactStatus: string;
    readonly artifactType: string;
    readonly mediaType: string;
}} EcrRetentionReferrer
 */

/**
 * @typedef {{
    readonly paginationComplete: boolean;
    readonly referrers: readonly EcrRetentionReferrer[];
    readonly subjectDigest: string;
}} EcrRetentionSubjectReferrers
 */

/**
 * @typedef {{
    readonly images: readonly EcrRetentionImage[];
    readonly paginationComplete: boolean;
    readonly protectedDigests: readonly string[];
    readonly referrers: readonly EcrRetentionSubjectReferrers[];
    readonly repositoryName: string;
}} EcrRetentionRepositorySnapshot
 */

/**
 * @typedef {{
    readonly environmentId: 'develop' | 'main';
    readonly repositories: Readonly<{
        prover: EcrRetentionRepositorySnapshot;
        toolchain: EcrRetentionRepositorySnapshot;
    }>;
}} EcrSubjectRetentionInput
 */

/**
 * @typedef {'DUPLICATE_IMAGE_DIGEST' | 'DUPLICATE_PROTECTED_DIGEST' | 'DUPLICATE_REFERRER_DIGEST' | 'INCOMPLETE_IMAGE_PAGINATION' | 'INCOMPLETE_REFERRER_PAGINATION' | 'PROTECTED_SUBJECT_MISSING' | 'REFERRER_COVERAGE_INCOMPLETE' | 'REFERRER_INVENTORY_MISMATCH' | 'UNKNOWN_IMAGE_MEDIA' | 'UNKNOWN_IMAGE_STATUS' | 'UNKNOWN_REFERRER_MEDIA' | 'UNKNOWN_REFERRER_STATUS'} EcrRetentionBlocker
 */

/**
 * @typedef {{
    readonly repositoryName: string;
    readonly subjectCount: number;
    readonly protectedSubjectCount: number;
    readonly protectedSubjectDigests: readonly string[];
    readonly targetSubjectCount: number;
    readonly retainedSubjectCount: number;
    readonly deleteReferrerDigests: readonly string[];
    readonly deleteSubjectDigests: readonly string[];
}} EcrRetentionRepositoryPlan
 */

/**
 * @typedef {{
    readonly disposition: 'blocked' | 'delete' | 'no-change';
    readonly blockers: readonly EcrRetentionBlocker[];
    readonly environmentId: 'develop' | 'main';
    readonly snapshotSha256: string;
    readonly repositories: Readonly<{
        prover: EcrRetentionRepositoryPlan;
        toolchain: EcrRetentionRepositoryPlan;
    }>;
}} EcrSubjectRetentionPlan
 */

/**
 * @typedef {{
 *   readonly artifactMediaType: unknown;
 *   readonly imageDigest: string;
 *   readonly imageManifestMediaType: unknown;
 *   readonly imagePushedAt: string;
 *   readonly imageStatus: unknown;
 *   readonly kind: 'subject' | 'referrer' | 'unknown';
 * }} ParsedEcrRetentionImage
 */

/**
 * @typedef {{
 *   readonly artifactDigest: string;
 *   readonly artifactStatus: unknown;
 *   readonly artifactType: unknown;
 *   readonly mediaType: unknown;
 * }} ParsedEcrRetentionReferrer
 */

/**
 * @typedef {{
 *   readonly paginationComplete: boolean;
 *   readonly referrers: ParsedEcrRetentionReferrer[];
 *   readonly subjectDigest: string;
 * }} ParsedEcrRetentionSubjectReferrers
 */

/**
 * @typedef {{
 *   readonly blockers: EcrRetentionBlocker[];
 *   readonly images: ParsedEcrRetentionImage[];
 *   readonly paginationComplete: boolean;
 *   readonly protectedDigests: string[];
 *   readonly referrers: ParsedEcrRetentionSubjectReferrers[];
 *   readonly repositoryName: string;
 * }} ParsedEcrRetentionRepository
 */

import { canonicalJsonSha256, deepFreeze, parseImageDigest, requireExactKeys, requireString } from './internal.js';

const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';
const MAX_DELETE_BATCH_SIZE = 100;

/** @type {Readonly<{develop: 10, main: 10}>} */
export const ECR_SUBJECT_RETENTION_COUNTS = deepFreeze({ develop: 10, main: 10 });

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function requireDenseArray(value, label) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new Error(`${label} must be a dense array.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function parseCanonicalTimestamp(value, label) {
  const timestamp = requireString(value, label);
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

/**
 * @param {unknown} value
 * @param {'prover' | 'toolchain'} kind
 * @returns {ParsedEcrRetentionRepository}
 */
function parseRepositorySnapshot(value, kind) {
  const repository = requireExactKeys(
    value,
    ['images', 'paginationComplete', 'protectedDigests', 'referrers', 'repositoryName'],
    `${kind} ECR repository snapshot`,
  );
  /** @type {EcrRetentionBlocker[]} */
  const blockers = [];
  if (repository['paginationComplete'] !== true) {
    blockers.push('INCOMPLETE_IMAGE_PAGINATION');
  }
  const repositoryName = requireString(repository['repositoryName'], `${kind} ECR repository name`);
  const images = requireDenseArray(repository['images'], `${kind} ECR images`);
  /** @type {ParsedEcrRetentionImage[]} */
  const parsedImages = [];
  const seenImageDigests = new Set();
  for (const imageValue of images) {
    const image = requireExactKeys(
      imageValue,
      ['artifactMediaType', 'imageDigest', 'imageManifestMediaType', 'imagePushedAt', 'imageStatus'],
      `${kind} ECR image`,
    );
    const imageDigest = parseImageDigest(image['imageDigest'], `${kind} ECR image digest`);
    if (seenImageDigests.has(imageDigest)) {
      blockers.push('DUPLICATE_IMAGE_DIGEST');
    }
    seenImageDigests.add(imageDigest);
    const subjectMedia =
      image['imageManifestMediaType'] === SUBJECT_MANIFEST_MEDIA_TYPE &&
      image['artifactMediaType'] === SUBJECT_ARTIFACT_MEDIA_TYPE;
    const referrerMedia =
      image['imageManifestMediaType'] === REFERRER_MANIFEST_MEDIA_TYPE &&
      image['artifactMediaType'] === REFERRER_ARTIFACT_MEDIA_TYPE;
    if (!subjectMedia && !referrerMedia) {
      blockers.push('UNKNOWN_IMAGE_MEDIA');
    }
    if (image['imageStatus'] !== 'ACTIVE') {
      blockers.push('UNKNOWN_IMAGE_STATUS');
    }
    parsedImages.push({
      artifactMediaType: image['artifactMediaType'],
      imageDigest,
      imageManifestMediaType: image['imageManifestMediaType'],
      imagePushedAt: parseCanonicalTimestamp(image['imagePushedAt'], `${kind} ECR image pushed time`),
      imageStatus: image['imageStatus'],
      kind: subjectMedia ? 'subject' : referrerMedia ? 'referrer' : 'unknown',
    });
  }
  parsedImages.sort((left, right) => left.imageDigest.localeCompare(right.imageDigest));
  const protectedValues = requireDenseArray(repository['protectedDigests'], `${kind} protected ECR subject digests`);
  const protectedDigests = protectedValues.map((digest) =>
    parseImageDigest(digest, `${kind} protected subject digest`),
  );
  protectedDigests.sort();
  if (new Set(protectedDigests).size !== protectedDigests.length) {
    blockers.push('DUPLICATE_PROTECTED_DIGEST');
  }
  const subjectDigests = new Set(
    parsedImages.filter((image) => image.kind === 'subject').map((image) => image.imageDigest),
  );
  if (protectedDigests.some((digest) => !subjectDigests.has(digest))) {
    blockers.push('PROTECTED_SUBJECT_MISSING');
  }
  const referrerObservations = requireDenseArray(repository['referrers'], `${kind} ECR referrer observations`);
  /** @type {ParsedEcrRetentionSubjectReferrers[]} */
  const parsedReferrers = [];
  const observedSubjectDigests = new Set();
  const listedReferrerDigests = new Set();
  for (const observationValue of referrerObservations) {
    const observation = requireExactKeys(
      observationValue,
      ['paginationComplete', 'referrers', 'subjectDigest'],
      `${kind} ECR subject referrers`,
    );
    const subjectDigest = parseImageDigest(observation['subjectDigest'], `${kind} ECR referrer subject digest`);
    if (observedSubjectDigests.has(subjectDigest) || !subjectDigests.has(subjectDigest)) {
      blockers.push('REFERRER_COVERAGE_INCOMPLETE');
    }
    observedSubjectDigests.add(subjectDigest);
    if (observation['paginationComplete'] !== true) {
      blockers.push('INCOMPLETE_REFERRER_PAGINATION');
    }
    /** @type {ParsedEcrRetentionReferrer[]} */
    const referrers = requireDenseArray(observation['referrers'], `${kind} ECR subject referrer list`).map(
      (referrerValue) => {
        const referrer = requireExactKeys(
          referrerValue,
          ['artifactDigest', 'artifactStatus', 'artifactType', 'mediaType'],
          `${kind} ECR image referrer`,
        );
        const artifactDigest = parseImageDigest(referrer['artifactDigest'], `${kind} ECR referrer digest`);
        if (listedReferrerDigests.has(artifactDigest)) {
          blockers.push('DUPLICATE_REFERRER_DIGEST');
        }
        listedReferrerDigests.add(artifactDigest);
        if (
          referrer['artifactType'] !== REFERRER_ARTIFACT_MEDIA_TYPE ||
          referrer['mediaType'] !== REFERRER_MANIFEST_MEDIA_TYPE
        ) {
          blockers.push('UNKNOWN_REFERRER_MEDIA');
        }
        if (referrer['artifactStatus'] !== 'ACTIVE') {
          blockers.push('UNKNOWN_REFERRER_STATUS');
        }
        return {
          artifactDigest,
          artifactStatus: referrer['artifactStatus'],
          artifactType: referrer['artifactType'],
          mediaType: referrer['mediaType'],
        };
      },
    );
    referrers.sort((left, right) => left.artifactDigest.localeCompare(right.artifactDigest));
    parsedReferrers.push({
      paginationComplete: observation['paginationComplete'] === true,
      referrers,
      subjectDigest,
    });
  }
  parsedReferrers.sort((left, right) => left.subjectDigest.localeCompare(right.subjectDigest));
  if (
    observedSubjectDigests.size !== subjectDigests.size ||
    [...subjectDigests].some((digest) => !observedSubjectDigests.has(digest))
  ) {
    blockers.push('REFERRER_COVERAGE_INCOMPLETE');
  }
  const inventoryReferrerDigests = new Set(
    parsedImages.filter((image) => image.kind === 'referrer').map((image) => image.imageDigest),
  );
  if (
    inventoryReferrerDigests.size !== listedReferrerDigests.size ||
    [...inventoryReferrerDigests].some((digest) => !listedReferrerDigests.has(digest)) ||
    [...listedReferrerDigests].some((digest) => !inventoryReferrerDigests.has(digest))
  ) {
    blockers.push('REFERRER_INVENTORY_MISMATCH');
  }
  return {
    blockers,
    images: parsedImages,
    paginationComplete: repository['paginationComplete'] === true,
    protectedDigests,
    referrers: parsedReferrers,
    repositoryName,
  };
}

/**
 * @param {ParsedEcrRetentionRepository} repository
 * @param {number} targetSubjectCount
 * @returns {EcrRetentionRepositoryPlan}
 */
function emptyRepositoryPlan(repository, targetSubjectCount) {
  const subjects = repository.images.filter((image) => image.kind === 'subject');
  return {
    repositoryName: repository.repositoryName,
    subjectCount: subjects.length,
    protectedSubjectCount: repository.protectedDigests.length,
    protectedSubjectDigests: repository.protectedDigests,
    targetSubjectCount,
    retainedSubjectCount: subjects.length,
    deleteReferrerDigests: [],
    deleteSubjectDigests: [],
  };
}

/**
 * @param {ParsedEcrRetentionRepository} repository
 * @param {number} targetSubjectCount
 * @returns {EcrRetentionRepositoryPlan}
 */
function repositoryPlan(repository, targetSubjectCount) {
  const protectedDigests = new Set(repository.protectedDigests);
  const subjects = repository.images
    .filter((image) => image.kind === 'subject')
    .sort((left, right) => {
      const pushedComparison = left.imagePushedAt.localeCompare(right.imagePushedAt);
      return pushedComparison === 0 ? left.imageDigest.localeCompare(right.imageDigest) : pushedComparison;
    });
  const desiredRetainedCount = Math.max(targetSubjectCount, protectedDigests.size);
  const deleteCount = Math.min(MAX_DELETE_BATCH_SIZE, Math.max(0, subjects.length - desiredRetainedCount));
  const deleteSubjectDigests = subjects
    .filter((image) => !protectedDigests.has(image.imageDigest))
    .slice(0, deleteCount)
    .map((image) => image.imageDigest);
  const selectedSubjects = new Set(deleteSubjectDigests);
  const deleteReferrerDigests = repository.referrers
    .filter((observation) => selectedSubjects.has(observation.subjectDigest))
    .flatMap((observation) => observation.referrers.map((referrer) => referrer.artifactDigest));
  return {
    repositoryName: repository.repositoryName,
    subjectCount: subjects.length,
    protectedSubjectCount: protectedDigests.size,
    protectedSubjectDigests: repository.protectedDigests,
    targetSubjectCount,
    retainedSubjectCount: subjects.length - deleteSubjectDigests.length,
    deleteReferrerDigests,
    deleteSubjectDigests,
  };
}

/**
 * @param {unknown} value
 * @returns {EcrSubjectRetentionPlan}
 */
export function planEcrSubjectRetention(value) {
  const input = requireExactKeys(value, ['environmentId', 'repositories'], 'ECR subject retention input');
  const environmentId = input['environmentId'];
  if (environmentId !== 'develop' && environmentId !== 'main') {
    throw new Error('ECR subject retention environment is invalid.');
  }
  const repositories = requireExactKeys(input['repositories'], ['prover', 'toolchain'], 'ECR repositories');
  const normalized = {
    environmentId,
    repositories: {
      prover: parseRepositorySnapshot(repositories['prover'], 'prover'),
      toolchain: parseRepositorySnapshot(repositories['toolchain'], 'toolchain'),
    },
  };
  const blockers = [
    ...new Set([...normalized.repositories.prover.blockers, ...normalized.repositories.toolchain.blockers]),
  ].sort();
  const targetSubjectCount = ECR_SUBJECT_RETENTION_COUNTS[environmentId];
  const snapshotSha256 = canonicalJsonSha256({
    environmentId,
    repositories: {
      prover: {
        images: normalized.repositories.prover.images,
        paginationComplete: normalized.repositories.prover.paginationComplete,
        protectedDigests: normalized.repositories.prover.protectedDigests,
        referrers: normalized.repositories.prover.referrers,
        repositoryName: normalized.repositories.prover.repositoryName,
      },
      toolchain: {
        images: normalized.repositories.toolchain.images,
        paginationComplete: normalized.repositories.toolchain.paginationComplete,
        protectedDigests: normalized.repositories.toolchain.protectedDigests,
        referrers: normalized.repositories.toolchain.referrers,
        repositoryName: normalized.repositories.toolchain.repositoryName,
      },
    },
  });
  const plannedRepositories =
    blockers.length === 0
      ? {
          prover: repositoryPlan(normalized.repositories.prover, targetSubjectCount),
          toolchain: repositoryPlan(normalized.repositories.toolchain, targetSubjectCount),
        }
      : {
          prover: emptyRepositoryPlan(normalized.repositories.prover, targetSubjectCount),
          toolchain: emptyRepositoryPlan(normalized.repositories.toolchain, targetSubjectCount),
        };
  const hasDeletes =
    plannedRepositories.prover.deleteSubjectDigests.length > 0 ||
    plannedRepositories.toolchain.deleteSubjectDigests.length > 0;
  return deepFreeze({
    disposition: blockers.length > 0 ? 'blocked' : hasDeletes ? 'delete' : 'no-change',
    blockers,
    environmentId,
    snapshotSha256,
    repositories: plannedRepositories,
  });
}
