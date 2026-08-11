import { describe, expect, it } from 'vitest';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import {
  ECR_SUBJECT_RETENTION_COUNTS,
  planEcrSubjectRetention,
  validateProverReleaseRecord,
  validateToolchainArtifactRecord,
} from './ecr-retention.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
const PIPELINE_EXECUTION_ID = '11111111-2222-3333-4444-555555555555';
const CANDIDATE_EXECUTION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TOOLCHAIN_DIGEST = `sha256:${'1'.repeat(64)}`;
const PROVER_DIGEST = `sha256:${'2'.repeat(64)}`;
const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';

function imageUri(repository: string, digest: string): string {
  return `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${repository}@${digest}`;
}

function approvals(kind: 'prover' | 'toolchain') {
  const buildExecutionId = kind === 'prover' ? PIPELINE_EXECUTION_ID : CANDIDATE_EXECUTION_ID;
  return {
    buildApprovalEvidenceId: `${kind}-build/${buildExecutionId}`,
    promotionApprovalEvidenceId: `${kind}-promotion/${PIPELINE_EXECUTION_ID}`,
  };
}

function toolchainRecord() {
  return {
    recordType: 'toolchain-artifact',
    pipelineExecutionId: PIPELINE_EXECUTION_ID,
    sourceSha: 'a'.repeat(40),
    candidateExecutionId: `toolchain-candidate/${CANDIDATE_EXECUTION_ID}`,
    candidateMetadataSha256: 'b'.repeat(64),
    imageUri: imageUri(foundation.names.toolchainRepository, TOOLCHAIN_DIGEST),
    imageTag: `source-${'a'.repeat(40)}`,
    imageDigest: TOOLCHAIN_DIGEST,
    risc0Version: '3.0.3',
    rustVersion: '1.93.1',
    rustToolchainTag: '1.93.1',
    scanStatus: 'PASS',
    criticalHighCount: 0,
    approvals: approvals('toolchain'),
  };
}

function proverRecord() {
  const expectedImageId = `0x${'3'.repeat(64)}`;
  return {
    recordType: 'prover-release',
    pipelineExecutionId: PIPELINE_EXECUTION_ID,
    sourceSha: 'a'.repeat(40),
    candidateExecutionId: `prover-candidate/${PIPELINE_EXECUTION_ID}`,
    candidateMetadataSha256: 'c'.repeat(64),
    failureMarkerContractSha256: 'd'.repeat(64),
    failureMarkerSmokeStatus: 'PASS',
    selectedToolchain: {
      artifactRecordKey: `${foundation.names.toolchainArtifactPrefix}/${PIPELINE_EXECUTION_ID}/manifest.json`,
      artifactRecordVersionId: 'toolchain-version-1',
      artifactRecordSha256: 'e'.repeat(64),
      imageUri: imageUri(foundation.names.toolchainRepository, TOOLCHAIN_DIGEST),
    },
    imageUri: imageUri(foundation.names.proverRepository, PROVER_DIGEST),
    expectedImageId,
    zkvmContractHash: 'f'.repeat(64),
    methodVersion: 1,
    imageIdVariant: 'default',
    scanStatus: 'PASS',
    approvals: approvals('prover'),
    evidence: {
      prePushImageId: expectedImageId,
      postPushImageId: expectedImageId,
      methodVersionEvidenceId: 'prover-method-version/1',
    },
  };
}

function subject(index: number) {
  return {
    artifactMediaType: SUBJECT_ARTIFACT_MEDIA_TYPE,
    imageDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
    imageManifestMediaType: SUBJECT_MANIFEST_MEDIA_TYPE,
    imagePushedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    imageStatus: 'ACTIVE',
  };
}

function signature(index: number) {
  return {
    artifactMediaType: REFERRER_ARTIFACT_MEDIA_TYPE,
    imageDigest: `sha256:${(index + 100).toString(16).padStart(64, '0')}`,
    imageManifestMediaType: REFERRER_MANIFEST_MEDIA_TYPE,
    imagePushedAt: new Date(Date.UTC(2026, 1, index + 1)).toISOString(),
    imageStatus: 'ACTIVE',
  };
}

function referrer(digest: string) {
  return {
    artifactDigest: digest,
    artifactStatus: 'ACTIVE',
    artifactType: REFERRER_ARTIFACT_MEDIA_TYPE,
    mediaType: REFERRER_MANIFEST_MEDIA_TYPE,
  };
}

function repository(kind: 'prover' | 'toolchain', subjectCount = 12) {
  const subjects = Array.from({ length: subjectCount }, (_, index) => subject(index));
  const signatureImage = signature(0);
  return {
    images: [...subjects, signatureImage],
    paginationComplete: true,
    protectedDigests: [subjects[0]?.imageDigest ?? '', subjects.at(-1)?.imageDigest ?? ''],
    referrers: subjects.map((image, index) => ({
      paginationComplete: true,
      referrers: index === 1 ? [referrer(signatureImage.imageDigest)] : [],
      subjectDigest: image.imageDigest,
    })),
    repositoryName: kind === 'toolchain' ? foundation.names.toolchainRepository : foundation.names.proverRepository,
  };
}

function input() {
  return {
    environmentId: 'develop',
    repositories: {
      prover: repository('prover'),
      toolchain: repository('toolchain'),
    },
  };
}

describe('current release record validation', () => {
  it('admits the exact current Toolchain and Prover records and returns their subject digests', () => {
    const toolchain = validateToolchainArtifactRecord(toolchainRecord(), {
      accountId: target.accountId,
      partition: 'aws',
      region: target.region,
      repository: foundation.names.toolchainRepository,
    });
    const prover = validateProverReleaseRecord(proverRecord(), {
      prover: {
        accountId: target.accountId,
        partition: 'aws',
        region: target.region,
        repository: foundation.names.proverRepository,
      },
      toolchain: {
        accountId: target.accountId,
        partition: 'aws',
        region: target.region,
        repository: foundation.names.toolchainRepository,
      },
    });

    expect(toolchain.imageDigest).toBe(TOOLCHAIN_DIGEST);
    expect(prover.imageDigest).toBe(PROVER_DIGEST);
    expect(prover.selectedToolchain.imageDigest).toBe(TOOLCHAIN_DIGEST);
    expect(Object.isFrozen(toolchain)).toBe(true);
    expect(Object.isFrozen(prover)).toBe(true);
  });

  it.each([
    ['an extra Toolchain field', { ...toolchainRecord(), legacyDigest: TOOLCHAIN_DIGEST }],
    ['a detached Toolchain digest', { ...toolchainRecord(), imageDigest: `sha256:${'9'.repeat(64)}` }],
    [
      'a Prover record without scan evidence',
      Object.fromEntries(Object.entries(proverRecord()).filter(([key]) => key !== 'scanStatus')),
    ],
    [
      'a Prover record with mismatched ImageID evidence',
      { ...proverRecord(), evidence: { ...proverRecord().evidence, postPushImageId: `0x${'4'.repeat(64)}` } },
    ],
  ])('rejects %s', (_label, record) => {
    expect(() =>
      record['recordType'] === 'toolchain-artifact'
        ? validateToolchainArtifactRecord(record, {
            accountId: target.accountId,
            partition: 'aws',
            region: target.region,
            repository: foundation.names.toolchainRepository,
          })
        : validateProverReleaseRecord(record, {
            prover: {
              accountId: target.accountId,
              partition: 'aws',
              region: target.region,
              repository: foundation.names.proverRepository,
            },
            toolchain: {
              accountId: target.accountId,
              partition: 'aws',
              region: target.region,
              repository: foundation.names.toolchainRepository,
            },
          }),
    ).toThrow();
  });
});

describe('ECR subject retention planning', () => {
  it('keeps a static count of ten in develop and main and deletes the oldest unprotected subjects only', () => {
    expect(ECR_SUBJECT_RETENTION_COUNTS).toEqual({ develop: 10, main: 10 });

    const plan = planEcrSubjectRetention(input());

    expect(plan.disposition).toBe('delete');
    expect(plan.blockers).toEqual([]);
    expect(plan.repositories.toolchain).toMatchObject({
      subjectCount: 12,
      protectedSubjectCount: 2,
      targetSubjectCount: 10,
      deleteSubjectDigests: [subject(1).imageDigest, subject(2).imageDigest],
      deleteReferrerDigests: [signature(0).imageDigest],
    });
    expect(plan.repositories.prover.deleteSubjectDigests).toEqual([subject(1).imageDigest, subject(2).imageDigest]);
    expect(plan.repositories.prover.deleteReferrerDigests).toEqual([signature(0).imageDigest]);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('lets protected references win when more than ten subjects are protected', () => {
    const value = input();
    const toolchainSubjects = value.repositories.toolchain.images.filter(
      (image) => image.artifactMediaType === SUBJECT_ARTIFACT_MEDIA_TYPE,
    );
    value.repositories.toolchain.protectedDigests = toolchainSubjects.map((image) => image.imageDigest);

    const plan = planEcrSubjectRetention(value);

    expect(plan.repositories.toolchain.deleteSubjectDigests).toEqual([]);
    expect(plan.repositories.toolchain.deleteReferrerDigests).toEqual([]);
    expect(plan.repositories.toolchain.retainedSubjectCount).toBe(12);
  });

  it.each([
    [
      'an incomplete image page sequence',
      (value: ReturnType<typeof input>) => {
        value.repositories.prover.paginationComplete = false;
      },
      'INCOMPLETE_IMAGE_PAGINATION',
    ],
    [
      'an unknown media pair',
      (value: ReturnType<typeof input>) => {
        const first = value.repositories.toolchain.images[0];
        if (first) first.artifactMediaType = 'application/vnd.example.unknown';
      },
      'UNKNOWN_IMAGE_MEDIA',
    ],
    [
      'a protected digest missing from inventory',
      (value: ReturnType<typeof input>) => {
        value.repositories.toolchain.protectedDigests.push(`sha256:${'9'.repeat(64)}`);
      },
      'PROTECTED_SUBJECT_MISSING',
    ],
    [
      'an incomplete referrer page sequence',
      (value: ReturnType<typeof input>) => {
        const observation = value.repositories.prover.referrers[0];
        if (observation) observation.paginationComplete = false;
      },
      'INCOMPLETE_REFERRER_PAGINATION',
    ],
    [
      'missing per-subject referrer coverage',
      (value: ReturnType<typeof input>) => {
        value.repositories.prover.referrers.pop();
      },
      'REFERRER_COVERAGE_INCOMPLETE',
    ],
    [
      'a referrer that is not present in the repository inventory',
      (value: ReturnType<typeof input>) => {
        const observation = value.repositories.prover.referrers[1];
        if (observation) observation.referrers[0] = referrer(`sha256:${'8'.repeat(64)}`);
      },
      'REFERRER_INVENTORY_MISMATCH',
    ],
  ])('returns zero deletes for %s', (_label, mutate, blocker) => {
    const value = input();
    mutate(value);

    const plan = planEcrSubjectRetention(value);

    expect(plan.disposition).toBe('blocked');
    expect(plan.blockers).toContain(blocker);
    expect(plan.repositories.toolchain.deleteSubjectDigests).toEqual([]);
    expect(plan.repositories.toolchain.deleteReferrerDigests).toEqual([]);
    expect(plan.repositories.prover.deleteSubjectDigests).toEqual([]);
    expect(plan.repositories.prover.deleteReferrerDigests).toEqual([]);
  });
});
