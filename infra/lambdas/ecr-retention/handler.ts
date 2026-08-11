import {
  ECR_SUBJECT_RETENTION_COUNTS,
  planEcrSubjectRetention,
  type EcrRetentionRepositoryPlan,
  type EcrRetentionRepositorySnapshot,
  type EcrSubjectRetentionPlan,
} from '@stark-ballot/deployment-authority/ecr-retention';
import {
  parseImageDigest,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from '@stark-ballot/deployment-authority';

type RepositoryKind = 'prover' | 'toolchain';
type ActivityKind = 'codeBuild' | 'codePipeline' | 'ecs' | 'stepFunctions';

export interface EcrRetentionObservation {
  authoritySnapshotSha256: string;
  repositories: Readonly<Record<RepositoryKind, EcrRetentionRepositorySnapshot>>;
}

export interface EcrRetentionDeleteRequest {
  readonly repositoryKind: RepositoryKind;
  readonly repositoryName: string;
  readonly imageKind: 'referrer' | 'subject';
  readonly imageDigests: readonly string[];
}

export interface EcrRetentionPresenceRequest {
  readonly repositoryKind: RepositoryKind;
  readonly repositoryName: string;
  readonly expectedAbsentDigests: readonly string[];
  readonly expectedPresentDigests: readonly string[];
}

export interface EcrRetentionDeleteFailure {
  readonly failureCode: string;
  readonly imageDigest: string;
}

export interface EcrRetentionDeleteResult {
  readonly deletedImageDigests: readonly string[];
  readonly failures: readonly EcrRetentionDeleteFailure[];
}

export interface EcrRetentionDependencies {
  readonly getCallerAccountId: () => Promise<string>;
  readonly observeActivity: () => Promise<unknown>;
  readonly observeAuthoritySnapshotSha256: () => Promise<unknown>;
  readonly observe: () => Promise<unknown>;
  readonly deleteImages: (request: EcrRetentionDeleteRequest) => Promise<unknown>;
  readonly readImagePresence: (request: EcrRetentionPresenceRequest) => Promise<unknown>;
}

export interface EcrRetentionConfig {
  readonly expectedAccountId: string;
  readonly expectedRegion: string;
  readonly expectedScheduleArn: string;
  readonly retainedSubjectCount: number;
  readonly targetKey: 'stark-dev/develop';
  readonly repositories: Readonly<Record<RepositoryKind, string>>;
}

export type EcrRetentionDisposition =
  'blocked' | 'delete-failed' | 'delete-unverified' | 'deleted' | 'no-change' | 'skipped-active' | 'skipped-changed';

export type EcrRetentionRuntimeBlocker =
  | 'BATCH_DELETE_FAILED'
  | 'CALLER_IDENTITY_FAILED'
  | 'CALLER_IDENTITY_MISMATCH'
  | 'INVOCATION_AUTHORITY_MISMATCH'
  | 'MUTATION_REVALIDATION_CHANGED'
  | 'OBSERVATION_FAILED'
  | 'POST_DELETE_READ_FAILED'
  | 'POST_DELETE_REQUIRED_PRESENT_MISSING'
  | 'POST_DELETE_TARGET_PRESENT';

export interface EcrRetentionRepositoryEvidence {
  readonly repositoryName: string;
  readonly subjectCount: number;
  readonly protectedSubjectCount: number;
  readonly targetSubjectCount: number;
  readonly plannedReferrerDeleteCount: number;
  readonly plannedSubjectDeleteCount: number;
  readonly deletedReferrerDigests: readonly string[];
  readonly deletedSubjectDigests: readonly string[];
}

export interface EcrRetentionEvidence {
  readonly evidenceType: 'ecr-subject-retention';
  readonly targetKey: 'stark-dev/develop';
  readonly reportOnly: false;
  readonly disposition: EcrRetentionDisposition;
  readonly blockers: readonly string[];
  readonly activity: Readonly<Record<ActivityKind, boolean>>;
  readonly authoritySnapshotSha256: string | null;
  readonly inventorySnapshotSha256: string | null;
  readonly repositories: Readonly<Record<RepositoryKind, EcrRetentionRepositoryEvidence>>;
}

const REPOSITORY_KINDS = ['prover', 'toolchain'] as const;
const ACTIVITY_KINDS = ['codeBuild', 'codePipeline', 'ecs', 'stepFunctions'] as const;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,511}$/u;
const DELETE_BATCH_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function requireString(value: unknown, label: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireDenseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new Error(`${label} must be a dense array.`);
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function parseConfig(value: unknown): EcrRetentionConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'expectedAccountId',
      'expectedRegion',
      'expectedScheduleArn',
      'repositories',
      'retainedSubjectCount',
      'targetKey',
    ])
  ) {
    throw new Error('ECR retention config must use the exact current shape.');
  }
  if (value['targetKey'] !== 'stark-dev/develop') {
    throw new Error('ECR retention runtime is allowed only for stark-dev/develop.');
  }
  const target = resolveAllowedDeploymentTarget('stark-dev/develop');
  const foundation = resolveDeploymentLaneAuthority(target, 'foundation');
  const repositories = value['repositories'];
  if (!isRecord(repositories) || !hasExactKeys(repositories, REPOSITORY_KINDS)) {
    throw new Error('ECR retention repositories are invalid.');
  }
  const expectedAccountId = requireString(value['expectedAccountId'], 'expectedAccountId', /^[0-9]{12}$/u);
  const expectedRegion = requireString(value['expectedRegion'], 'expectedRegion', /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/u);
  const expectedScheduleArn = requireString(
    value['expectedScheduleArn'],
    'expectedScheduleArn',
    /^arn:aws:events:[a-z0-9-]+:[0-9]{12}:rule\/[A-Za-z0-9._/-]+$/u,
  );
  if (
    expectedAccountId !== target.accountId ||
    expectedRegion !== target.region ||
    !expectedScheduleArn.startsWith(`arn:aws:events:${target.region}:${target.accountId}:rule/`) ||
    repositories['prover'] !== foundation.names.proverRepository ||
    repositories['toolchain'] !== foundation.names.toolchainRepository
  ) {
    throw new Error('ECR retention config does not match stark-dev/develop authority.');
  }
  if (value['retainedSubjectCount'] !== ECR_SUBJECT_RETENTION_COUNTS.develop) {
    throw new Error('retainedSubjectCount must match the reviewed develop retention policy.');
  }
  return deepFreeze({
    expectedAccountId,
    expectedRegion,
    expectedScheduleArn,
    retainedSubjectCount: ECR_SUBJECT_RETENTION_COUNTS.develop,
    targetKey: 'stark-dev/develop',
    repositories: {
      prover: foundation.names.proverRepository,
      toolchain: foundation.names.toolchainRepository,
    },
  });
}

function invocationMatches(value: unknown, expectedScheduleArn: string): boolean {
  if (!isRecord(value)) return false;
  if (value['source'] !== 'aws.events' || value['detail-type'] !== 'Scheduled Event') return false;
  const resources = value['resources'];
  return Array.isArray(resources) && resources.length === 1 && resources[0] === expectedScheduleArn;
}

function parseActivity(value: unknown): Record<ActivityKind, boolean> {
  if (!isRecord(value) || !hasExactKeys(value, ACTIVITY_KINDS)) {
    throw new Error('ECR retention activity observation is invalid.');
  }
  const activity = {
    codeBuild: value['codeBuild'],
    codePipeline: value['codePipeline'],
    ecs: value['ecs'],
    stepFunctions: value['stepFunctions'],
  };
  if (Object.values(activity).some((entry) => typeof entry !== 'boolean')) {
    throw new Error('ECR retention activity observation is invalid.');
  }
  return activity as Record<ActivityKind, boolean>;
}

function parseObservation(
  value: unknown,
  config: EcrRetentionConfig,
): {
  readonly authoritySnapshotSha256: string;
  readonly plan: EcrSubjectRetentionPlan;
} {
  if (!isRecord(value) || !hasExactKeys(value, ['authoritySnapshotSha256', 'repositories'])) {
    throw new Error('ECR retention observation is invalid.');
  }
  const authoritySnapshotSha256 = parseSha256(value['authoritySnapshotSha256'], 'ECR authority snapshot SHA-256');
  const plan = planEcrSubjectRetention({
    environmentId: 'develop',
    repositories: value['repositories'],
  });
  if (
    plan.repositories.prover.repositoryName !== config.repositories.prover ||
    plan.repositories.toolchain.repositoryName !== config.repositories.toolchain ||
    plan.repositories.prover.targetSubjectCount !== config.retainedSubjectCount ||
    plan.repositories.toolchain.targetSubjectCount !== config.retainedSubjectCount
  ) {
    throw new Error('ECR retention observation does not match runtime authority.');
  }
  return deepFreeze({ authoritySnapshotSha256, plan });
}

function hasActivity(activity: Record<ActivityKind, boolean>): boolean {
  return ACTIVITY_KINDS.some((kind) => activity[kind]);
}

function repositoryEvidence(
  config: EcrRetentionConfig,
  kind: RepositoryKind,
  plan: EcrRetentionRepositoryPlan | undefined,
  deleted: Readonly<{ referrers: readonly string[]; subjects: readonly string[] }> = {
    referrers: [],
    subjects: [],
  },
): EcrRetentionRepositoryEvidence {
  return {
    repositoryName: config.repositories[kind],
    subjectCount: plan?.subjectCount ?? 0,
    protectedSubjectCount: plan?.protectedSubjectCount ?? 0,
    targetSubjectCount: config.retainedSubjectCount,
    plannedReferrerDeleteCount: plan?.deleteReferrerDigests.length ?? 0,
    plannedSubjectDeleteCount: plan?.deleteSubjectDigests.length ?? 0,
    deletedReferrerDigests: deleted.referrers,
    deletedSubjectDigests: deleted.subjects,
  };
}

function evidence(options: {
  readonly config: EcrRetentionConfig;
  readonly disposition: EcrRetentionDisposition;
  readonly blockers?: readonly string[];
  readonly activity?: Record<ActivityKind, boolean>;
  readonly observation?: ReturnType<typeof parseObservation>;
  readonly deleted?: Partial<
    Record<RepositoryKind, Readonly<{ referrers: readonly string[]; subjects: readonly string[] }>>
  >;
}): EcrRetentionEvidence {
  const { config, observation } = options;
  return deepFreeze({
    evidenceType: 'ecr-subject-retention',
    targetKey: 'stark-dev/develop',
    reportOnly: false,
    disposition: options.disposition,
    blockers: [...(options.blockers ?? [])],
    activity: options.activity ?? {
      codeBuild: false,
      codePipeline: false,
      ecs: false,
      stepFunctions: false,
    },
    authoritySnapshotSha256: observation?.authoritySnapshotSha256 ?? null,
    inventorySnapshotSha256: observation?.plan.snapshotSha256 ?? null,
    repositories: {
      prover: repositoryEvidence(config, 'prover', observation?.plan.repositories.prover, options.deleted?.prover),
      toolchain: repositoryEvidence(
        config,
        'toolchain',
        observation?.plan.repositories.toolchain,
        options.deleted?.toolchain,
      ),
    },
  });
}

function parseDeleteResult(value: unknown, plannedDigests: readonly string[]): EcrRetentionDeleteResult {
  if (!isRecord(value) || !hasExactKeys(value, ['deletedImageDigests', 'failures'])) {
    throw new Error('BatchDeleteImage result is invalid.');
  }
  const planned = new Set(plannedDigests);
  const deletedImageDigests = requireDenseArray(value['deletedImageDigests'], 'deleted ECR image digests').map(
    (entry) => parseImageDigest(entry, 'deleted ECR image digest'),
  );
  const failures = requireDenseArray(value['failures'], 'ECR deletion failures').map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['failureCode', 'imageDigest'])) {
      throw new Error('ECR deletion failure is invalid.');
    }
    return {
      failureCode: requireString(entry['failureCode'], 'ECR deletion failure code', SAFE_IDENTIFIER_PATTERN),
      imageDigest: parseImageDigest(entry['imageDigest'], 'failed ECR image digest'),
    };
  });
  const accounted = [...deletedImageDigests, ...failures.map((failure) => failure.imageDigest)];
  if (
    new Set(accounted).size !== accounted.length ||
    accounted.length !== planned.size ||
    accounted.some((digest) => !planned.has(digest))
  ) {
    throw new Error('BatchDeleteImage result does not account for the exact request.');
  }
  return { deletedImageDigests, failures };
}

function parsePresenceResult(
  value: unknown,
  request: EcrRetentionPresenceRequest,
): Readonly<{
  existingExpectedAbsentDigests: readonly string[];
  missingExpectedPresentDigests: readonly string[];
}> {
  if (!isRecord(value) || !hasExactKeys(value, ['existingExpectedAbsentDigests', 'missingExpectedPresentDigests'])) {
    throw new Error('Post-delete ECR readback is invalid.');
  }
  const parseSubset = (entries: unknown, expected: readonly string[], label: string): readonly string[] => {
    const expectedSet = new Set(expected);
    const parsed = requireDenseArray(entries, label).map((entry) => parseImageDigest(entry, label));
    if (new Set(parsed).size !== parsed.length || parsed.some((digest) => !expectedSet.has(digest))) {
      throw new Error('Post-delete ECR readback is invalid.');
    }
    return parsed;
  };
  return {
    existingExpectedAbsentDigests: parseSubset(
      value['existingExpectedAbsentDigests'],
      request.expectedAbsentDigests,
      'existing post-delete ECR digest',
    ),
    missingExpectedPresentDigests: parseSubset(
      value['missingExpectedPresentDigests'],
      request.expectedPresentDigests,
      'missing protected ECR digest',
    ),
  };
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function createEcrRetentionHandler(
  dependencies: EcrRetentionDependencies,
  configValue: unknown,
): (event: unknown) => Promise<EcrRetentionEvidence> {
  const config = parseConfig(configValue);
  return async (eventValue: unknown): Promise<EcrRetentionEvidence> => {
    if (!invocationMatches(eventValue, config.expectedScheduleArn)) {
      return evidence({
        config,
        disposition: 'blocked',
        blockers: ['INVOCATION_AUTHORITY_MISMATCH'],
      });
    }
    let callerAccountId: string;
    try {
      callerAccountId = await dependencies.getCallerAccountId();
    } catch {
      return evidence({ config, disposition: 'blocked', blockers: ['CALLER_IDENTITY_FAILED'] });
    }
    if (callerAccountId !== config.expectedAccountId) {
      return evidence({ config, disposition: 'blocked', blockers: ['CALLER_IDENTITY_MISMATCH'] });
    }
    let activity: Record<ActivityKind, boolean>;
    try {
      activity = parseActivity(await dependencies.observeActivity());
    } catch {
      return evidence({ config, disposition: 'blocked', blockers: ['OBSERVATION_FAILED'] });
    }
    if (hasActivity(activity)) {
      return evidence({ config, disposition: 'skipped-active', activity });
    }
    let first: ReturnType<typeof parseObservation>;
    try {
      first = parseObservation(await dependencies.observe(), config);
    } catch {
      return evidence({ config, disposition: 'blocked', blockers: ['OBSERVATION_FAILED'] });
    }
    if (first.plan.disposition === 'blocked') {
      return evidence({
        config,
        disposition: 'blocked',
        blockers: first.plan.blockers,
        activity,
        observation: first,
      });
    }
    if (first.plan.disposition === 'no-change') {
      return evidence({ config, disposition: 'no-change', activity, observation: first });
    }
    try {
      activity = parseActivity(await dependencies.observeActivity());
    } catch {
      return evidence({
        config,
        disposition: 'blocked',
        blockers: ['OBSERVATION_FAILED'],
        activity,
        observation: first,
      });
    }
    if (hasActivity(activity)) {
      return evidence({ config, disposition: 'skipped-active', activity, observation: first });
    }
    let second: ReturnType<typeof parseObservation>;
    try {
      second = parseObservation(await dependencies.observe(), config);
    } catch {
      return evidence({
        config,
        disposition: 'blocked',
        blockers: ['OBSERVATION_FAILED'],
        activity,
        observation: first,
      });
    }
    if (
      second.plan.disposition !== 'delete' ||
      second.authoritySnapshotSha256 !== first.authoritySnapshotSha256 ||
      second.plan.snapshotSha256 !== first.plan.snapshotSha256
    ) {
      return evidence({ config, disposition: 'skipped-changed', activity, observation: second });
    }
    try {
      activity = parseActivity(await dependencies.observeActivity());
    } catch {
      return evidence({
        config,
        disposition: 'blocked',
        blockers: ['OBSERVATION_FAILED'],
        activity,
        observation: second,
      });
    }
    if (hasActivity(activity)) {
      return evidence({ config, disposition: 'skipped-active', activity, observation: second });
    }
    const deleted: Partial<
      Record<RepositoryKind, Readonly<{ referrers: readonly string[]; subjects: readonly string[] }>>
    > = {};
    let mutationAttempted = false;
    const revalidateMutation = async (): Promise<
      | { readonly status: 'ok'; readonly activity: Record<ActivityKind, boolean> }
      | { readonly status: 'active'; readonly activity: Record<ActivityKind, boolean> }
      | { readonly status: 'changed' | 'failed'; readonly activity: Record<ActivityKind, boolean> }
    > => {
      let authoritySnapshotSha256: string;
      try {
        authoritySnapshotSha256 = parseSha256(
          await dependencies.observeAuthoritySnapshotSha256(),
          'pre-mutation ECR authority snapshot SHA-256',
        );
      } catch {
        return { status: 'failed', activity };
      }
      if (authoritySnapshotSha256 !== second.authoritySnapshotSha256) {
        return { status: 'changed', activity };
      }
      let currentActivity: Record<ActivityKind, boolean>;
      try {
        currentActivity = parseActivity(await dependencies.observeActivity());
      } catch {
        return { status: 'failed', activity };
      }
      if (hasActivity(currentActivity)) return { status: 'active', activity: currentActivity };
      return { status: 'ok', activity: currentActivity };
    };
    const revalidationEvidence = (
      result: Exclude<Awaited<ReturnType<typeof revalidateMutation>>, { readonly status: 'ok' }>,
    ): EcrRetentionEvidence => {
      if (mutationAttempted) {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: [result.status === 'failed' ? 'OBSERVATION_FAILED' : 'MUTATION_REVALIDATION_CHANGED'],
          activity: result.activity,
          observation: second,
          deleted,
        });
      }
      if (result.status === 'active') {
        return evidence({ config, disposition: 'skipped-active', activity: result.activity, observation: second });
      }
      if (result.status === 'changed') {
        return evidence({ config, disposition: 'skipped-changed', activity: result.activity, observation: second });
      }
      return evidence({
        config,
        disposition: 'blocked',
        blockers: ['OBSERVATION_FAILED'],
        activity: result.activity,
        observation: second,
      });
    };
    for (const kind of REPOSITORY_KINDS) {
      const repositoryPlan = second.plan.repositories[kind];
      if (repositoryPlan.deleteSubjectDigests.length === 0) continue;
      let deletedReferrers: readonly string[] = [];
      let deletedSubjects: readonly string[] = [];
      deleted[kind] = { referrers: deletedReferrers, subjects: deletedSubjects };
      for (const imageDigests of chunks(repositoryPlan.deleteReferrerDigests, DELETE_BATCH_SIZE)) {
        const revalidation = await revalidateMutation();
        if (revalidation.status !== 'ok') return revalidationEvidence(revalidation);
        const request = {
          repositoryKind: kind,
          repositoryName: repositoryPlan.repositoryName,
          imageKind: 'referrer',
          imageDigests,
        } as const;
        let deleteResult: EcrRetentionDeleteResult;
        mutationAttempted = true;
        try {
          deleteResult = parseDeleteResult(await dependencies.deleteImages(request), imageDigests);
        } catch {
          return evidence({
            config,
            disposition: 'delete-failed',
            blockers: ['BATCH_DELETE_FAILED'],
            observation: second,
            deleted,
          });
        }
        deletedReferrers = [...deletedReferrers, ...deleteResult.deletedImageDigests];
        deleted[kind] = { referrers: deletedReferrers, subjects: deletedSubjects };
        if (deleteResult.failures.length > 0) {
          return evidence({
            config,
            disposition: 'delete-failed',
            blockers: ['BATCH_DELETE_FAILED'],
            observation: second,
            deleted,
          });
        }
      }
      const referrerProofRequest = {
        repositoryKind: kind,
        repositoryName: repositoryPlan.repositoryName,
        expectedAbsentDigests: repositoryPlan.deleteReferrerDigests,
        expectedPresentDigests: [...repositoryPlan.protectedSubjectDigests, ...repositoryPlan.deleteSubjectDigests],
      } as const;
      let referrerProof: ReturnType<typeof parsePresenceResult>;
      try {
        referrerProof = parsePresenceResult(
          await dependencies.readImagePresence(referrerProofRequest),
          referrerProofRequest,
        );
      } catch {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_READ_FAILED'],
          observation: second,
          deleted,
        });
      }
      if (referrerProof.existingExpectedAbsentDigests.length > 0) {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_TARGET_PRESENT'],
          observation: second,
          deleted,
        });
      }
      if (referrerProof.missingExpectedPresentDigests.length > 0) {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_REQUIRED_PRESENT_MISSING'],
          observation: second,
          deleted,
        });
      }
      for (const imageDigests of chunks(repositoryPlan.deleteSubjectDigests, DELETE_BATCH_SIZE)) {
        const revalidation = await revalidateMutation();
        if (revalidation.status !== 'ok') return revalidationEvidence(revalidation);
        const request = {
          repositoryKind: kind,
          repositoryName: repositoryPlan.repositoryName,
          imageKind: 'subject',
          imageDigests,
        } as const;
        let deleteResult: EcrRetentionDeleteResult;
        mutationAttempted = true;
        try {
          deleteResult = parseDeleteResult(await dependencies.deleteImages(request), imageDigests);
        } catch {
          return evidence({
            config,
            disposition: 'delete-failed',
            blockers: ['BATCH_DELETE_FAILED'],
            observation: second,
            deleted,
          });
        }
        deletedSubjects = [...deletedSubjects, ...deleteResult.deletedImageDigests];
        deleted[kind] = { referrers: deletedReferrers, subjects: deletedSubjects };
        if (deleteResult.failures.length > 0) {
          return evidence({
            config,
            disposition: 'delete-failed',
            blockers: ['BATCH_DELETE_FAILED'],
            observation: second,
            deleted,
          });
        }
      }
      const finalProofRequest = {
        repositoryKind: kind,
        repositoryName: repositoryPlan.repositoryName,
        expectedAbsentDigests: [...repositoryPlan.deleteReferrerDigests, ...repositoryPlan.deleteSubjectDigests],
        expectedPresentDigests: repositoryPlan.protectedSubjectDigests,
      } as const;
      let finalProof: ReturnType<typeof parsePresenceResult>;
      try {
        finalProof = parsePresenceResult(await dependencies.readImagePresence(finalProofRequest), finalProofRequest);
      } catch {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_READ_FAILED'],
          observation: second,
          deleted,
        });
      }
      if (finalProof.existingExpectedAbsentDigests.length > 0) {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_TARGET_PRESENT'],
          observation: second,
          deleted,
        });
      }
      if (finalProof.missingExpectedPresentDigests.length > 0) {
        return evidence({
          config,
          disposition: 'delete-unverified',
          blockers: ['POST_DELETE_REQUIRED_PRESENT_MISSING'],
          observation: second,
          deleted,
        });
      }
    }
    return evidence({ config, disposition: 'deleted', observation: second, deleted });
  };
}
