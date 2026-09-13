import { describe, expect, it, vi } from 'vitest';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from '@stark-ballot/deployment-authority';
import { createEcrRetentionHandler, type EcrRetentionDependencies } from './handler.js';

const productionConfiguration = await vi.hoisted(async () => {
  const { productionConfigurationFixture } =
    await import('../../../packages/deployment-authority/src/test-support/deployment-target-fixtures.js');
  return productionConfigurationFixture().configuration;
});
vi.mock('../../../packages/deployment-authority/deployment-targets.json', () => ({ default: productionConfiguration }));
describe.each(['stark-dev/develop', 'stark-prod/main'])('ECR retention target %s', (targetKey) => {
  const target = resolveAllowedDeploymentTarget(targetKey);
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const SUBJECT_MANIFEST_MEDIA_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
  const SUBJECT_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.container.image.v1+json';
  const REFERRER_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
  const REFERRER_ARTIFACT_MEDIA_TYPE = 'application/vnd.cncf.notary.signature';
  const EXPECTED_SCHEDULE_ARN =
    `arn:aws:events:${target.region}:${target.accountId}:rule/` + foundation.names.ecrRetentionSchedule;

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

  function repository(kind: 'prover' | 'toolchain', count = 12) {
    const subjects = Array.from({ length: count }, (_, index) => subject(index));
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

  function observation() {
    return {
      authoritySnapshotSha256: 'a'.repeat(64),
      repositories: {
        prover: repository('prover'),
        toolchain: repository('toolchain'),
      },
    };
  }

  function event() {
    return {
      'detail-type': 'Scheduled Event',
      source: 'aws.events',
      resources: [EXPECTED_SCHEDULE_ARN],
    };
  }

  function config() {
    return {
      expectedAccountId: target.accountId,
      expectedRegion: target.region,
      expectedScheduleArn: EXPECTED_SCHEDULE_ARN,
      retainedSubjectCount: 10,
      targetKey: target.targetKey,
      repositories: {
        prover: foundation.names.proverRepository,
        toolchain: foundation.names.toolchainRepository,
      },
    };
  }

  function dependencies(firstObservation = observation()): EcrRetentionDependencies & {
    deleteImages: ReturnType<typeof vi.fn<EcrRetentionDependencies['deleteImages']>>;
    observe: ReturnType<typeof vi.fn<EcrRetentionDependencies['observe']>>;
    observeActivity: ReturnType<typeof vi.fn<EcrRetentionDependencies['observeActivity']>>;
    observeAuthoritySnapshotSha256: ReturnType<
      typeof vi.fn<EcrRetentionDependencies['observeAuthoritySnapshotSha256']>
    >;
    readImagePresence: ReturnType<typeof vi.fn<EcrRetentionDependencies['readImagePresence']>>;
  } {
    return {
      getCallerAccountId: vi.fn(() => Promise.resolve(target.accountId)),
      observe: vi.fn(() => Promise.resolve(structuredClone(firstObservation))),
      observeActivity: vi.fn(() =>
        Promise.resolve({
          codeBuild: false,
          codePipeline: false,
          ecs: false,
          stepFunctions: false,
        }),
      ),
      observeAuthoritySnapshotSha256: vi.fn(() => Promise.resolve('a'.repeat(64))),
      deleteImages: vi.fn(({ imageDigests }) =>
        Promise.resolve({
          deletedImageDigests: [...imageDigests],
          failures: [],
        }),
      ),
      readImagePresence: vi.fn(() =>
        Promise.resolve({
          existingExpectedAbsentDigests: [],
          missingExpectedPresentDigests: [],
        }),
      ),
    };
  }

  describe('ECR retention handler', () => {
    it.each(['codeBuild', 'codePipeline', 'ecs', 'stepFunctions'] as const)(
      'returns a successful no-delete result while %s activity exists',
      async (activity) => {
        const aws = dependencies();
        aws.observeActivity.mockResolvedValueOnce({
          codeBuild: activity === 'codeBuild',
          codePipeline: activity === 'codePipeline',
          ecs: activity === 'ecs',
          stepFunctions: activity === 'stepFunctions',
        });

        const result = await createEcrRetentionHandler(aws, config())(event());

        expect(result).toMatchObject({
          disposition: 'skipped-active',
          blockers: [],
          activity: { [activity]: true },
        });
        expect(aws.observeActivity).toHaveBeenCalledTimes(1);
        expect(aws.observe).not.toHaveBeenCalled();
        expect(aws.deleteImages).not.toHaveBeenCalled();
      },
    );

    it('requires two identical snapshots, deletes referrers before subjects, and verifies both', async () => {
      const aws = dependencies();

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('deleted');
      expect(aws.observe).toHaveBeenCalledTimes(2);
      expect(aws.observeActivity).toHaveBeenCalledTimes(7);
      expect(aws.observeAuthoritySnapshotSha256).toHaveBeenCalledTimes(4);
      expect(aws.deleteImages).toHaveBeenCalledTimes(4);
      expect(aws.deleteImages).toHaveBeenNthCalledWith(1, {
        imageDigests: [signature(0).imageDigest],
        imageKind: 'referrer',
        repositoryKind: 'prover',
        repositoryName: foundation.names.proverRepository,
      });
      expect(aws.deleteImages).toHaveBeenNthCalledWith(2, {
        imageDigests: [subject(1).imageDigest, subject(2).imageDigest],
        imageKind: 'subject',
        repositoryKind: 'prover',
        repositoryName: foundation.names.proverRepository,
      });
      expect(aws.deleteImages).toHaveBeenNthCalledWith(3, {
        imageDigests: [signature(0).imageDigest],
        imageKind: 'referrer',
        repositoryKind: 'toolchain',
        repositoryName: foundation.names.toolchainRepository,
      });
      expect(aws.deleteImages).toHaveBeenNthCalledWith(4, {
        imageDigests: [subject(1).imageDigest, subject(2).imageDigest],
        imageKind: 'subject',
        repositoryKind: 'toolchain',
        repositoryName: foundation.names.toolchainRepository,
      });
      expect(aws.readImagePresence).toHaveBeenCalledTimes(4);
      expect(result.repositories.prover.deletedSubjectDigests).toEqual([
        subject(1).imageDigest,
        subject(2).imageDigest,
      ]);
      expect(result.repositories.prover.deletedReferrerDigests).toEqual([signature(0).imageDigest]);
      expect(result.repositories.toolchain.deletedSubjectDigests).toEqual([
        subject(1).imageDigest,
        subject(2).imageDigest,
      ]);
    });

    it('returns a successful no-delete result when either second snapshot changes', async () => {
      const first = observation();
      const second = observation();
      second.authoritySnapshotSha256 = 'b'.repeat(64);
      const aws = dependencies(first);
      aws.observe.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('skipped-changed');
      expect(result.blockers).toEqual([]);
      expect(aws.deleteImages).not.toHaveBeenCalled();
    });

    it('rechecks activity immediately before deletion and succeeds without mutation when work starts', async () => {
      const aws = dependencies();
      aws.observeActivity
        .mockResolvedValueOnce({ codeBuild: false, codePipeline: false, ecs: false, stepFunctions: false })
        .mockResolvedValueOnce({ codeBuild: false, codePipeline: false, ecs: false, stepFunctions: false })
        .mockResolvedValueOnce({ codeBuild: false, codePipeline: true, ecs: false, stepFunctions: false });

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('skipped-active');
      expect(result.activity.codePipeline).toBe(true);
      expect(aws.observe).toHaveBeenCalledTimes(2);
      expect(aws.deleteImages).not.toHaveBeenCalled();
    });

    it('observes activity after authority revalidation so work starting during that read blocks deletion', async () => {
      const aws = dependencies();
      let authorityReadCompleted = false;
      aws.observeAuthoritySnapshotSha256.mockImplementation(() => {
        authorityReadCompleted = true;
        return Promise.resolve('a'.repeat(64));
      });
      aws.observeActivity.mockImplementation(() =>
        Promise.resolve({
          codeBuild: false,
          codePipeline: authorityReadCompleted,
          ecs: false,
          stepFunctions: false,
        }),
      );

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('skipped-active');
      expect(result.activity.codePipeline).toBe(true);
      expect(aws.deleteImages).not.toHaveBeenCalled();
      expect(aws.observeAuthoritySnapshotSha256.mock.invocationCallOrder[0]).toBeLessThan(
        aws.observeActivity.mock.invocationCallOrder[3] ?? 0,
      );
    });

    it('revalidates authority immediately before each mutation and stops before an unreviewed first delete', async () => {
      const aws = dependencies();
      aws.observeAuthoritySnapshotSha256.mockResolvedValueOnce('b'.repeat(64));

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('skipped-changed');
      expect(aws.deleteImages).not.toHaveBeenCalled();
    });

    it('returns retryable bounded evidence when authority changes after a partial referrer mutation', async () => {
      const current = observation();
      const extraSignatures = Array.from({ length: 101 }, (_, index) => signature(index + 10));
      current.repositories.prover.images = [
        ...current.repositories.prover.images.filter(
          (image) => image.artifactMediaType === SUBJECT_ARTIFACT_MEDIA_TYPE,
        ),
        ...extraSignatures,
      ];
      const subjectReferrers = current.repositories.prover.referrers[1];
      if (!subjectReferrers) throw new Error('fixture must include a deletable subject');
      subjectReferrers.referrers = extraSignatures.map((image) => referrer(image.imageDigest));
      const aws = dependencies(current);
      aws.observeAuthoritySnapshotSha256.mockResolvedValueOnce('a'.repeat(64)).mockResolvedValueOnce('b'.repeat(64));

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('delete-unverified');
      expect(result.blockers).toEqual(['MUTATION_REVALIDATION_CHANGED']);
      expect(aws.deleteImages).toHaveBeenCalledTimes(1);
      expect(aws.deleteImages.mock.calls[0]?.[0].imageDigests).toHaveLength(100);
    });

    it('does not take a second snapshot when both repositories are already within policy', async () => {
      const current = observation();
      current.repositories.prover = repository('prover', 10);
      current.repositories.toolchain = repository('toolchain', 10);
      const aws = dependencies(current);

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('no-change');
      expect(aws.observe).toHaveBeenCalledTimes(1);
      expect(aws.deleteImages).not.toHaveBeenCalled();
    });

    it('fails closed without deletion when observation or pagination fails', async () => {
      const incomplete = observation();
      incomplete.repositories.prover.paginationComplete = false;
      const incompleteAws = dependencies(incomplete);
      const failedAws = dependencies();
      failedAws.observe.mockRejectedValueOnce(new Error('credential and secret detail must not escape'));

      const incompleteResult = await createEcrRetentionHandler(incompleteAws, config())(event());
      const failedResult = await createEcrRetentionHandler(failedAws, config())(event());

      expect(incompleteResult).toMatchObject({
        disposition: 'blocked',
        blockers: ['INCOMPLETE_IMAGE_PAGINATION'],
      });
      expect(failedResult).toMatchObject({ disposition: 'blocked', blockers: ['OBSERVATION_FAILED'] });
      expect(JSON.stringify(failedResult)).not.toContain('credential');
      expect(incompleteAws.deleteImages).not.toHaveBeenCalled();
      expect(failedAws.deleteImages).not.toHaveBeenCalled();
    });

    it('checks every BatchDeleteImage result item and stops post-readback after a per-item failure', async () => {
      const aws = dependencies();
      aws.deleteImages.mockResolvedValueOnce({
        deletedImageDigests: [],
        failures: [{ failureCode: 'ImageReferencedByManifestList', imageDigest: signature(0).imageDigest }],
      });

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('delete-failed');
      expect(result.blockers).toEqual(['BATCH_DELETE_FAILED']);
      expect(result.repositories.prover.deletedReferrerDigests).toEqual([]);
      expect(aws.deleteImages).toHaveBeenCalledTimes(1);
      expect(aws.readImagePresence).not.toHaveBeenCalled();
    });

    it('requires post-delete readback to prove targets absent and protected subjects present', async () => {
      const aws = dependencies();
      aws.readImagePresence.mockResolvedValueOnce({
        existingExpectedAbsentDigests: [signature(0).imageDigest],
        missingExpectedPresentDigests: [],
      });

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('delete-unverified');
      expect(result.blockers).toEqual(['POST_DELETE_TARGET_PRESENT']);
      expect(aws.deleteImages).toHaveBeenCalledTimes(1);
    });

    it('blocks before observation when account identity or schedule authority mismatches', async () => {
      const wrongAccount = dependencies();
      vi.mocked(wrongAccount.getCallerAccountId).mockResolvedValueOnce('999999999999');
      const wrongEvent = { ...event(), resources: [`${EXPECTED_SCHEDULE_ARN}-other`] };
      const wrongSchedule = dependencies();

      const identityResult = await createEcrRetentionHandler(wrongAccount, config())(event());
      const scheduleResult = await createEcrRetentionHandler(wrongSchedule, config())(wrongEvent);

      expect(identityResult).toMatchObject({ disposition: 'blocked', blockers: ['CALLER_IDENTITY_MISMATCH'] });
      expect(scheduleResult).toMatchObject({ disposition: 'blocked', blockers: ['INVOCATION_AUTHORITY_MISMATCH'] });
      expect(wrongAccount.observe).not.toHaveBeenCalled();
      expect(wrongSchedule.observe).not.toHaveBeenCalled();
    });

    it('chunks referrer deletion at 100 and proves referrers absent before deleting their subject', async () => {
      const current = observation();
      const extraSignatures = Array.from({ length: 101 }, (_, index) => signature(index + 10));
      current.repositories.prover.images = [
        ...current.repositories.prover.images.filter(
          (image) => image.artifactMediaType === SUBJECT_ARTIFACT_MEDIA_TYPE,
        ),
        ...extraSignatures,
      ];
      const subjectReferrers = current.repositories.prover.referrers[1];
      if (!subjectReferrers) throw new Error('fixture must include a deletable subject');
      subjectReferrers.referrers = extraSignatures.map((image) => referrer(image.imageDigest));
      const aws = dependencies(current);

      const result = await createEcrRetentionHandler(aws, config())(event());

      expect(result.disposition).toBe('deleted');
      expect(aws.deleteImages.mock.calls.slice(0, 3).map(([request]) => request.imageDigests.length)).toEqual([
        100, 1, 2,
      ]);
      expect(aws.deleteImages.mock.calls[0]?.[0].imageKind).toBe('referrer');
      expect(aws.deleteImages.mock.calls[1]?.[0].imageKind).toBe('referrer');
      expect(aws.deleteImages.mock.calls[2]?.[0].imageKind).toBe('subject');
      expect(aws.readImagePresence.mock.invocationCallOrder[0]).toBeLessThan(
        aws.deleteImages.mock.invocationCallOrder[2] ?? 0,
      );
    });

    it('rejects another target and altered retention runtime configuration', () => {
      expect(() =>
        createEcrRetentionHandler(dependencies(), {
          ...config(),
          targetKey: targetKey === 'stark-dev/develop' ? 'stark-prod/main' : 'stark-dev/develop',
        }),
      ).toThrow('reviewed target authority');
      expect(() => createEcrRetentionHandler(dependencies(), { ...config(), retainedSubjectCount: 11 })).toThrow(
        'retainedSubjectCount',
      );
    });

    it('rejects an unrelated schedule in the same account and region before AWS access', () => {
      const aws = dependencies();
      expect(() =>
        createEcrRetentionHandler(aws, {
          ...config(),
          expectedScheduleArn: `arn:aws:events:${target.region}:${target.accountId}:rule/unrelated`,
        }),
      ).toThrow('reviewed target authority');
      expect(aws.observe).not.toHaveBeenCalled();
      expect(aws.deleteImages).not.toHaveBeenCalled();
    });
  });
});
