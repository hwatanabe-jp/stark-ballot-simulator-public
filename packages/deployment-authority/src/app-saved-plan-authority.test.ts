import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { describe, expect, it, vi } from 'vitest';

import { admitAppSavedPlanAuthority } from './app-saved-plan-authority.js';
import { canonicalJsonSha256 } from './internal.js';
import { deriveDeploymentIdentity, resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const CONTROL_SOURCE_SHA = 'b'.repeat(40);
const SELECTED_SOURCE_SHA = 'b'.repeat(40);
const RETAINED_SOURCE_SHA = 'a'.repeat(40);
const FOUNDATION_ACCEPTANCE_KEY = `accepted-baselines/stark-dev/develop/foundation/acceptances/${'7'.repeat(64)}.json`;
const TOOLCHAIN_RELEASE_KEY = `artifacts/toolchain/releases/${'8'.repeat(64)}.json`;
const PROVER_RELEASE_KEY = `artifacts/prover/releases/${'9'.repeat(64)}.json`;
const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const APP_AUTHORITY = resolveDeploymentLaneAuthority(TARGET, 'app');

type Data = Record<string, unknown>;

function releaseFacts() {
  return {
    foundationAcceptanceKey: FOUNDATION_ACCEPTANCE_KEY,
    foundationContractHash: 'c'.repeat(64),
    proverImageDigest: `sha256:${'2'.repeat(64)}`,
    proverReleaseKey: PROVER_RELEASE_KEY,
    toolchainImageDigest: `sha256:${'1'.repeat(64)}`,
    toolchainReleaseKey: TOOLCHAIN_RELEASE_KEY,
    zkvmContractHash: '5'.repeat(64),
  };
}

function summary(options: { applyable: boolean; complete?: boolean; semanticChange: boolean }) {
  const semanticChange = options.semanticChange;
  return {
    formatVersion: '1.2',
    terraformVersion: '1.15.8',
    applyable: options.applyable,
    complete: options.complete ?? true,
    errored: false,
    actionCounts: {
      create: 0,
      update: semanticChange ? 1 : 0,
      replace: 0,
      delete: 0,
      readOnly: 0,
    },
    changedAddresses: semanticChange
      ? [
          {
            address: 'aws_lambda_function.public_api',
            actionClasses: ['update'],
            changedAttributes: [],
            sensitiveAttributes: [],
            unknownAttributes: [],
            replacementAttributes: [],
          },
        ]
      : [],
    omittedChangedAddressCount: 0,
    outputChanges: { count: 0, names: [], omittedNameCount: 0 },
    foundationBootstrapImpact: null,
    drift: { count: 0, names: [], omittedNameCount: 0 },
    checkStatusCounts: { pass: 1, unknown: 0, fail: 0, error: 0 },
    deferredChangeCount: 0,
    planJsonSha256: 'd'.repeat(64),
    tfplanSha256: 'e'.repeat(64),
  };
}

function evidence(options: {
  applyable: boolean;
  gate?: 'terraform' | 'verifier-preflight';
  mode?: 'normal' | 'rollback';
  semanticChange: boolean;
}) {
  const gate = options.gate ?? 'terraform';
  const mode = options.mode ?? 'normal';
  const selectedSourceSha = mode === 'normal' ? SELECTED_SOURCE_SHA : RETAINED_SOURCE_SHA;
  const context = {
    accountId: TARGET.accountId,
    region: 'ap-northeast-1',
    deploymentEnvironment: 'develop',
    lane: 'app',
    gate,
    pipelineExecutionId: '11111111-2222-4333-8444-555555555555',
    sourceSha: CONTROL_SOURCE_SHA,
    stateIdentity: 'stark-dev/develop/app',
    backendKey: 'stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate',
  };
  const parsedSummary = summary({
    applyable: options.applyable,
    complete: gate === 'verifier-preflight' ? false : true,
    semanticChange: options.semanticChange,
  });
  return {
    context,
    summary: parsedSummary,
    approval:
      gate === 'verifier-preflight'
        ? {
            sourceSha: CONTROL_SOURCE_SHA,
            accountId: TARGET.accountId,
            deploymentEnvironment: 'develop',
            reviewedPlanChecksum: 'e'.repeat(64),
          }
        : {
            deploymentMode: mode,
            controlSourceSha: CONTROL_SOURCE_SHA,
            selectedSourceSha,
            accountId: TARGET.accountId,
            deploymentEnvironment: 'develop',
            reviewedPlanChecksum: 'e'.repeat(64),
          },
  };
}

function normalAuthority() {
  const appExecutionAuthoritySha256 = 'f'.repeat(64);
  const identity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: SELECTED_SOURCE_SHA,
    deployMode: 'normal',
    pipelineExecutionId: '11111111-2222-4333-8444-555555555555',
  });
  return {
    appExecutionAuthoritySha256,
    deploymentId: identity.deploymentId,
    deploymentMode: 'normal',
    expectedImageId: `0x${'e'.repeat(64)}`,
    ...releaseFacts(),
    imageIdMappingSha256: '4'.repeat(64),
    imageIdVariant: 'default',
    lambdaCount: 6,
    lambdaSetSha256: '6'.repeat(64),
    lambdaSourceSha: SELECTED_SOURCE_SHA,
    methodVersion: 14,
    selectedSourceSha: SELECTED_SOURCE_SHA,
    verifierFunctionVersion: '42',
  };
}

function rollbackAuthority() {
  const appExecutionAuthoritySha256 = '3'.repeat(64);
  const identity = deriveDeploymentIdentity({
    appExecutionAuthoritySha256,
    appSourceSha: RETAINED_SOURCE_SHA,
    deployMode: 'rollback',
    pipelineExecutionId: '11111111-2222-4333-8444-555555555555',
  });
  return {
    appExecutionAuthoritySha256,
    deploymentId: identity.deploymentId,
    deploymentMode: 'rollback',
    expectedImageId: `0x${'e'.repeat(64)}`,
    imageIdMappingSha256: '4'.repeat(64),
    imageIdVariant: 'default',
    lambdaCount: 6,
    lambdaSetSha256: '6'.repeat(64),
    lambdaSourceSha: RETAINED_SOURCE_SHA,
    methodVersion: 14,
    proverImageDigest: `sha256:${'2'.repeat(64)}`,
    proverReleaseKey: PROVER_RELEASE_KEY,
    selectedAcceptanceKey: `accepted-deployments/stark-dev/develop/app/acceptances/${'a'.repeat(64)}.json`,
    selectedSourceSha: RETAINED_SOURCE_SHA,
    toolchainImageDigest: `sha256:${'1'.repeat(64)}`,
    toolchainReleaseKey: TOOLCHAIN_RELEASE_KEY,
    verifierFunctionVersion: '39',
    zkvmContractHash: '5'.repeat(64),
  };
}

function preflightAuthority() {
  const facts = releaseFacts();
  return {
    ...facts,
    assetManifestSha256: '7'.repeat(64),
    expectedFunctionVersion: '42',
    reconciliationDesiredSha256: '8'.repeat(64),
    package: {
      key: `${APP_AUTHORITY.names.lambdaArtifactPrefix}/${SELECTED_SOURCE_SHA}/image-signature-verifier.zip`,
      versionId: 'c27b6d12-402e-4afb-8f22-b9e2c13cb7d3',
      sha256: '9'.repeat(64),
    },
    packageSourceSha: SELECTED_SOURCE_SHA,
    releaseAuthoritySha256: canonicalJsonSha256(facts),
    sourceCodeHash: Buffer.from('9'.repeat(64), 'hex').toString('base64'),
    trustRootSha256: 'a'.repeat(64),
  };
}

function releaseComparison(equal: boolean) {
  return {
    deploymentMode: 'normal',
    selectedReleaseChainSha256: 'b'.repeat(64),
    currentAcceptedReleaseChainSha256: equal ? 'b'.repeat(64) : 'c'.repeat(64),
  };
}

describe('App saved-plan authority', () => {
  it('admits a changed normal Terraform decision bound to one App execution authority', () => {
    const input = {
      evidence: evidence({ applyable: true, semanticChange: true }),
      authority: normalAuthority(),
      releaseComparison: null,
    };

    const admitted = admitAppSavedPlanAuthority(input, TARGET.targetKey);

    expect(admitted.disposition).toBe('REVIEWABLE');
    expect(admitted.authority).toEqual(input.authority);
    expect(admitted.authority).not.toHaveProperty('proverReleaseRecord');
    expect(admitted.authority).not.toHaveProperty('toolchainArtifactRecord');
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it('distinguishes an exact no-op skip candidate from a changed release selection', () => {
    const exact = admitAppSavedPlanAuthority(
      {
        evidence: evidence({ applyable: false, semanticChange: false }),
        authority: normalAuthority(),
        releaseComparison: releaseComparison(true),
      },
      TARGET.targetKey,
    );
    const changed = admitAppSavedPlanAuthority(
      {
        evidence: evidence({ applyable: false, semanticChange: false }),
        authority: normalAuthority(),
        releaseComparison: releaseComparison(false),
      },
      TARGET.targetKey,
    );

    expect(exact.disposition).toBe('EMPTY_PLAN_SKIP');
    expect(changed.disposition).toBe('REVIEWABLE');
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: false, semanticChange: false }),
          authority: normalAuthority(),
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/release comparison/iu);
  });

  it('admits rollback through the same execution-authority identity and keeps every decision reviewable', () => {
    for (const semanticChange of [true, false]) {
      const admitted = admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: semanticChange, mode: 'rollback', semanticChange }),
          authority: rollbackAuthority(),
          releaseComparison: null,
        },
        TARGET.targetKey,
      );

      expect(admitted.disposition).toBe('REVIEWABLE');
      expect(admitted.authority).not.toHaveProperty('appDeploymentRecord');
      expect(admitted.authority).not.toHaveProperty('executionIdentitySha256');
    }
  });

  it('admits the incomplete normal verifier preflight only as reviewable', () => {
    const admitted = admitAppSavedPlanAuthority(
      {
        evidence: evidence({ applyable: true, gate: 'verifier-preflight', semanticChange: true }),
        authority: preflightAuthority(),
        releaseComparison: null,
      },
      TARGET.targetKey,
    );

    expect(admitted.disposition).toBe('REVIEWABLE');
    expect(admitted.authority['zkvmContractHash']).toBe(releaseFacts().zkvmContractHash);
  });

  it('rejects detached, obsolete, accessor, and proxied authority without invoking user code', () => {
    const detached = normalAuthority() as Data;
    detached['selectedSourceSha'] = '0'.repeat(40);
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: detached,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/source/iu);

    const obsolete = {
      ...normalAuthority(),
      appDeploymentRecord: {
        key: 'obsolete/app-deployment-record.json',
        versionId: 'obsolete-version',
        sha256: 'f'.repeat(64),
      },
    };
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: obsolete,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/exact current shape/iu);

    const getter = vi.fn(() => normalAuthority());
    const accessor = Object.defineProperty(
      {
        evidence: evidence({ applyable: true, semanticChange: true }),
        releaseComparison: null,
      },
      'authority',
      { enumerable: true, get: getter },
    );
    expect(() => admitAppSavedPlanAuthority(accessor, TARGET.targetKey)).toThrow(/data|shape/iu);
    expect(getter).not.toHaveBeenCalled();

    const trap = vi.fn(() => []);
    const proxy = new Proxy(normalAuthority(), { ownKeys: trap });
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: proxy,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/proxy/iu);
    expect(trap).not.toHaveBeenCalled();
  });

  it('binds both modes to the canonical execution-authority deployment identity', () => {
    const detachedAuthority = normalAuthority() as Data;
    detachedAuthority['appExecutionAuthoritySha256'] = '0'.repeat(64);
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: detachedAuthority,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/deployment identity/iu);

    const detachedIdentity = { ...normalAuthority(), deploymentId: `dep_${'0'.repeat(32)}` };
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: detachedIdentity,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/deployment identity/iu);

    const detachedRollback = rollbackAuthority() as Data;
    detachedRollback['appExecutionAuthoritySha256'] = '0'.repeat(64);
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, mode: 'rollback', semanticChange: true }),
          authority: detachedRollback,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/deployment identity/iu);
  });

  it('rejects evidence outside the parser bounds and noncanonical verifier hashes', () => {
    const aggregateOverflow = evidence({ applyable: true, semanticChange: true });
    const overflowSummary = aggregateOverflow.summary as Data;
    overflowSummary['actionCounts'] = {
      create: 2_500,
      update: 2_500,
      replace: 2_500,
      delete: 2_500,
      readOnly: 2_500,
    };
    const changed = (overflowSummary['changedAddresses'] as Data[])[0];
    if (changed === undefined) throw new Error('changed-address fixture is missing');
    changed['actionClasses'] = ['create', 'update', 'replace', 'delete', 'read-only'];
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: aggregateOverflow,
          authority: normalAuthority(),
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/action count.*bound/iu);

    const oversizedAddress = evidence({ applyable: true, semanticChange: true });
    const oversizedSummary = oversizedAddress.summary as Data;
    const oversizedChange = (oversizedSummary['changedAddresses'] as Data[])[0];
    if (oversizedChange === undefined) throw new Error('changed-address fixture is missing');
    oversizedChange['address'] = `aws_lambda_function.${'x'.repeat(1_025)}`;
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: oversizedAddress,
          authority: normalAuthority(),
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/address.*bound/iu);

    const oversizedFunction = { ...normalAuthority(), verifierFunctionVersion: '1'.repeat(33) };
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, semanticChange: true }),
          authority: oversizedFunction,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/function version.*invalid/iu);

    const noncanonicalHash = preflightAuthority() as Data;
    const encoded = String(noncanonicalHash['sourceCodeHash']);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const finalIndex = alphabet.indexOf(encoded.at(-2) ?? '');
    if (finalIndex < 0 || finalIndex % 4 !== 0) throw new Error('canonical base64 fixture is invalid');
    noncanonicalHash['sourceCodeHash'] = `${encoded.slice(0, -2)}${alphabet[finalIndex + 1]}=`;
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: evidence({ applyable: true, gate: 'verifier-preflight', semanticChange: true }),
          authority: noncanonicalHash,
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/source-code hash.*invalid/iu);
  });

  it('matches the saved-plan parser domains for redacted names, checks, and method identity', () => {
    const acceptedEvidence = evidence({ applyable: true, semanticChange: true });
    const acceptedSummary = acceptedEvidence.summary as Data;
    const changed = (acceptedSummary['changedAddresses'] as Data[])[0];
    if (changed === undefined) throw new Error('changed-address fixture is missing');
    changed['address'] = 'aws_lambda_function.public_api[*]';
    acceptedSummary['drift'] = {
      count: 1,
      names: ['aws_lambda_function.public_api[*]'],
      omittedNameCount: 0,
    };
    acceptedSummary['outputChanges'] = { count: 1, names: ['-current-status'], omittedNameCount: 0 };
    acceptedSummary['checkStatusCounts'] = { pass: 6_000, unknown: 4_000, fail: 0, error: 0 };
    const authority = { ...normalAuthority(), methodVersion: Number.MAX_SAFE_INTEGER };

    expect(
      admitAppSavedPlanAuthority({ evidence: acceptedEvidence, authority, releaseComparison: null }, TARGET.targetKey),
    ).toMatchObject({ disposition: 'REVIEWABLE', authority: { methodVersion: Number.MAX_SAFE_INTEGER } });

    const overflowEvidence = evidence({ applyable: true, semanticChange: true });
    (overflowEvidence.summary as Data)['checkStatusCounts'] = { pass: 6_000, unknown: 4_001, fail: 0, error: 0 };
    expect(() =>
      admitAppSavedPlanAuthority(
        {
          evidence: overflowEvidence,
          authority: normalAuthority(),
          releaseComparison: null,
        },
        TARGET.targetKey,
      ),
    ).toThrow(/check count.*bound/iu);
  });
});

it('requires manual review for production normal, rollback, and verifier plans within their target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const targets = await import('./index.js');
    const plans = await import('./app-saved-plan-authority.js');
    const production = targets.resolveAllowedDeploymentTarget('stark-prod/main');
    const lane = targets.resolveDeploymentLaneAuthority(production, 'app');
    for (const mode of ['normal', 'rollback', 'verifier-preflight'] as const) {
      const preflight = mode === 'verifier-preflight';
      const baseEvidence = evidence({
        applyable: preflight,
        semanticChange: preflight,
        mode: mode === 'rollback' ? 'rollback' : 'normal',
        gate: preflight ? 'verifier-preflight' : 'terraform',
      });
      const originalAuthority = preflight
        ? preflightAuthority()
        : mode === 'rollback'
          ? rollbackAuthority()
          : normalAuthority();
      const projected = JSON.parse(
        JSON.stringify(originalAuthority).replaceAll('stark-dev/develop', 'stark-prod/main'),
      ) as Data;
      if (preflight) {
        const facts = {
          ...releaseFacts(),
          foundationAcceptanceKey: FOUNDATION_ACCEPTANCE_KEY.replace('stark-dev/develop', 'stark-prod/main'),
        };
        projected['releaseAuthoritySha256'] = canonicalJsonSha256(facts);
        projected['package'] = {
          ...preflightAuthority().package,
          key: `${lane.names.lambdaArtifactPrefix}/${SELECTED_SOURCE_SHA}/image-signature-verifier.zip`,
        };
      }
      const input = {
        evidence: {
          ...baseEvidence,
          context: {
            ...baseEvidence.context,
            accountId: production.accountId,
            region: production.region,
            deploymentEnvironment: production.environmentId,
            stateIdentity: lane.stateIdentity,
            backendKey: lane.backendKey,
          },
          approval: {
            ...baseEvidence.approval,
            accountId: production.accountId,
            deploymentEnvironment: production.environmentId,
          },
        },
        authority: projected,
        releaseComparison: null,
      };
      const result = plans.admitAppSavedPlanAuthority(input, production.targetKey);
      expect(result.disposition).toBe('REVIEWABLE');
      expect(result.authority).toEqual(projected);
      for (const wrongTarget of [undefined, 'unreviewed/main', TARGET.targetKey]) {
        expect(() => plans.admitAppSavedPlanAuthority(input, wrongTarget)).toThrow();
      }
      expect(() =>
        plans.admitAppSavedPlanAuthority({ ...input, authority: originalAuthority }, production.targetKey),
      ).toThrow();
      expect(() =>
        plans.admitAppSavedPlanAuthority(
          { ...input, releaseComparison: releaseComparison(true) },
          production.targetKey,
        ),
      ).toThrow();
      expect(() =>
        plans.admitAppSavedPlanAuthority({ ...input, evidence: baseEvidence }, production.targetKey),
      ).toThrow('expected target');
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
