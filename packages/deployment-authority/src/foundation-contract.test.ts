import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_CONTRACT_CLOSURE_IDENTITY,
  FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY,
  admitFoundationSourceContract,
  computeFoundationSourceContract,
  isFoundationContractDependencyPath,
} from './foundation-contract.js';
import { canonicalJsonSha256 } from './internal.js';

const NONSECRET_INPUTS = Object.freeze({
  accountAlias: 'stark-dev',
  awsAccountId: '123456789012',
  awsRegion: 'ap-northeast-1',
  deploymentEnvironment: 'develop',
  deploymentTargetKey: 'stark-dev/develop',
  projectName: 'stark-ballot-simulator',
  publicHostnameDisposition: 'external-dns-acm',
  stateBackendKey: 'terraform/stark-dev/develop/foundation.tfstate',
  stateScope: 'foundation',
});

interface RepositoryFileObservation {
  readonly bytes: Uint8Array | null;
  readonly path: string;
  readonly readable: boolean;
  readonly tracked: boolean;
  readonly type: 'file' | 'other' | 'symlink';
}

interface DependencyObservation {
  readonly fromPath: string;
  readonly resolution: 'resolved-repository-file' | 'unresolved-dynamic';
  readonly specifier: string;
  readonly toPath: string | null;
}

interface RepositoryObservation {
  readonly dependencies: readonly DependencyObservation[];
  readonly files: readonly RepositoryFileObservation[];
  readonly nonsecretInputs: typeof NONSECRET_INPUTS;
  readonly observationType: 'foundation-contract-repository-observation';
  readonly repositorySnapshotComplete: true;
}

function file(path: string, content = `fixture:${path}\n`): RepositoryFileObservation {
  return {
    bytes: new TextEncoder().encode(content),
    path,
    readable: true,
    tracked: true,
    type: 'file',
  };
}

function requiredFiles(): RepositoryFileObservation[] {
  return FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.exactPaths.map((path) => file(path));
}

function observation(overrides: Partial<RepositoryObservation> = {}): RepositoryObservation {
  const foundationRoot = file('infra/terraform/foundation/example.tf', 'resource "example" "fixture" {}\n');
  const files = [...requiredFiles(), foundationRoot, file('apps/web/src/app-only.ts', 'export const label = "one";\n')];
  return {
    dependencies: [
      {
        fromPath: 'infra/lambdas/ecr-retention/index.ts',
        resolution: 'resolved-repository-file',
        specifier: './handler.js',
        toPath: 'infra/lambdas/ecr-retention/handler.ts',
      },
    ],
    files: files.concat(file('infra/lambdas/ecr-retention/handler.ts')),
    nonsecretInputs: NONSECRET_INPUTS,
    observationType: 'foundation-contract-repository-observation',
    repositorySnapshotComplete: true,
    ...overrides,
  };
}

function replaceFile(
  input: RepositoryObservation,
  path: string,
  replacement: RepositoryFileObservation,
): RepositoryObservation {
  return {
    ...input,
    files: input.files.map((entry) => (entry.path === path ? replacement : entry)),
  };
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} is missing from the fixture`);
  }
  return value;
}

describe('Foundation source contract', () => {
  it('takes one recursive data snapshot before reading adversarial proxy inputs', () => {
    const expectedInput = observation();
    let propertyReads = 0;
    const proxiedFiles = new Proxy(
      expectedInput.files.map(
        (entry) =>
          new Proxy(entry, {
            get() {
              propertyReads += 1;
              return 'forged-after-admission';
            },
          }),
      ),
      {
        get() {
          propertyReads += 1;
          return 'forged-after-admission';
        },
      },
    );
    const proxiedInputs = new Proxy(expectedInput.nonsecretInputs, {
      get() {
        propertyReads += 1;
        return 'forged-after-admission';
      },
    });
    const adversarial = new Proxy(
      {
        ...expectedInput,
        files: proxiedFiles,
        nonsecretInputs: proxiedInputs,
      },
      {
        get() {
          propertyReads += 1;
          return 'forged-after-admission';
        },
      },
    );

    expect(computeFoundationSourceContract(adversarial)).toEqual(computeFoundationSourceContract(expectedInput));
    expect(propertyReads).toBe(0);
  });

  it('keeps the executable dependency inventory uniquely path-sorted', () => {
    const exactPaths = [...FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.exactPaths];
    expect(Object.keys(FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY)).toEqual(['exactPaths', 'inventoryType', 'rules']);
    expect(exactPaths).toEqual([...new Set(exactPaths)].sort((left, right) => left.localeCompare(right)));
    expect(exactPaths).toContain('packages/deployment-authority/src/terraform-authority.js');
    expect(exactPaths).toContain('packages/deployment-authority/src/terraform-acceptance-selection.js');
    expect(exactPaths).not.toContain('packages/deployment-authority/src/terraform-baseline.js');
  });

  it('hashes selected raw bytes and canonical nonsecret inputs in stable path order', () => {
    const input = observation();
    const first = computeFoundationSourceContract(input);
    const reordered = computeFoundationSourceContract({
      ...input,
      dependencies: [...input.dependencies].reverse(),
      files: [...input.files].reverse(),
      nonsecretInputs: {
        stateScope: 'foundation',
        projectName: 'stark-ballot-simulator',
        awsRegion: 'ap-northeast-1',
        accountAlias: 'stark-dev',
        deploymentTargetKey: 'stark-dev/develop',
        publicHostnameDisposition: 'external-dns-acm',
        stateBackendKey: 'terraform/stark-dev/develop/foundation.tfstate',
        deploymentEnvironment: 'develop',
        awsAccountId: '123456789012',
      },
    });

    expect(first.closureIdentity).toBe(FOUNDATION_CONTRACT_CLOSURE_IDENTITY);
    expect(first.foundationContractHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);

    const changedBytes = computeFoundationSourceContract(
      replaceFile(
        input,
        'infra/terraform/foundation/example.tf',
        file('infra/terraform/foundation/example.tf', 'resource "example" "changed" {}\n'),
      ),
    );
    const changedLineEndings = computeFoundationSourceContract(
      replaceFile(
        input,
        'infra/terraform/foundation/example.tf',
        file('infra/terraform/foundation/example.tf', 'resource "example" "fixture" {}\r\n'),
      ),
    );
    const changedInput = computeFoundationSourceContract({
      ...input,
      nonsecretInputs: { ...NONSECRET_INPUTS, publicHostnameDisposition: 'generated-cloudfront-hostname' },
    });

    expect(changedBytes.foundationContractHash).not.toBe(first.foundationContractHash);
    expect(changedLineEndings.foundationContractHash).not.toBe(first.foundationContractHash);
    expect(changedInput.foundationContractHash).not.toBe(first.foundationContractHash);
  });

  it('keeps an app-only source change outside the reviewed closure hash-stable', () => {
    const input = observation();
    const changedAppSource = replaceFile(
      input,
      'apps/web/src/app-only.ts',
      file('apps/web/src/app-only.ts', 'export const label = "two";\n'),
    );

    expect(computeFoundationSourceContract(changedAppSource)).toEqual(computeFoundationSourceContract(input));
  });

  it('changes for every reviewed dependency family and admits no broad source family', () => {
    expect(FOUNDATION_CONTRACT_CLOSURE_IDENTITY).toBe(canonicalJsonSha256(FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY));
    expect(isFoundationContractDependencyPath('infra/terraform/foundation/new-resource.tf')).toBe(true);
    expect(isFoundationContractDependencyPath('infra/terraform/foundation/generated.tf.json')).toBe(true);
    expect(isFoundationContractDependencyPath('infra/lambdas/ecr-retention/new-helper.ts')).toBe(true);
    expect(isFoundationContractDependencyPath('infra/terraform/bootstrap/foundation_pipeline_codebuild.tf')).toBe(true);
    expect(
      isFoundationContractDependencyPath('infra/terraform/bootstrap/buildspec-app-publish-current-status.yml'),
    ).toBe(true);
    expect(
      isFoundationContractDependencyPath('infra/terraform/bootstrap/app-status-scripts/publish-current-app-status.sh'),
    ).toBe(true);
    expect(
      isFoundationContractDependencyPath('infra/terraform/bootstrap/app-pipeline-scripts/read-stable-local-file.mjs'),
    ).toBe(true);
    expect(
      isFoundationContractDependencyPath('packages/deployment-authority/src/app-status-pipeline-authority.js'),
    ).toBe(true);
    expect(isFoundationContractDependencyPath('packages/deployment-authority/src/source-path-build-authority.js')).toBe(
      true,
    );
    expect(
      isFoundationContractDependencyPath('packages/deployment-authority/src/static-frontend-publication-lease.js'),
    ).toBe(false);
    expect(isFoundationContractDependencyPath('packages/deployment-authority/src/app-pipeline-composition.js')).toBe(
      false,
    );
    expect(
      isFoundationContractDependencyPath('infra/terraform/bootstrap/foundation_pipeline_signing_authority_resolver.tf'),
    ).toBe(true);
    expect(isFoundationContractDependencyPath('infra/terraform/bootstrap/terraform_drift_start_proxy.tf')).toBe(false);
    expect(isFoundationContractDependencyPath('infra/terraform/bootstrap/terraform-drift-start-package.json')).toBe(
      false,
    );
    expect(isFoundationContractDependencyPath('infra/lambdas/terraform-drift-start/index.ts')).toBe(false);
    expect(isFoundationContractDependencyPath('scripts/build/build-terraform-drift-start-lambda.mjs')).toBe(false);
    expect(isFoundationContractDependencyPath('infra/terraform/bootstrap/terraform-drift-start-package.zip')).toBe(
      false,
    );
    for (const bootstrapOnlyPath of [
      'infra/terraform/bootstrap/buildspec-bootstrap-apply.yml',
      'infra/terraform/bootstrap/buildspec-bootstrap-plan.yml',
      'infra/terraform/bootstrap/buildspec-bootstrap-smoke.yml',
      'infra/terraform/bootstrap/source-path-build-scripts/bootstrap-apply.sh',
      'infra/terraform/bootstrap/source-path-build-scripts/bootstrap-plan.sh',
      'infra/terraform/bootstrap/source-path-build-scripts/bootstrap-smoke.sh',
      'infra/terraform/bootstrap/source-path-build-scripts/materialize-bootstrap-plan-inputs.mjs',
    ]) {
      expect(isFoundationContractDependencyPath(bootstrapOnlyPath), bootstrapOnlyPath).toBe(false);
    }
    expect(isFoundationContractDependencyPath('apps/web/src/routes/vote/page.tsx')).toBe(false);
    expect(isFoundationContractDependencyPath('infra/terraform/app/main.tf')).toBe(false);
    expect(isFoundationContractDependencyPath('infra/lambdas/ecr-retention/handler.test.ts')).toBe(false);
    for (const retiredPath of [
      'infra/terraform/bootstrap/foundation-pipeline-scripts/publish-foundation-app-networking.mjs',
      'infra/terraform/bootstrap/foundation-pipeline-scripts/publish-foundation-image-signing-authority.mjs',
      'infra/terraform/bootstrap/terraform-drift-scripts/publish-accepted-terraform-baseline.mjs',
      'infra/terraform/bootstrap/terraform-drift-scripts/write-terraform-baseline-acceptance.mjs',
    ]) {
      expect(isFoundationContractDependencyPath(retiredPath), retiredPath).toBe(false);
    }
  });

  it('fails closed for a discovered repository dependency outside the inventory', () => {
    const input = observation({
      dependencies: [
        {
          fromPath: 'infra/lambdas/ecr-retention/index.ts',
          resolution: 'resolved-repository-file',
          specifier: '../../../apps/api/src/unsafe.ts',
          toPath: 'apps/api/src/unsafe.ts',
        },
      ],
      files: observation().files.concat(file('apps/api/src/unsafe.ts')),
    });

    expect(() => computeFoundationSourceContract(input)).toThrow(/outside the Foundation contract inventory/u);
  });

  it.each([
    ['untracked', { tracked: false }],
    ['unreadable', { bytes: null, readable: false }],
    ['symlink', { bytes: null, type: 'symlink' }],
    ['non-file', { bytes: null, type: 'other' }],
  ] as const)('rejects a selected %s dependency', (_label, mutation) => {
    const input = observation();
    const target = requireDefined(
      input.files.find(({ path }) => path === 'infra/terraform/foundation/example.tf'),
      'selected Foundation dependency',
    );
    const replacement = { ...target, ...mutation } as RepositoryFileObservation;

    expect(() =>
      computeFoundationSourceContract(replaceFile(input, 'infra/terraform/foundation/example.tf', replacement)),
    ).toThrow();
  });

  it('rejects missing required files, duplicate or non-normal paths, and unresolved dynamic dependencies', () => {
    const input = observation();
    expect(() =>
      computeFoundationSourceContract({
        ...input,
        files: input.files.filter(({ path }) => path !== FOUNDATION_CONTRACT_DEPENDENCY_INVENTORY.exactPaths[0]),
      }),
    ).toThrow(/required Foundation contract dependency is missing/u);
    const firstFile = requireDefined(input.files[0], 'first repository file');
    expect(() => computeFoundationSourceContract({ ...input, files: input.files.concat(firstFile) })).toThrow(
      /duplicate repository path/u,
    );
    expect(() =>
      computeFoundationSourceContract({
        ...input,
        files: input.files.concat(file('infra/terraform/foundation/../outside.tf')),
      }),
    ).toThrow(/repository.*path/u);
    expect(() =>
      computeFoundationSourceContract({
        ...input,
        dependencies: [
          {
            fromPath: 'scripts/build/build-ecr-retention-lambda.mjs',
            resolution: 'unresolved-dynamic',
            specifier: 'dynamic-source',
            toPath: null,
          },
        ],
      }),
    ).toThrow(/unresolved dependency/u);
  });

  it('rejects unknown, hidden, accessor, symbol, and secret-shaped observation fields', () => {
    const withSecret = { ...observation(), secretValue: 'must-not-enter-a-contract' };
    expect(() => computeFoundationSourceContract(withSecret)).toThrow(/exactly/u);

    const accessorInputs = { ...NONSECRET_INPUTS } as Record<string, unknown>;
    Object.defineProperty(accessorInputs, 'awsRegion', {
      enumerable: true,
      get: () => 'ap-northeast-1',
    });
    expect(() => computeFoundationSourceContract({ ...observation(), nonsecretInputs: accessorInputs })).toThrow(
      /enumerable data|exactly/u,
    );

    const hidden = { ...observation() };
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: 'not admitted' });
    expect(() => computeFoundationSourceContract(hidden)).toThrow(/enumerable data|exactly/u);

    const symbolKey = { ...observation(), [Symbol('authority')]: true };
    expect(() => computeFoundationSourceContract(symbolKey)).toThrow(/enumerable data|exactly/u);
  });

  it('strictly admits only the current exact source-contract observation', () => {
    const computed = computeFoundationSourceContract(observation());
    expect(admitFoundationSourceContract(computed)).toEqual(computed);
    expect(admitFoundationSourceContract(computed)).not.toBe(computed);
    expect(Object.isFrozen(admitFoundationSourceContract(computed))).toBe(true);

    expect(() => admitFoundationSourceContract({ ...computed, sourceSha: 'a'.repeat(40) })).toThrow(/exactly/u);
    expect(() => admitFoundationSourceContract({ ...computed, closureIdentity: '0'.repeat(64) })).toThrow(
      /closure identity/u,
    );
    expect(() => admitFoundationSourceContract({ ...computed, foundationContractHash: 'A'.repeat(64) })).toThrow(
      /Foundation contract hash/u,
    );

    const accessor = { ...computed };
    Object.defineProperty(accessor, 'foundationContractHash', {
      enumerable: true,
      get: () => computed.foundationContractHash,
    });
    expect(() => admitFoundationSourceContract(accessor)).toThrow(/enumerable data|exactly/u);
  });
});
