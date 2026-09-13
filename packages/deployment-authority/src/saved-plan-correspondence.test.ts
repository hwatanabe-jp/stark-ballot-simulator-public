import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJsonSha256, canonicalRecordJson } from './internal.js';
import { renderDeploymentLaneContext, resolveAllowedDeploymentTarget } from './index.js';
import { admitSavedPlanCorrespondence, buildSavedPlanCorrespondence } from './saved-plan-correspondence.js';
import { classifySavedPlanDisposition } from './saved-plan-disposition.js';
import { buildSavedPlanFixture } from './testdata/saved-plan-fixture.js';

const TARGET = resolveAllowedDeploymentTarget('stark-dev/develop');
const ACCOUNT_ID = TARGET.accountId;
const SOURCE_SHA = 'a'.repeat(40);
const ROLLBACK_SOURCE_SHA = 'b'.repeat(40);
const PIPELINE_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const PLAN_ACTION_EXECUTION_ID = '33333333-4444-4555-8666-777777777777';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureFromShared(options: Parameters<typeof buildSavedPlanFixture>[0]) {
  const prepared = buildSavedPlanFixture(options);
  const input = { ...prepared.correspondence.expected, files: prepared.correspondence.files };
  return {
    input,
    review: input.contract.review,
    targetContext: prepared.targetContext,
    resolvedInputs: input.resolvedInputs,
  };
}

function fixture(lane: 'bootstrap' | 'foundation' = 'bootstrap') {
  return fixtureFromShared({ lane });
}

function appFixture(options: { deploymentMode?: 'normal' | 'rollback'; selectedSourceSha?: string } = {}) {
  const prepared = fixtureFromShared({ lane: 'app', ...options });
  if (prepared.resolvedInputs === null) {
    throw new Error('App saved-plan fixture must include resolved inputs.');
  }
  return { ...prepared, resolvedInputs: prepared.resolvedInputs };
}

function appPreflightFixture() {
  const prepared = fixtureFromShared({ lane: 'app', gate: 'verifier-preflight' });
  if (prepared.resolvedInputs === null) {
    throw new Error('App verifier-preflight fixture must include resolved inputs.');
  }
  return { ...prepared, resolvedInputs: prepared.resolvedInputs };
}

function appNoOpFixture() {
  const prepared = fixtureFromShared({ lane: 'app', semanticChange: false });
  if (prepared.resolvedInputs === null) {
    throw new Error('App empty-plan fixture must include resolved inputs.');
  }
  return { ...prepared, resolvedInputs: prepared.resolvedInputs };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('saved-plan correspondence', () => {
  it.each([
    {
      name: 'Bootstrap Terraform',
      fixture: () => fixture(),
      lane: 'bootstrap',
      gate: 'terraform',
      actionName: 'Plan',
    },
    {
      name: 'Foundation Terraform',
      fixture: () => fixture('foundation'),
      lane: 'foundation',
      gate: 'terraform',
      actionName: 'PlanFoundationState',
    },
    {
      name: 'App verifier preflight',
      fixture: appPreflightFixture,
      lane: 'app',
      gate: 'verifier-preflight',
      actionName: 'PlanVerifierPreflight',
    },
    {
      name: 'App Terraform',
      fixture: appFixture,
      lane: 'app',
      gate: 'terraform',
      actionName: 'PlanAppState',
    },
  ])('builds the governed correspondence for $name', ({ fixture: createFixture, lane, gate, actionName }) => {
    const { input } = createFixture();

    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);

    expect(correspondence.target).toMatchObject({ lane, gate });
    expect(correspondence.execution.planActionName).toBe(actionName);
    expect(correspondence.contract.disposition).toBe('REVIEWABLE');
  });

  it('binds an App rollback to the exact selected application source', () => {
    const { input } = appFixture({ deploymentMode: 'rollback', selectedSourceSha: ROLLBACK_SOURCE_SHA });

    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);

    expect(correspondence.source.selectedApplicationSourceSha).toBe(ROLLBACK_SOURCE_SHA);
    expect(correspondence.contract.disposition).toBe('REVIEWABLE');
  });

  it('binds one exact saved binary to its semantic view and execution authority', () => {
    const { input, review, targetContext } = fixture();

    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);

    expect(correspondence).toMatchObject({
      contract: {
        disposition: 'REVIEWABLE',
        review,
      },
      target: {
        targetKey: 'stark-dev/develop',
        targetConfigurationSha256: targetContext.targetConfigurationSha256,
        targetContextSha256: canonicalJsonSha256(targetContext),
        lane: 'bootstrap',
        gate: 'terraform',
      },
      execution: {
        pipelineExecutionId: PIPELINE_EXECUTION_ID,
        planStageName: 'TerraformPlan',
        planActionName: 'Plan',
        planActionExecutionId: PLAN_ACTION_EXECUTION_ID,
      },
      resolvedInputs: null,
      files: {
        tfplan: { byteLength: input.files.tfplan.byteLength, sha256: sha256(input.files.tfplan) },
        tfplanJson: { byteLength: input.files.tfplanJson.byteLength, sha256: sha256(input.files.tfplanJson) },
      },
    });
    expect(Object.isFrozen(correspondence)).toBe(true);
    expect(Object.isFrozen(correspondence.files)).toBe(true);
  });

  it('admits only the canonical manifest body with its exact expected inputs and files', () => {
    const { input } = fixture();
    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);
    const manifestBody = Buffer.from(canonicalRecordJson(correspondence));
    const { files, ...expected } = input;

    const admitted = admitSavedPlanCorrespondence(
      {
        manifestBody,
        expected,
        files,
      },
      TARGET.targetKey,
    );

    expect(admitted).toEqual(correspondence);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(() =>
      admitSavedPlanCorrespondence(
        {
          manifestBody: Buffer.from(JSON.stringify(correspondence)),
          expected,
          files,
        },
        TARGET.targetKey,
      ),
    ).toThrow('does not match its expected authority');
  });

  it('binds the closed App release chain and recomputes its content hash', () => {
    const { input, resolvedInputs } = appFixture();

    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);

    expect(correspondence.resolvedInputs).toEqual(resolvedInputs);
    expect(Object.isFrozen(correspondence.resolvedInputs)).toBe(true);
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          resolvedInputs: { ...resolvedInputs, releaseChainSha256: '0'.repeat(64) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('detached from its immutable inputs');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          resolvedInputs: { ...resolvedInputs, foundationAcceptanceKey: 'outside/foundation.json' },
        },
        TARGET.targetKey,
      ),
    ).toThrow('outside its exact namespace');
  });

  it('proves the empty-plan disposition against the current accepted release chain', () => {
    const { input, resolvedInputs } = appNoOpFixture();

    expect(buildSavedPlanCorrespondence(input, TARGET.targetKey).contract.disposition).toBe('EMPTY_PLAN_SKIP');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          resolvedInputs: { ...resolvedInputs, currentAcceptedReleaseChainSha256: '0'.repeat(64) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('release chains do not match');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          resolvedInputs: { ...resolvedInputs, currentAcceptedReleaseChainSha256: null },
        },
        TARGET.targetKey,
      ),
    ).toThrow('release chain');
  });

  it('rejects a forged skip and unused current-acceptance hash on a reviewable plan', () => {
    const { input, resolvedInputs } = appFixture();

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          contract: { ...input.contract, disposition: 'EMPTY_PLAN_SKIP' },
        },
        TARGET.targetKey,
      ),
    ).toThrow('detached from its semantic review');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          resolvedInputs: {
            ...resolvedInputs,
            currentAcceptedReleaseChainSha256: resolvedInputs.releaseChainSha256,
          },
        },
        TARGET.targetKey,
      ),
    ).toThrow('must be null for a reviewable plan');
  });

  it('rejects a semantic view that understates the exact Terraform plan JSON', () => {
    const { input } = fixture();
    const planJson = JSON.parse(Buffer.from(input.files.tfplanJson).toString('utf8')) as {
      resource_changes: unknown[];
    };
    planJson.resource_changes.push({
      address: 'aws_s3_bucket.detached',
      change: {
        actions: ['update'],
        before: {},
        after: {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    });
    const tfplanJson = Buffer.from(canonicalRecordJson(planJson));
    const review = mutableRecord(structuredClone(input.contract.review));
    mutableRecord(review['summary'])['planJsonSha256'] = sha256(tfplanJson);
    const contract = classifySavedPlanDisposition({ appReleaseChain: null, review }, TARGET.targetKey);

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          contract,
          files: {
            ...input.files,
            tfplanJson,
          },
        },
        TARGET.targetKey,
      ),
    ).toThrow('exact Terraform plan');
  });

  it('rejects an empty-plan skip view when the exact Terraform plan JSON contains a change', () => {
    const { input, resolvedInputs } = appNoOpFixture();
    const planJson = JSON.parse(Buffer.from(input.files.tfplanJson).toString('utf8')) as {
      resource_changes: unknown[];
    };
    planJson.resource_changes.push({
      address: 'aws_s3_bucket.detached',
      change: {
        actions: ['update'],
        before: {},
        after: {},
        before_sensitive: {},
        after_sensitive: {},
        after_unknown: {},
      },
    });
    const tfplanJson = Buffer.from(canonicalRecordJson(planJson));
    const review = mutableRecord(structuredClone(input.contract.review));
    mutableRecord(review['summary'])['planJsonSha256'] = sha256(tfplanJson);
    const contract = classifySavedPlanDisposition(
      {
        review,
        appReleaseChain: {
          deploymentMode: 'normal',
          selectedReleaseChainSha256: resolvedInputs.releaseChainSha256,
          currentAcceptedReleaseChainSha256: resolvedInputs.currentAcceptedReleaseChainSha256,
        },
      },
      TARGET.targetKey,
    );

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          contract,
          files: {
            ...input.files,
            tfplanJson,
          },
        },
        TARGET.targetKey,
      ),
    ).toThrow('exact Terraform plan');
  });

  it('rejects deep Terraform change values and wide plan collections through parser-owned bounds', () => {
    for (const shape of ['deep', 'wide'] as const) {
      const { input } = fixture();
      const planJson = JSON.parse(Buffer.from(input.files.tfplanJson).toString('utf8')) as Record<string, unknown>;
      if (shape === 'deep') {
        let nested: Record<string, unknown> = {};
        for (let depth = 0; depth < 70; depth += 1) nested = { nested };
        const resource = (planJson['resource_changes'] as Array<Record<string, unknown>>)[0];
        if (resource === undefined) throw new Error('Missing fixture resource change.');
        mutableRecord(mutableRecord(resource)['change'])['before'] = nested;
      } else {
        planJson['checks'] = Array.from({ length: 10_001 }, () => ({ status: 'pass' }));
      }
      const tfplanJson = Buffer.from(canonicalRecordJson(planJson));
      const review = mutableRecord(structuredClone(input.contract.review));
      mutableRecord(review['summary'])['planJsonSha256'] = sha256(tfplanJson);
      const contract = classifySavedPlanDisposition({ appReleaseChain: null, review }, TARGET.targetKey);

      expect(() =>
        buildSavedPlanCorrespondence(
          {
            ...input,
            contract,
            files: {
              ...input.files,
              tfplanJson,
            },
          },
          TARGET.targetKey,
        ),
      ).toThrow('exact Terraform plan');
    }
  });

  it('rejects a deeply nested inline runtime identity value without recursively snapshotting it', () => {
    const { input } = fixture();
    const runtime = structuredClone(input.runtime) as Record<string, unknown>;
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 256; depth += 1) nested = { nested };
    mutableRecord(runtime['runtime'])['configuredImage'] = nested;

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          runtime,
        },
        TARGET.targetKey,
      ),
    ).toThrow('runtime');
  });

  it('rejects an App rollback review detached from the selected application source', () => {
    const { input } = appFixture();
    const review = mutableRecord(structuredClone(input.contract.review));
    const approval = mutableRecord(review['approval']);
    const authority = mutableRecord(review['authority']);
    approval['deploymentMode'] = 'rollback';
    approval['selectedSourceSha'] = ROLLBACK_SOURCE_SHA;
    authority['deploymentMode'] = 'rollback';
    authority['selectedSourceSha'] = ROLLBACK_SOURCE_SHA;
    authority['lambdaSourceSha'] = ROLLBACK_SOURCE_SHA;
    const contract = classifySavedPlanDisposition({ appReleaseChain: null, review }, TARGET.targetKey);

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          contract,
        },
        TARGET.targetKey,
      ),
    ).toThrow('selected application source');
  });

  it('rejects verifier authority detached from the selected application source', () => {
    const { input } = appPreflightFixture();
    const targetContext = renderDeploymentLaneContext({
      target: TARGET,
      lane: 'app',
      accountId: ACCOUNT_ID,
      requestedControlSourceSha: SOURCE_SHA,
      selectedApplicationSourceSha: ROLLBACK_SOURCE_SHA,
      frameworkSourceSha: SOURCE_SHA,
    });

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          targetContext,
          source: { ...input.source, selectedApplicationSourceSha: ROLLBACK_SOURCE_SHA },
        },
        TARGET.targetKey,
      ),
    ).toThrow('selected application source');
  });

  it.each(['backend', 'providerLock', 'providerSelections', 'terraformIdentity', 'tfplan', 'tfplanJson'] as const)(
    'rejects changed %s bytes',
    (name) => {
      const { input } = fixture();
      const changed = Buffer.concat([Buffer.from(input.files[name]), Buffer.from('corrupt')]);

      expect(() =>
        buildSavedPlanCorrespondence(
          {
            ...input,
            files: { ...input.files, [name]: changed },
          },
          TARGET.targetKey,
        ),
      ).toThrow();
    },
  );

  it('captures bounded byte arrays atomically without enumerating their indexed descriptors', () => {
    const { input } = fixture();
    const providerSelections = Buffer.alloc(4 * 1024 * 1024, 0x20);
    input.files.providerSelections.copy(providerSelections);
    const exactInput = {
      ...input,
      files: { ...input.files, providerSelections },
      providerIdentity: {
        ...input.providerIdentity,
        providerSelectionsSha256: sha256(providerSelections),
      },
    };
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');

    try {
      expect(buildSavedPlanCorrespondence(exactInput, TARGET.targetKey).files['providerSelections']?.byteLength).toBe(
        4 * 1024 * 1024,
      );
      expect(ownKeys.mock.calls.some(([value]) => value === providerSelections)).toBe(false);
    } finally {
      ownKeys.mockRestore();
    }
  });

  it('cross-binds source, backend, execution, and reviewed runtime identities', () => {
    const { input } = fixture();

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          source: { ...input.source, selectedApplicationSourceSha: SOURCE_SHA },
        },
        TARGET.targetKey,
      ),
    ).toThrow('must not contain a selected application source');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          backend: { ...input.backend, bucketName: 'different-state-bucket' },
        },
        TARGET.targetKey,
      ),
    ).toThrow('detached from its target context');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          execution: {
            ...input.execution,
            buildId: `${input.targetContext.names.terraformPlanProject}:44444444-5555-6666-7777-888888888888`,
          },
        },
        TARGET.targetKey,
      ),
    ).toThrow('detached from its Plan action build');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          terraformIdentity: { ...input.terraformIdentity, terraformVersion: '1.15.9' },
        },
        TARGET.targetKey,
      ),
    ).toThrow('unsupported');
    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          providerIdentity: { ...input.providerIdentity, providerLockSha256: '0'.repeat(64) },
        },
        TARGET.targetKey,
      ),
    ).toThrow('detached from its exact evidence bytes');
  });

  it('rejects raw Terraform identity evidence when its mutable update check reports outdated', () => {
    const { input } = fixture();
    const terraformIdentity = JSON.parse(Buffer.from(input.files.terraformIdentity).toString('utf8')) as Record<
      string,
      unknown
    >;
    const outdatedTerraformIdentity = Buffer.from(
      canonicalRecordJson({ ...terraformIdentity, terraform_outdated: true }),
    );

    expect(() =>
      buildSavedPlanCorrespondence(
        {
          ...input,
          files: { ...input.files, terraformIdentity: outdatedTerraformIdentity },
        },
        TARGET.targetKey,
      ),
    ).toThrow('Saved-plan Terraform identity evidence is unsupported.');
  });

  it('rejects accessors, symbols, unknown fields, and transparent Proxies without invoking them', () => {
    const { input } = fixture();
    const getter = vi.fn(() => input.files);
    const accessor = { ...input };
    Object.defineProperty(accessor, 'files', { enumerable: true, get: getter });
    const symbolBearing = { ...input, [Symbol('hidden')]: true };

    expect(() => buildSavedPlanCorrespondence(accessor, TARGET.targetKey)).toThrow('exact current shape');
    expect(getter).not.toHaveBeenCalled();
    expect(() => buildSavedPlanCorrespondence(symbolBearing, TARGET.targetKey)).toThrow('exact current shape');
    expect(() => buildSavedPlanCorrespondence({ ...input, extra: true }, TARGET.targetKey)).toThrow(
      'exact current shape',
    );
    expect(() => buildSavedPlanCorrespondence(new Proxy(input, {}), TARGET.targetKey)).toThrow(
      'must not contain a Proxy',
    );
    expect(() =>
      buildSavedPlanCorrespondence({ ...input, source: new Proxy(input.source, {}) }, TARGET.targetKey),
    ).toThrow('must not contain a Proxy');
  });

  it('rejects a canonical manifest whose content differs from the expected authority', () => {
    const { input } = fixture();
    const correspondence = buildSavedPlanCorrespondence(input, TARGET.targetKey);
    const altered = structuredClone(correspondence);
    mutableRecord(altered.source)['frameworkSourceSha'] = 'f'.repeat(40);
    const manifestBody = Buffer.from(canonicalRecordJson(altered));
    const { files, ...expected } = input;

    expect(() =>
      admitSavedPlanCorrespondence(
        {
          manifestBody,
          expected,
          files,
        },
        TARGET.targetKey,
      ),
    ).toThrow('does not match its expected authority and files');
  });
});

it('binds production saved-plan bytes, runtime, and resolved inputs to the caller target', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const authority = await import('./saved-plan-correspondence.js');
    const fixtures = await import('./testdata/saved-plan-fixture.js');
    const productionKey = 'stark-prod/main';
    for (const options of [
      { lane: 'bootstrap' },
      { lane: 'foundation' },
      { lane: 'app' },
      { lane: 'app', gate: 'verifier-preflight' },
      { lane: 'app', deploymentMode: 'rollback', selectedSourceSha: 'b'.repeat(40) },
      { lane: 'app', semanticChange: false },
    ] as const) {
      const fixture = fixtures.buildSavedPlanFixture({ ...options, targetKey: productionKey });
      const development = fixtures.buildSavedPlanFixture(options);
      const input = { ...fixture.correspondence.expected, files: fixture.correspondence.files };
      const manifest = authority.buildSavedPlanCorrespondence(input, productionKey);
      expect(canonicalRecordJson(manifest)).toBe(fixture.correspondence.manifestBody.toString('utf8'));
      expect(manifest.target.targetKey).toBe(productionKey);
      expect(manifest.contract.disposition).toBe('REVIEWABLE');
      expect(authority.admitSavedPlanCorrespondence(fixture.correspondence, productionKey)).toEqual(manifest);
      const resolved = { lane: options.lane, resolvedInputs: input.resolvedInputs };
      expect(authority.admitSavedPlanResolvedInputs(resolved, productionKey)).toEqual(input.resolvedInputs);
      for (const wrongTarget of [undefined, 'unreviewed/main', TARGET.targetKey]) {
        expect(() => authority.buildSavedPlanCorrespondence(input, wrongTarget)).toThrow();
        expect(() => authority.admitSavedPlanCorrespondence(fixture.correspondence, wrongTarget)).toThrow();
      }
      expect(() => authority.admitSavedPlanResolvedInputs(resolved, undefined)).toThrow();
      if (options.lane === 'app')
        expect(() => authority.admitSavedPlanResolvedInputs(resolved, TARGET.targetKey)).toThrow();
      for (const field of ['targetContext', 'backend', 'runtime', 'contract'] as const) {
        expect(() =>
          authority.buildSavedPlanCorrespondence(
            { ...input, [field]: development.correspondence.expected[field] },
            productionKey,
          ),
        ).toThrow();
      }
      expect(() =>
        authority.admitSavedPlanCorrespondence(
          { ...fixture.correspondence, manifestBody: development.correspondence.manifestBody },
          productionKey,
        ),
      ).toThrow();
      const changedPlan = Buffer.concat([fixture.correspondence.files.tfplan, Buffer.from('changed')]);
      expect(() =>
        authority.admitSavedPlanCorrespondence(
          { ...fixture.correspondence, files: { ...fixture.correspondence.files, tfplan: changedPlan } },
          productionKey,
        ),
      ).toThrow();
      if (options.lane === 'app') {
        expect(() =>
          authority.buildSavedPlanCorrespondence(
            { ...input, resolvedInputs: development.correspondence.expected.resolvedInputs },
            productionKey,
          ),
        ).toThrow();
      }
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});
