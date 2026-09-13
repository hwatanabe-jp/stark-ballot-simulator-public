import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { FOUNDATION_CONTRACT_CLOSURE_IDENTITY } from './foundation-contract.js';
import { deepFreeze } from './internal.js';
import { classifySavedPlanDisposition } from './saved-plan-disposition.js';
import { buildSavedPlanReview } from './saved-plan-review.js';

const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');

const SOURCE_SHA = 'a'.repeat(40);
const ROLLBACK_SOURCE_SHA = 'f'.repeat(40);
const TFPLAN_SHA256 = 'b'.repeat(64);

type Lane = 'app' | 'bootstrap' | 'foundation';
type Gate = 'terraform' | 'verifier-preflight';
type DeploymentMode = 'normal' | 'rollback';

function terraformPlan(options: {
  applyable: boolean;
  collidingIndexedChanges: boolean | undefined;
  collidingIndexedDrift: boolean | undefined;
  complete: boolean;
  driftChange: boolean | undefined;
  outputOnly: boolean | undefined;
  semanticChange: boolean;
}) {
  const changedResource = (address: string) => ({
    address,
    change: {
      actions: ['update'],
      before: { force_destroy: false },
      after: { force_destroy: true },
      before_sensitive: {},
      after_sensitive: {},
      after_unknown: {},
    },
  });
  return {
    format_version: '1.2',
    terraform_version: '1.15.8',
    applyable: options.applyable,
    complete: options.complete,
    errored: false,
    deferred_changes: [],
    action_invocations: [],
    deferred_action_invocations: [],
    resource_changes:
      options.semanticChange && !options.outputOnly
        ? options.collidingIndexedChanges
          ? [
              changedResource('aws_s3_bucket.target["private-first"]'),
              changedResource('aws_s3_bucket.target["private-second"]'),
            ]
          : [changedResource('aws_s3_bucket.target')]
        : [],
    output_changes: options.outputOnly ? { deployment_identity: { actions: ['update'] } } : {},
    resource_drift: options.driftChange
      ? options.collidingIndexedDrift
        ? [
            { address: 'aws_s3_bucket.target["private-first"]', change: { actions: ['update'] } },
            { address: 'aws_s3_bucket.target["private-second"]', change: { actions: ['update'] } },
          ]
        : [{ address: 'aws_s3_bucket.target', change: { actions: ['update'] } }]
      : [],
    checks: [{ status: 'pass' }],
  };
}

function appDeploymentAuthority(mode: DeploymentMode) {
  const selectedSourceSha = mode === 'normal' ? SOURCE_SHA : ROLLBACK_SOURCE_SHA;
  return {
    authorityType: 'app-deployment' as const,
    deploymentMode: mode,
    selectedSourceSha,
    deploymentId: `dep_${'1'.repeat(32)}`,
    appExecutionAuthoritySha256: '1'.repeat(64),
    selectedProverSelector: 'accepted' as const,
    expectedImageId: `0x${'2'.repeat(64)}`,
    methodVersion: 14,
    imageIdVariant: 'default' as const,
    imageIdMappingSha256: '3'.repeat(64),
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    toolchainImageDigest: `sha256:${'5'.repeat(64)}`,
    proverReleaseKey: `artifacts/prover/releases/${'6'.repeat(64)}.json`,
    toolchainReleaseKey: `artifacts/toolchain/releases/${'7'.repeat(64)}.json`,
    lambdaSourceSha: selectedSourceSha,
    lambdaCount: 6 as const,
    lambdaSetSha256: '8'.repeat(64),
    verifierFunctionVersion: '28',
  };
}

function appVerifierPreflightAuthority() {
  return {
    authorityType: 'app-verifier-preflight' as const,
    packageSourceSha: SOURCE_SHA,
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    package: {
      key: 'artifacts/app/verifier/exact-package.zip',
      versionId: 'verifier-package-object-id',
      sha256: '9'.repeat(64),
    },
    sourceCodeHash: Buffer.alloc(32, 1).toString('base64'),
    assetManifestSha256: 'a'.repeat(64),
    trustRootSha256: 'b'.repeat(64),
    expectedFunctionVersion: '29',
    reconciliationDesiredSha256: 'c'.repeat(64),
    foundationAcceptance: {
      foundationAcceptanceKey: `accepted-baselines/stark-dev/develop/foundation/acceptances/${'d'.repeat(64)}.json`,
      foundationAcceptedSourceSha: SOURCE_SHA,
      closureIdentity: FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
      foundationContractHash: 'e'.repeat(64),
    },
  };
}

function semanticReview(options: {
  collidingIndexedChanges?: boolean;
  collidingIndexedDrift?: boolean;
  driftChange?: boolean;
  environment?: 'develop' | 'main';
  gate?: Gate;
  lane: Lane;
  mode?: DeploymentMode;
  outputOnly?: boolean;
  semanticChange: boolean;
}) {
  const gate = options.gate ?? 'terraform';
  const mode = options.mode ?? 'normal';
  const root = options.lane;
  const environment = options.environment ?? 'develop';
  const accountLabel = environment === 'develop' ? 'stark-dev' : 'stark-prod';
  const selectedSourceSha = mode === 'normal' ? SOURCE_SHA : ROLLBACK_SOURCE_SHA;
  const appTerraform = options.lane === 'app' && gate === 'terraform';
  const appPreflight = options.lane === 'app' && gate === 'verifier-preflight';
  const fullReview = buildSavedPlanReview(
    {
      context: {
        accountId: TARGET.accountId,
        backendKey: `stark-ballot-simulator/${accountLabel}/${environment}/${root}/terraform.tfstate`,
        deploymentEnvironment: environment,
        gate,
        lane: options.lane,
        pipelineExecutionId: '11111111-2222-3333-4444-555555555555',
        region: 'ap-northeast-1',
        sourceSha: SOURCE_SHA,
        stateIdentity: `${accountLabel}/${environment}/${root}`,
      },
      artifact: {
        bucket: resolveDeploymentLaneAuthority(TARGET, root).names.artifactBucket,
        key: 'pipeline/PlanOutput/exact-artifact.zip',
        versionId: 'artifact-object-id',
        sha256: 'c'.repeat(64),
      },
      state: {
        bucket: resolveDeploymentLaneAuthority(TARGET, root).names.terraformStateBucket,
        key: `stark-ballot-simulator/${accountLabel}/${environment}/${root}/terraform.tfstate`,
        versionId: 'state-object-id',
        etag: '"0123456789abcdef0123456789abcdef"',
      },
      plan: {
        planJson: terraformPlan({
          applyable: options.semanticChange,
          collidingIndexedChanges: options.collidingIndexedChanges,
          collidingIndexedDrift: options.collidingIndexedDrift,
          complete: !appPreflight,
          driftChange: options.driftChange,
          outputOnly: options.outputOnly,
          semanticChange: options.semanticChange,
        }),
        planJsonSha256: 'd'.repeat(64),
        tfplanSha256: TFPLAN_SHA256,
      },
      approval: appTerraform
        ? {
            deploymentMode: mode,
            controlSourceSha: SOURCE_SHA,
            selectedSourceSha,
            accountId: TARGET.accountId,
            deploymentEnvironment: environment,
            reviewedPlanChecksum: TFPLAN_SHA256,
          }
        : {
            sourceSha: SOURCE_SHA,
            accountId: TARGET.accountId,
            deploymentEnvironment: environment,
            reviewedPlanChecksum: TFPLAN_SHA256,
          },
      authority: appTerraform ? appDeploymentAuthority(mode) : appPreflight ? appVerifierPreflightAuthority() : null,
    },
    'stark-dev/develop',
  );
  return deepFreeze({
    reviewType: 'saved-plan-semantic-review' as const,
    context: fullReview.context,
    summary: fullReview.summary,
    approval: fullReview.approval,
    authority: fullReview.authority,
  });
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function alteredReview(review: ReturnType<typeof semanticReview>, mutate: (value: Record<string, unknown>) => void) {
  const copy = mutableRecord(structuredClone(review));
  mutate(copy);
  return deepFreeze(copy);
}

describe('saved-plan disposition', () => {
  it.each(['changedAddresses', 'drift', 'outputChanges'] as const)(
    'rejects %s beyond its review admission limit',
    (field) => {
      const review = semanticReview({ lane: 'bootstrap', semanticChange: true });
      const overBudget = alteredReview(review, (value) => {
        const summary = mutableRecord(value['summary']);
        const count = field === 'outputChanges' ? 101 : 1_001;
        if (field === 'changedAddresses') {
          const original = mutableRecord((summary['changedAddresses'] as unknown[])[0]);
          summary[field] = Array.from({ length: count }, (_, index) => ({
            ...original,
            address: `aws_s3_bucket.target_${String(index).padStart(4, '0')}`,
          }));
          mutableRecord(summary['actionCounts'])['update'] = count;
        } else {
          summary[field] = {
            count,
            omittedNameCount: 0,
            names: Array.from(
              { length: count },
              (_, index) => `${field === 'drift' ? 'aws_s3_bucket.' : ''}target_${String(index).padStart(4, '0')}`,
            ),
          };
        }
      });
      expect(() =>
        classifySavedPlanDisposition({ review: overBudget, appReleaseChain: null }, TARGET.targetKey),
      ).toThrow('bounded array');
    },
  );

  it.each([
    ['Bootstrap change', semanticReview({ lane: 'bootstrap', semanticChange: true })],
    ['Bootstrap output change', semanticReview({ lane: 'bootstrap', outputOnly: true, semanticChange: true })],
    ['Bootstrap no-op', semanticReview({ lane: 'bootstrap', semanticChange: false })],
    ['Bootstrap no-op with drift', semanticReview({ lane: 'bootstrap', driftChange: true, semanticChange: false })],
    ['Foundation change', semanticReview({ lane: 'foundation', semanticChange: true })],
    ['Foundation no-op', semanticReview({ lane: 'foundation', semanticChange: false })],
    ['App rollback change', semanticReview({ lane: 'app', mode: 'rollback', semanticChange: true })],
    ['App rollback no-op', semanticReview({ lane: 'app', mode: 'rollback', semanticChange: false })],
    ['App normal change', semanticReview({ lane: 'app', mode: 'normal', semanticChange: true })],
    [
      'App verifier preflight change',
      semanticReview({ lane: 'app', gate: 'verifier-preflight', semanticChange: true }),
    ],
  ])('keeps a supported %s reviewable', (_label, review) => {
    const result = classifySavedPlanDisposition({ review, appReleaseChain: null }, 'stark-dev/develop');

    expect(result).toEqual({ disposition: 'REVIEWABLE', review });
    expect(result.review).not.toBe(review);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.review)).toBe(true);
    expect(Object.isFrozen(result.review.summary.actionCounts)).toBe(true);
  });

  it('skips a normal App no-op only when selected and accepted release chains match', () => {
    const review = semanticReview({ lane: 'app', mode: 'normal', semanticChange: false });

    const result = classifySavedPlanDisposition(
      {
        review,
        appReleaseChain: {
          deploymentMode: 'normal',
          selectedReleaseChainSha256: 'e'.repeat(64),
          currentAcceptedReleaseChainSha256: 'e'.repeat(64),
        },
      },
      'stark-dev/develop',
    );

    expect(result).toEqual({ disposition: 'EMPTY_PLAN_SKIP', review });
  });

  it('requires manual review for a main App no-op without skip comparison authority', async () => {
    const { configuration } = productionConfigurationFixture();
    vi.resetModules();
    vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
    try {
      const targets = await import('./index.js');
      const disposition = await import('./saved-plan-disposition.js');
      const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
      const lane = targets.resolveDeploymentLaneAuthority(production, 'app');
      const base = semanticReview({ lane: 'app', mode: 'normal', semanticChange: false });
      const review = {
        ...base,
        context: {
          ...base.context,
          accountId: production.accountId,
          deploymentEnvironment: production.environmentId,
          stateIdentity: lane.stateIdentity,
          backendKey: lane.backendKey,
        },
        approval: {
          ...base.approval,
          accountId: production.accountId,
          deploymentEnvironment: production.environmentId,
        },
      };
      expect(disposition.classifySavedPlanDisposition({ review, appReleaseChain: null }, production.targetKey)).toEqual(
        { disposition: 'REVIEWABLE', review },
      );
      expect(() =>
        disposition.classifySavedPlanDisposition({ review, appReleaseChain: null }, TARGET.targetKey),
      ).toThrow('expected target');
      expect(() =>
        disposition.classifySavedPlanDisposition(
          {
            review,
            appReleaseChain: {
              deploymentMode: 'normal',
              selectedReleaseChainSha256: 'e'.repeat(64),
              currentAcceptedReleaseChainSha256: 'e'.repeat(64),
            },
          },
          production.targetKey,
        ),
      ).toThrow('App release chain must be null for a reviewable plan');
    } finally {
      vi.doUnmock('../deployment-targets.json');
      vi.resetModules();
    }
  });

  it('preserves raw multiplicity when indexed resources share one redacted address', () => {
    const review = semanticReview({
      collidingIndexedChanges: true,
      collidingIndexedDrift: true,
      driftChange: true,
      lane: 'foundation',
      semanticChange: true,
    });

    expect(review.summary.actionCounts.update).toBe(2);
    expect(review.summary.changedAddresses).toHaveLength(1);
    expect(review.summary.drift).toMatchObject({
      count: 2,
      names: [review.summary.changedAddresses[0]?.address],
      omittedNameCount: 0,
    });
    expect(classifySavedPlanDisposition({ review, appReleaseChain: null }, 'stark-dev/develop')).toMatchObject({
      disposition: 'REVIEWABLE',
    });
  });

  it('rejects missing, unequal, or extended release-chain evidence for a normal App no-op', () => {
    const review = semanticReview({ lane: 'app', mode: 'normal', semanticChange: false });

    expect(() => classifySavedPlanDisposition({ review, appReleaseChain: null }, 'stark-dev/develop')).toThrow(
      /release chain/u,
    );
    expect(() =>
      classifySavedPlanDisposition(
        {
          review,
          appReleaseChain: {
            deploymentMode: 'normal',
            selectedReleaseChainSha256: 'e'.repeat(64),
            currentAcceptedReleaseChainSha256: 'f'.repeat(64),
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/do not match/u);
    expect(() =>
      classifySavedPlanDisposition(
        {
          review,
          appReleaseChain: {
            deploymentMode: 'normal',
            selectedReleaseChainSha256: 'e'.repeat(64),
            currentAcceptedReleaseChainSha256: 'e'.repeat(64),
            note: 'unexpected',
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/exact current shape/u);
  });

  it.each([
    semanticReview({ lane: 'bootstrap', semanticChange: false }),
    semanticReview({ lane: 'foundation', semanticChange: true }),
    semanticReview({ lane: 'app', mode: 'rollback', semanticChange: false }),
    semanticReview({ lane: 'app', mode: 'normal', semanticChange: true }),
    semanticReview({ lane: 'app', gate: 'verifier-preflight', semanticChange: true }),
  ])('rejects unused App release-chain coordinates', (review) => {
    expect(() =>
      classifySavedPlanDisposition(
        {
          review,
          appReleaseChain: {
            deploymentMode: 'normal',
            selectedReleaseChainSha256: 'e'.repeat(64),
            currentAcceptedReleaseChainSha256: 'e'.repeat(64),
          },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/must be null/u);
  });

  it('re-admits a serialized review and rejects inconsistent nested counts', () => {
    const review = semanticReview({ lane: 'foundation', semanticChange: true });
    const serialized = structuredClone(review);
    const admitted = classifySavedPlanDisposition({ review: serialized, appReleaseChain: null }, 'stark-dev/develop');
    const inconsistent = alteredReview(review, (value) => {
      mutableRecord(mutableRecord(value['summary'])['drift'])['count'] = 1;
    });

    expect(admitted.review).toEqual(review);
    expect(admitted.review).not.toBe(serialized);
    expect(() =>
      classifySavedPlanDisposition({ review: inconsistent, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/drift/u);
  });

  it.each([
    [
      'Terraform identity',
      (review: Record<string, unknown>) => {
        mutableRecord(review['summary'])['terraformVersion'] = 'unsupported';
      },
    ],
    [
      'plan format identity',
      (review: Record<string, unknown>) => {
        mutableRecord(review['summary'])['formatVersion'] = 'unsupported';
      },
    ],
    [
      'lane and gate',
      (review: Record<string, unknown>) => {
        mutableRecord(review['context'])['lane'] = 'toolchain';
      },
    ],
    [
      'execution disposition',
      (review: Record<string, unknown>) => {
        mutableRecord(review['summary'])['applyable'] = false;
      },
    ],
    [
      'App approval binding',
      (review: Record<string, unknown>) => {
        mutableRecord(review['approval'])['selectedSourceSha'] = ROLLBACK_SOURCE_SHA;
      },
    ],
  ] as const)('rejects an unsupported %s in an exact frozen review', (_label, mutate) => {
    const review = semanticReview({ lane: 'app', mode: 'normal', semanticChange: true });
    const forged = alteredReview(review, mutate);

    expect(() =>
      classifySavedPlanDisposition({ review: forged, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow();
  });

  it('rejects extra nested fields', () => {
    const review = semanticReview({ lane: 'foundation', semanticChange: true });
    const forged = alteredReview(review, (value) => {
      mutableRecord(value['summary'])['note'] = 'unexpected';
    });

    expect(() => classifySavedPlanDisposition({ review: forged, appReleaseChain: null }, 'stark-dev/develop')).toThrow(
      /exact current shape/u,
    );
  });

  it('rejects summary counts and replacement attributes detached from their represented entries', () => {
    const review = semanticReview({ lane: 'foundation', semanticChange: true });
    const inflatedActions = alteredReview(review, (value) => {
      mutableRecord(mutableRecord(value['summary'])['actionCounts'])['create'] = 1;
    });
    const detachedDrift = alteredReview(review, (value) => {
      const drift = mutableRecord(mutableRecord(value['summary'])['drift']);
      drift['count'] = 0;
      drift['names'] = ['aws_s3_bucket.target'];
    });
    const detachedReplacement = alteredReview(review, (value) => {
      const summary = mutableRecord(value['summary']);
      const changed = mutableRecord((summary['changedAddresses'] as unknown[])[0]);
      changed['replacementAttributes'] = ['detached_attribute'];
    });

    expect(() =>
      classifySavedPlanDisposition({ review: inflatedActions, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/action counts/u);
    expect(() =>
      classifySavedPlanDisposition({ review: detachedDrift, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/drift/u);
    expect(() =>
      classifySavedPlanDisposition({ review: detachedReplacement, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/replacement/u);
  });

  it('rejects a raw indexed drift address from the semantic view', () => {
    const review = semanticReview({ driftChange: true, lane: 'foundation', semanticChange: false });
    const rawAddress = alteredReview(review, (value) => {
      mutableRecord(mutableRecord(value['summary'])['drift'])['names'] = ['aws_s3_bucket.target["private-index"]'];
    });

    expect(() =>
      classifySavedPlanDisposition({ review: rawAddress, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/redacted/u);
  });

  it.each([
    [
      'resource action counts',
      semanticReview({ lane: 'foundation', semanticChange: true }),
      (value: Record<string, unknown>) => {
        const summary = mutableRecord(value['summary']);
        const actionCounts = mutableRecord(summary['actionCounts']);
        actionCounts['create'] = 1;
        actionCounts['update'] = 10_000;
        mutableRecord((summary['changedAddresses'] as unknown[])[0])['actionClasses'] = ['create', 'update'];
      },
    ],
    [
      'output counts',
      semanticReview({ lane: 'foundation', outputOnly: true, semanticChange: true }),
      (value: Record<string, unknown>) => {
        mutableRecord(mutableRecord(value['summary'])['outputChanges'])['count'] = 10_001;
      },
    ],
    [
      'drift counts',
      semanticReview({ driftChange: true, lane: 'foundation', semanticChange: false }),
      (value: Record<string, unknown>) => {
        mutableRecord(mutableRecord(value['summary'])['drift'])['count'] = 10_001;
      },
    ],
    [
      'check counts',
      semanticReview({ lane: 'foundation', semanticChange: true }),
      (value: Record<string, unknown>) => {
        const checkStatusCounts = mutableRecord(mutableRecord(value['summary'])['checkStatusCounts']);
        checkStatusCounts['pass'] = 10_000;
        checkStatusCounts['unknown'] = 1;
      },
    ],
  ] as const)('rejects over-budget %s', (_label, review, mutate) => {
    const overBudget = alteredReview(review, mutate);

    expect(() =>
      classifySavedPlanDisposition({ review: overBudget, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow(/bound/u);
  });

  it('rejects proxies and accessors without invoking them', () => {
    const review = semanticReview({ lane: 'foundation', semanticChange: true });
    const proxyTrap = vi.fn(() => Reflect.ownKeys(review));
    const proxiedReview = new Proxy(review, { ownKeys: proxyTrap });
    const getter = vi.fn(() => review);
    const accessorInput = Object.defineProperty({ appReleaseChain: null }, 'review', {
      enumerable: true,
      get: getter,
    });

    expect(() =>
      classifySavedPlanDisposition({ review: proxiedReview, appReleaseChain: null }, 'stark-dev/develop'),
    ).toThrow();
    expect(() => classifySavedPlanDisposition(accessorInput as never, 'stark-dev/develop')).toThrow(/data properties/u);
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects hostile nested collections without invoking them', () => {
    const review = semanticReview({ lane: 'foundation', semanticChange: true });
    const collectionTrap = vi.fn(() => ['0', 'length']);
    const collection = new Proxy(review.summary.changedAddresses, { ownKeys: collectionTrap });
    const hostile = mutableRecord(structuredClone(review));
    mutableRecord(hostile['summary'])['changedAddresses'] = collection;

    expect(() => classifySavedPlanDisposition({ review: hostile, appReleaseChain: null }, 'stark-dev/develop')).toThrow(
      /inert/u,
    );
    expect(collectionTrap).not.toHaveBeenCalled();
  });
});
