import { describe, expect, it } from 'vitest';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { ECR_SUBJECT_RETENTION_COUNTS, planEcrSubjectRetention } from './ecr-retention.js';

const target = resolveAllowedDeploymentTarget('stark-dev/develop');
const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';

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
