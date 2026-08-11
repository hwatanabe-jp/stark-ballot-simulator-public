import {
  canonicalJsonSha256,
  deepFreeze,
  parseDigestPinnedImageReference,
  parseGitCommitSha,
  parseImageDigest,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireString,
} from './internal.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,511}$/u;
const IMAGE_ID_PATTERN = /^0x[0-9a-f]{64}$/u;
const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';
const MAX_DELETE_BATCH_SIZE = 100;

const TOOLCHAIN_RECORD_KEYS = [
  'approvals',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'criticalHighCount',
  'imageDigest',
  'imageTag',
  'imageUri',
  'pipelineExecutionId',
  'recordType',
  'risc0Version',
  'rustToolchainTag',
  'rustVersion',
  'scanStatus',
  'sourceSha',
];
const PROVER_RECORD_KEYS = [
  'approvals',
  'candidateExecutionId',
  'candidateMetadataSha256',
  'evidence',
  'expectedImageId',
  'failureMarkerContractSha256',
  'failureMarkerSmokeStatus',
  'imageIdVariant',
  'imageUri',
  'methodVersion',
  'pipelineExecutionId',
  'recordType',
  'scanStatus',
  'selectedToolchain',
  'sourceSha',
  'zkvmContractHash',
];

export const ECR_SUBJECT_RETENTION_COUNTS = deepFreeze({ develop: 10, main: 10 });

function requireIdentifier(value, label) {
  return requireString(value, label, IDENTIFIER_PATTERN);
}

function validateApprovals(value, kind, candidateExecutionId, pipelineExecutionId) {
  const approvals = requireExactKeys(
    value,
    ['buildApprovalEvidenceId', 'promotionApprovalEvidenceId'],
    `${kind} release approvals`,
  );
  const candidatePrefix = `${kind}-candidate/`;
  const candidateBuildExecutionId = candidateExecutionId.startsWith(candidatePrefix)
    ? candidateExecutionId.slice(candidatePrefix.length)
    : '';
  if (
    candidateBuildExecutionId.length === 0 ||
    approvals.buildApprovalEvidenceId !== `${kind}-build/${candidateBuildExecutionId}` ||
    approvals.promotionApprovalEvidenceId !== `${kind}-promotion/${pipelineExecutionId}`
  ) {
    throw new Error(`${kind} release approvals are detached from the release execution.`);
  }
  return deepFreeze({
    buildApprovalEvidenceId: approvals.buildApprovalEvidenceId,
    promotionApprovalEvidenceId: approvals.promotionApprovalEvidenceId,
  });
}

export function validateToolchainArtifactRecord(value, imagePolicy) {
  const record = requireExactKeys(value, TOOLCHAIN_RECORD_KEYS, 'Toolchain artifact record');
  if (record.recordType !== 'toolchain-artifact') {
    throw new Error('Toolchain artifact record type is invalid.');
  }
  const pipelineExecutionId = requireIdentifier(record.pipelineExecutionId, 'Toolchain pipeline execution ID');
  const candidateExecutionId = requireIdentifier(record.candidateExecutionId, 'Toolchain candidate execution ID');
  const image = parseDigestPinnedImageReference(record.imageUri, imagePolicy);
  const imageDigest = parseImageDigest(record.imageDigest, 'Toolchain image digest');
  if (image.digest !== imageDigest) {
    throw new Error('Toolchain image digest is detached from its image URI.');
  }
  const scanStatus = record.scanStatus;
  const criticalHighCount = record.criticalHighCount;
  if (
    (scanStatus !== 'PASS' && scanStatus !== 'FINDINGS_PRESENT') ||
    !Number.isSafeInteger(criticalHighCount) ||
    criticalHighCount < 0 ||
    (scanStatus === 'PASS' && criticalHighCount !== 0) ||
    (scanStatus === 'FINDINGS_PRESENT' && criticalHighCount === 0)
  ) {
    throw new Error('Toolchain scan result is inconsistent.');
  }
  return deepFreeze({
    recordType: 'toolchain-artifact',
    pipelineExecutionId,
    sourceSha: parseGitCommitSha(record.sourceSha, 'Toolchain source SHA'),
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(record.candidateMetadataSha256, 'Toolchain candidate metadata SHA-256'),
    imageUri: image.imageUri,
    imageDigest,
    imageTag: requireIdentifier(record.imageTag, 'Toolchain image tag'),
    risc0Version: requireIdentifier(record.risc0Version, 'Toolchain RISC Zero version'),
    rustVersion: requireIdentifier(record.rustVersion, 'Toolchain Rust version'),
    rustToolchainTag: requireIdentifier(record.rustToolchainTag, 'Toolchain Rust tag'),
    scanStatus,
    criticalHighCount,
    approvals: validateApprovals(record.approvals, 'toolchain', candidateExecutionId, pipelineExecutionId),
  });
}

export function validateProverReleaseRecord(value, imagePolicies) {
  const record = requireExactKeys(value, PROVER_RECORD_KEYS, 'Prover release record');
  if (
    record.recordType !== 'prover-release' ||
    record.scanStatus !== 'PASS' ||
    record.failureMarkerSmokeStatus !== 'PASS' ||
    record.imageIdVariant !== 'default'
  ) {
    throw new Error('Prover release status or variant is invalid.');
  }
  const policies = requireExactKeys(imagePolicies, ['prover', 'toolchain'], 'Prover release image policies');
  const pipelineExecutionId = requireIdentifier(record.pipelineExecutionId, 'Prover pipeline execution ID');
  const candidateExecutionId = requireIdentifier(record.candidateExecutionId, 'Prover candidate execution ID');
  if (candidateExecutionId !== `prover-candidate/${pipelineExecutionId}`) {
    throw new Error('Prover candidate execution is detached from its pipeline execution.');
  }
  const proverImage = parseDigestPinnedImageReference(record.imageUri, policies.prover);
  const selectedToolchain = requireExactKeys(
    record.selectedToolchain,
    ['artifactRecordKey', 'artifactRecordSha256', 'artifactRecordVersionId', 'imageUri'],
    'Prover selected Toolchain',
  );
  const selectedToolchainReference = parseImmutableObjectReference({
    key: selectedToolchain.artifactRecordKey,
    versionId: selectedToolchain.artifactRecordVersionId,
    sha256: selectedToolchain.artifactRecordSha256,
  });
  const selectedToolchainImage = parseDigestPinnedImageReference(selectedToolchain.imageUri, policies.toolchain);
  const expectedImageId = requireString(record.expectedImageId, 'Prover expected ImageID', IMAGE_ID_PATTERN);
  const evidence = requireExactKeys(
    record.evidence,
    ['methodVersionEvidenceId', 'postPushImageId', 'prePushImageId'],
    'Prover release evidence',
  );
  const methodVersion = record.methodVersion;
  if (
    !Number.isSafeInteger(methodVersion) ||
    methodVersion < 1 ||
    evidence.prePushImageId !== expectedImageId ||
    evidence.postPushImageId !== expectedImageId ||
    evidence.methodVersionEvidenceId !== `prover-method-version/${methodVersion}`
  ) {
    throw new Error('Prover release ImageID or method evidence is invalid.');
  }
  return deepFreeze({
    recordType: 'prover-release',
    pipelineExecutionId,
    sourceSha: parseGitCommitSha(record.sourceSha, 'Prover source SHA'),
    candidateExecutionId,
    candidateMetadataSha256: parseSha256(record.candidateMetadataSha256, 'Prover candidate metadata SHA-256'),
    failureMarkerContractSha256: parseSha256(
      record.failureMarkerContractSha256,
      'Prover failure-marker contract SHA-256',
    ),
    failureMarkerSmokeStatus: 'PASS',
    selectedToolchain: {
      ...selectedToolchainReference,
      imageUri: selectedToolchainImage.imageUri,
      imageDigest: selectedToolchainImage.digest,
    },
    imageUri: proverImage.imageUri,
    imageDigest: proverImage.digest,
    expectedImageId,
    zkvmContractHash: parseSha256(record.zkvmContractHash, 'Prover zkVM contract SHA-256'),
    methodVersion,
    imageIdVariant: 'default',
    scanStatus: 'PASS',
    approvals: validateApprovals(record.approvals, 'prover', candidateExecutionId, pipelineExecutionId),
    evidence: {
      prePushImageId: expectedImageId,
      postPushImageId: expectedImageId,
      methodVersionEvidenceId: evidence.methodVersionEvidenceId,
    },
  });
}

function requireDenseArray(value, label) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new Error(`${label} must be a dense array.`);
  }
  return value;
}

function parseCanonicalTimestamp(value, label) {
  const timestamp = requireString(value, label);
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function parseRepositorySnapshot(value, kind) {
  const repository = requireExactKeys(
    value,
    ['images', 'paginationComplete', 'protectedDigests', 'referrers', 'repositoryName'],
    `${kind} ECR repository snapshot`,
  );
  const blockers = [];
  if (repository.paginationComplete !== true) {
    blockers.push('INCOMPLETE_IMAGE_PAGINATION');
  }
  const repositoryName = requireString(repository.repositoryName, `${kind} ECR repository name`);
  const images = requireDenseArray(repository.images, `${kind} ECR images`);
  const parsedImages = [];
  const seenImageDigests = new Set();
  for (const imageValue of images) {
    const image = requireExactKeys(
      imageValue,
      ['artifactMediaType', 'imageDigest', 'imageManifestMediaType', 'imagePushedAt', 'imageStatus'],
      `${kind} ECR image`,
    );
    const imageDigest = parseImageDigest(image.imageDigest, `${kind} ECR image digest`);
    if (seenImageDigests.has(imageDigest)) {
      blockers.push('DUPLICATE_IMAGE_DIGEST');
    }
    seenImageDigests.add(imageDigest);
    const subjectMedia =
      image.imageManifestMediaType === SUBJECT_MANIFEST_MEDIA_TYPE &&
      image.artifactMediaType === SUBJECT_ARTIFACT_MEDIA_TYPE;
    const referrerMedia =
      image.imageManifestMediaType === REFERRER_MANIFEST_MEDIA_TYPE &&
      image.artifactMediaType === REFERRER_ARTIFACT_MEDIA_TYPE;
    if (!subjectMedia && !referrerMedia) {
      blockers.push('UNKNOWN_IMAGE_MEDIA');
    }
    if (image.imageStatus !== 'ACTIVE') {
      blockers.push('UNKNOWN_IMAGE_STATUS');
    }
    parsedImages.push({
      artifactMediaType: image.artifactMediaType,
      imageDigest,
      imageManifestMediaType: image.imageManifestMediaType,
      imagePushedAt: parseCanonicalTimestamp(image.imagePushedAt, `${kind} ECR image pushed time`),
      imageStatus: image.imageStatus,
      kind: subjectMedia ? 'subject' : referrerMedia ? 'referrer' : 'unknown',
    });
  }
  parsedImages.sort((left, right) => left.imageDigest.localeCompare(right.imageDigest));
  const protectedValues = requireDenseArray(repository.protectedDigests, `${kind} protected ECR subject digests`);
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
  const referrerObservations = requireDenseArray(repository.referrers, `${kind} ECR referrer observations`);
  const parsedReferrers = [];
  const observedSubjectDigests = new Set();
  const listedReferrerDigests = new Set();
  for (const observationValue of referrerObservations) {
    const observation = requireExactKeys(
      observationValue,
      ['paginationComplete', 'referrers', 'subjectDigest'],
      `${kind} ECR subject referrers`,
    );
    const subjectDigest = parseImageDigest(observation.subjectDigest, `${kind} ECR referrer subject digest`);
    if (observedSubjectDigests.has(subjectDigest) || !subjectDigests.has(subjectDigest)) {
      blockers.push('REFERRER_COVERAGE_INCOMPLETE');
    }
    observedSubjectDigests.add(subjectDigest);
    if (observation.paginationComplete !== true) {
      blockers.push('INCOMPLETE_REFERRER_PAGINATION');
    }
    const referrers = requireDenseArray(observation.referrers, `${kind} ECR subject referrer list`).map(
      (referrerValue) => {
        const referrer = requireExactKeys(
          referrerValue,
          ['artifactDigest', 'artifactStatus', 'artifactType', 'mediaType'],
          `${kind} ECR image referrer`,
        );
        const artifactDigest = parseImageDigest(referrer.artifactDigest, `${kind} ECR referrer digest`);
        if (listedReferrerDigests.has(artifactDigest)) {
          blockers.push('DUPLICATE_REFERRER_DIGEST');
        }
        listedReferrerDigests.add(artifactDigest);
        if (
          referrer.artifactType !== REFERRER_ARTIFACT_MEDIA_TYPE ||
          referrer.mediaType !== REFERRER_MANIFEST_MEDIA_TYPE
        ) {
          blockers.push('UNKNOWN_REFERRER_MEDIA');
        }
        if (referrer.artifactStatus !== 'ACTIVE') {
          blockers.push('UNKNOWN_REFERRER_STATUS');
        }
        return {
          artifactDigest,
          artifactStatus: referrer.artifactStatus,
          artifactType: referrer.artifactType,
          mediaType: referrer.mediaType,
        };
      },
    );
    referrers.sort((left, right) => left.artifactDigest.localeCompare(right.artifactDigest));
    parsedReferrers.push({
      paginationComplete: observation.paginationComplete === true,
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
    paginationComplete: repository.paginationComplete === true,
    protectedDigests,
    referrers: parsedReferrers,
    repositoryName,
  };
}

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

export function planEcrSubjectRetention(value) {
  const input = requireExactKeys(value, ['environmentId', 'repositories'], 'ECR subject retention input');
  const environmentId = input.environmentId;
  if (environmentId !== 'develop' && environmentId !== 'main') {
    throw new Error('ECR subject retention environment is invalid.');
  }
  const repositories = requireExactKeys(input.repositories, ['prover', 'toolchain'], 'ECR repositories');
  const normalized = {
    environmentId,
    repositories: {
      prover: parseRepositorySnapshot(repositories.prover, 'prover'),
      toolchain: parseRepositorySnapshot(repositories.toolchain, 'toolchain'),
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
