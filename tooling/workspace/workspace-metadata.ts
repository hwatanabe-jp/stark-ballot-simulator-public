import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type WorkspaceRuntimeKind = 'browser' | 'neutral' | 'node';
export type WorkspaceTestEnvironment = 'jsdom' | 'node';

export interface WorkspaceRuntimeProfile {
  readonly runtimeKind: WorkspaceRuntimeKind;
  readonly testEnvironment: WorkspaceTestEnvironment;
}

export type WorkspaceRuntimeProfileTable = Readonly<Record<string, WorkspaceRuntimeProfile>>;

export interface WorkspaceDependencyGroups {
  readonly development: Readonly<Record<string, string>>;
  readonly optional: Readonly<Record<string, string>>;
  readonly peer: Readonly<Record<string, string>>;
  readonly production: Readonly<Record<string, string>>;
}

export interface WorkspaceExport {
  readonly specifier: string;
  readonly subpath: string;
  readonly target: string;
}

export interface WorkspacePackageMetadata extends WorkspaceRuntimeProfile {
  readonly absoluteRoot: string;
  readonly dependencies: WorkspaceDependencyGroups;
  readonly exports: readonly WorkspaceExport[];
  readonly manifestPath: string;
  readonly name: string;
  readonly root: string;
  readonly workspaceDependencies: readonly string[];
}

export interface WorkspaceResolverAlias {
  readonly find: RegExp;
  readonly replacement: string;
  readonly specifier: string;
}

export interface LoadWorkspaceMetadataOptions {
  readonly packageParentDirectories?: readonly string[];
  readonly packageRoots?: readonly string[];
  readonly runtimeProfiles: WorkspaceRuntimeProfileTable;
  readonly workspaceRoot: string;
}

export interface WorkspacePathOwnership {
  readonly packageNames: readonly string[];
  readonly unownedPaths: readonly string[];
}

export interface WorkspaceDerivationSnapshotCheck {
  readonly expected: string;
  readonly matches: boolean;
}

export interface VitestProjectRecord extends WorkspaceRuntimeProfile {
  readonly absoluteRoot: string;
  readonly absoluteRoots: readonly string[];
  readonly environment: WorkspaceTestEnvironment;
  readonly name: string;
  readonly root: string;
  readonly roots: readonly string[];
  readonly source: 'repository-tool' | 'workspace';
}

type WorkspacePackageDraft = Omit<WorkspacePackageMetadata, 'workspaceDependencies'>;

const DEFAULT_PACKAGE_PARENT_DIRECTORIES = ['apps', 'packages'] as const;
const DEFAULT_PACKAGE_ROOTS = ['scripts'] as const;

export const TYPESCRIPT_PATHS_CONFIG_PATH = 'tooling/tsconfig/paths.json';

export const runtimeProfiles = {
  '@stark-ballot/api': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/api-contract': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/application': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/aws-adapters': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/crypto-primitives': { runtimeKind: 'neutral', testEnvironment: 'node' },
  '@stark-ballot/deployment-authority': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/diagnostics': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/domain': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/merkle': { runtimeKind: 'neutral', testEnvironment: 'node' },
  '@stark-ballot/node-adapters': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/repository-tools': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/runtime-config': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/test-support': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/validation': { runtimeKind: 'neutral', testEnvironment: 'node' },
  '@stark-ballot/verification': { runtimeKind: 'node', testEnvironment: 'node' },
  '@stark-ballot/web': { runtimeKind: 'browser', testEnvironment: 'jsdom' },
  '@stark-ballot/zkvm-contract': { runtimeKind: 'node', testEnvironment: 'node' },
} as const satisfies WorkspaceRuntimeProfileTable;

export const repositoryToolProfiles: Readonly<
  Record<string, WorkspaceRuntimeProfile & { readonly roots: readonly string[] }>
> = {
  'repo:infra': {
    roots: ['infra'],
    runtimeKind: 'node',
    testEnvironment: 'node',
  },
  'repo:tooling': {
    roots: ['tooling'],
    runtimeKind: 'node',
    testEnvironment: 'node',
  },
};

export function assertWorkspaceDerivationSnapshot(
  packages: readonly WorkspacePackageMetadata[],
  snapshot: string,
): void {
  if (!checkWorkspaceDerivationSnapshot(packages, snapshot).matches) {
    throw new Error('Workspace derivation snapshot differs from manifest-derived metadata.');
  }
}

export function checkWorkspaceDerivationSnapshot(
  packages: readonly WorkspacePackageMetadata[],
  snapshot: string,
): WorkspaceDerivationSnapshotCheck {
  const expected = renderWorkspaceDerivationSnapshot(packages);
  return { expected, matches: snapshot === expected };
}

export function checkTypeScriptPathsConfig(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
  current: string,
): WorkspaceDerivationSnapshotCheck {
  const expected = renderTypeScriptPathsConfig(packages, workspaceRoot);
  return { expected, matches: current === expected };
}

export function deriveTypescriptPaths(
  packages: readonly WorkspacePackageMetadata[],
): Readonly<Record<string, readonly [string]>> {
  return Object.fromEntries(
    packages.flatMap((workspacePackage) =>
      workspacePackage.exports.map(({ specifier, target }) => [
        specifier,
        [
          `./${toRepoPath(
            path.posix.join(workspacePackage.root, typescriptExportTarget(workspacePackage, target).slice(2)),
          )}`,
        ] as const,
      ]),
    ),
  );
}

export function renderTypeScriptPathsConfig(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
): string {
  const configDirectory = path.dirname(path.resolve(workspaceRoot, TYPESCRIPT_PATHS_CONFIG_PATH));
  const paths = Object.fromEntries(
    packages.flatMap((workspacePackage) =>
      workspacePackage.exports.map(({ specifier, target }) => {
        const absoluteTarget = path.resolve(
          workspaceRoot,
          workspacePackage.root,
          typescriptExportTarget(workspacePackage, target),
        );
        const relativeTarget = toRepoPath(path.relative(configDirectory, absoluteTarget));
        return [specifier, [relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`]];
      }),
    ),
  );
  return `${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`;
}

export function renderWorkspaceDerivationSnapshot(packages: readonly WorkspacePackageMetadata[]): string {
  const aliasTargets = Object.fromEntries(
    packages.flatMap((workspacePackage) =>
      workspacePackage.exports.map(({ specifier, target }) => [
        specifier,
        `./${toRepoPath(path.posix.join(workspacePackage.root, target.slice(2)))}`,
      ]),
    ),
  );
  const snapshot = {
    aliases: aliasTargets,
    packages: packages.map((workspacePackage) => ({
      dependencies: workspacePackage.dependencies,
      exports: workspacePackage.exports,
      name: workspacePackage.name,
      root: workspacePackage.root,
      runtimeKind: workspacePackage.runtimeKind,
      testEnvironment: workspacePackage.testEnvironment,
      workspaceDependencies: workspacePackage.workspaceDependencies,
    })),
    typescriptPaths: deriveTypescriptPaths(packages),
  };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function deriveViteAliases(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
): readonly WorkspaceResolverAlias[] {
  return deriveResolverAliases(packages, workspaceRoot);
}

export function deriveVitestAliases(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
): readonly WorkspaceResolverAlias[] {
  return deriveResolverAliases(packages, workspaceRoot);
}

export function deriveVitestProjectRecords(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
): readonly VitestProjectRecord[] {
  const workspaceProjects: VitestProjectRecord[] = packages.map((workspacePackage) => ({
    absoluteRoot: workspacePackage.absoluteRoot,
    absoluteRoots: [workspacePackage.absoluteRoot],
    environment: workspacePackage.testEnvironment,
    name: workspacePackage.name,
    root: workspacePackage.root,
    roots: [workspacePackage.root],
    runtimeKind: workspacePackage.runtimeKind,
    source: 'workspace',
    testEnvironment: workspacePackage.testEnvironment,
  }));
  const repositoryProjects: VitestProjectRecord[] = Object.entries(repositoryToolProfiles).map(([name, profile]) => {
    const [root, ...additionalRoots] = profile.roots;
    if (root === undefined) {
      throw new Error(`Repository tool profile "${name}" must own at least one root.`);
    }
    const roots = [root, ...additionalRoots];
    return {
      absoluteRoot: path.resolve(workspaceRoot, root),
      absoluteRoots: roots.map((ownedRoot) => path.resolve(workspaceRoot, ownedRoot)),
      environment: profile.testEnvironment,
      name,
      root,
      roots,
      runtimeKind: profile.runtimeKind,
      source: 'repository-tool',
      testEnvironment: profile.testEnvironment,
    };
  });

  return [...workspaceProjects, ...repositoryProjects].sort((left, right) => compareStrings(left.name, right.name));
}

export function findRepositoryRoot(startDirectory: string = import.meta.dirname): string {
  return findRepositoryRootFromCandidate(path.resolve(startDirectory), startDirectory);
}

export function loadRepositoryWorkspaceMetadata(
  workspaceRoot: string = findRepositoryRoot(),
): readonly WorkspacePackageMetadata[] {
  return loadWorkspaceMetadata({ runtimeProfiles, workspaceRoot });
}

export function findWorkspacePackagesForPaths(
  packages: readonly WorkspacePackageMetadata[],
  changedPaths: readonly string[],
): WorkspacePathOwnership {
  const packageNames = new Set<string>();
  const unownedPaths: string[] = [];
  const packagesByLongestRoot = [...packages].sort((left, right) => right.root.length - left.root.length);

  for (const changedPath of changedPaths) {
    const owner = packagesByLongestRoot.find((workspacePackage) =>
      path.isAbsolute(changedPath)
        ? isPathWithin(workspacePackage.absoluteRoot, path.resolve(changedPath))
        : isRepoPathWithin(workspacePackage.root, changedPath),
    );
    if (owner === undefined) {
      unownedPaths.push(changedPath);
    } else {
      packageNames.add(owner.name);
    }
  }

  return {
    packageNames: [...packageNames].sort(compareStrings),
    unownedPaths: [...new Set(unownedPaths)].sort(compareStrings),
  };
}

export function selectAffectedWorkspacePackages(
  packages: readonly WorkspacePackageMetadata[],
  changedPackageNames: readonly string[],
): readonly WorkspacePackageMetadata[] {
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const affectedNames = new Set<string>();
  for (const changedPackageName of changedPackageNames) {
    if (!packagesByName.has(changedPackageName)) {
      throw new Error(`Cannot select affected packages for unknown workspace package "${changedPackageName}".`);
    }
    affectedNames.add(changedPackageName);
  }

  let addedDependent = true;
  while (addedDependent) {
    addedDependent = false;
    for (const workspacePackage of packages) {
      if (
        !affectedNames.has(workspacePackage.name) &&
        workspacePackage.workspaceDependencies.some((dependencyName) => affectedNames.has(dependencyName))
      ) {
        affectedNames.add(workspacePackage.name);
        addedDependent = true;
      }
    }
  }

  return packages
    .filter(({ name }) => affectedNames.has(name))
    .sort((left, right) => compareStrings(left.name, right.name));
}

export function loadWorkspaceMetadata(options: LoadWorkspaceMetadataOptions): readonly WorkspacePackageMetadata[] {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const packageParentDirectories = options.packageParentDirectories ?? DEFAULT_PACKAGE_PARENT_DIRECTORIES;
  const packageRoots = options.packageRoots ?? DEFAULT_PACKAGE_ROOTS;
  const drafts = [
    ...packageParentDirectories.flatMap((parentDirectory) =>
      loadPackagesFromParent(workspaceRoot, parentDirectory, options.runtimeProfiles),
    ),
    ...packageRoots.flatMap((packageRoot) => loadPackageFromRoot(workspaceRoot, packageRoot, options.runtimeProfiles)),
  ];
  const workspacePackageNames = new Set(drafts.map(({ name }) => name));
  if (workspacePackageNames.size !== drafts.length) {
    const duplicateName = drafts
      .map(({ name }) => name)
      .sort(compareStrings)
      .find((name, index, names) => name === names[index - 1]);
    throw new Error(`Duplicate workspace package name "${duplicateName ?? 'unknown'}".`);
  }
  for (const profileName of Object.keys(options.runtimeProfiles).sort(compareStrings)) {
    if (!workspacePackageNames.has(profileName)) {
      throw new Error(`Reviewed runtime profile "${profileName}" has no workspace package manifest.`);
    }
  }

  return drafts
    .map((draft) => ({
      ...draft,
      workspaceDependencies: uniqueSorted(
        Object.keys({
          ...draft.dependencies.development,
          ...draft.dependencies.optional,
          ...draft.dependencies.peer,
          ...draft.dependencies.production,
        }).filter((dependencyName) => workspacePackageNames.has(dependencyName)),
      ),
    }))
    .sort((left, right) => compareStrings(left.name, right.name));
}

function deriveResolverAliases(
  packages: readonly WorkspacePackageMetadata[],
  workspaceRoot: string,
): readonly WorkspaceResolverAlias[] {
  return packages.flatMap((workspacePackage) =>
    workspacePackage.exports.map(({ specifier, target }) => {
      const specifierWildcardCount = countWildcards(specifier);
      const targetWildcardCount = countWildcards(target);
      if (specifierWildcardCount !== targetWildcardCount || specifierWildcardCount > 1) {
        throw new Error(
          `Workspace alias "${specifier}" must use the same single-wildcard shape as target "${target}".`,
        );
      }

      const replacement = path.resolve(workspaceRoot, workspacePackage.root, target).replace('*', '$1');
      const find =
        specifierWildcardCount === 0
          ? new RegExp(`^${escapeRegularExpression(specifier)}$`)
          : new RegExp(`^${specifier.split('*').map(escapeRegularExpression).join('(.+)')}$`);

      return { find, replacement, specifier };
    }),
  );
}

function typescriptExportTarget(workspacePackage: WorkspacePackageMetadata, target: string): string {
  if (!target.endsWith('.js')) {
    return target;
  }
  const declarationTarget = `${target.slice(0, -'.js'.length)}.d.ts`;
  return existsSync(path.resolve(workspacePackage.absoluteRoot, declarationTarget))
    ? target.slice(0, -'.js'.length)
    : target;
}

function findRepositoryRootFromCandidate(candidate: string, startDirectory: string): string {
  if (existsSync(path.join(candidate, 'pnpm-workspace.yaml')) && existsSync(path.join(candidate, 'package.json'))) {
    return candidate;
  }
  const parent = path.dirname(candidate);
  if (parent === candidate) {
    throw new Error(`Could not find the repository root from "${startDirectory}".`);
  }
  return findRepositoryRootFromCandidate(parent, startDirectory);
}

function loadPackagesFromParent(
  workspaceRoot: string,
  parentDirectory: string,
  runtimeProfiles: WorkspaceRuntimeProfileTable,
): readonly WorkspacePackageDraft[] {
  const absoluteParent = path.resolve(workspaceRoot, parentDirectory);
  if (!existsSync(absoluteParent)) {
    return [];
  }

  return readdirSync(absoluteParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absoluteParent, entry.name, 'package.json'))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => loadPackageManifest(workspaceRoot, manifestPath, runtimeProfiles));
}

function loadPackageFromRoot(
  workspaceRoot: string,
  packageRoot: string,
  runtimeProfiles: WorkspaceRuntimeProfileTable,
): readonly WorkspacePackageDraft[] {
  const manifestPath = path.resolve(workspaceRoot, packageRoot, 'package.json');
  return existsSync(manifestPath) ? [loadPackageManifest(workspaceRoot, manifestPath, runtimeProfiles)] : [];
}

function loadPackageManifest(
  workspaceRoot: string,
  manifestPath: string,
  runtimeProfiles: WorkspaceRuntimeProfileTable,
): WorkspacePackageDraft {
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
  const runtimeProfile = runtimeProfiles[manifest.name];
  if (runtimeProfile === undefined) {
    throw new Error(`Missing reviewed runtime profile for workspace package "${manifest.name}".`);
  }

  const packageRoot = path.dirname(manifestPath);
  const relativeRoot = toRepoPath(path.relative(workspaceRoot, packageRoot));
  for (const packageExport of manifest.exports) {
    validateExportTarget(manifest.name, packageExport, packageRoot);
  }

  return {
    absoluteRoot: packageRoot,
    dependencies: manifest.dependencies,
    exports: manifest.exports.map(({ subpath, target }) => ({
      specifier: exportSpecifier(manifest.name, subpath),
      subpath,
      target,
    })),
    manifestPath: toRepoPath(path.relative(workspaceRoot, manifestPath)),
    name: manifest.name,
    root: relativeRoot,
    ...runtimeProfile,
  };
}

function validateExportTarget(
  packageName: string,
  packageExport: Pick<WorkspaceExport, 'subpath' | 'target'>,
  packageRoot: string,
): void {
  const { subpath, target } = packageExport;
  if (!target.startsWith('./')) {
    throw new Error(`Workspace package "${packageName}" export "${subpath}" target "${target}" must start with "./".`);
  }

  const targetForContainmentCheck = target.replaceAll('*', '__workspace_wildcard__');
  const absoluteTarget = path.resolve(packageRoot, targetForContainmentCheck);
  if (!isPathWithin(packageRoot, absoluteTarget)) {
    throw new Error(
      `Workspace package "${packageName}" export "${subpath}" target "${target}" escapes its package root.`,
    );
  }

  const targetExists = target.includes('*')
    ? listPackagePaths(packageRoot).some((relativePath) => wildcardPattern(target).test(relativePath))
    : existsSync(path.resolve(packageRoot, target));
  if (!targetExists) {
    throw new Error(
      `Workspace package "${packageName}" export "${subpath}" target "${target}" does not match an existing path.`,
    );
  }
}

function listPackagePaths(packageRoot: string, currentDirectory = packageRoot): readonly string[] {
  return readdirSync(currentDirectory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = `./${toRepoPath(path.relative(packageRoot, absolutePath))}`;
    return entry.isDirectory() ? [relativePath, ...listPackagePaths(packageRoot, absolutePath)] : [relativePath];
  });
}

function wildcardPattern(pattern: string): RegExp {
  const escapedSegments = pattern.split('*').map(escapeRegularExpression);
  return new RegExp(`^${escapedSegments.join('.+')}$`);
}

function countWildcards(value: string): number {
  return value.split('*').length - 1;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
  );
}

function isRepoPathWithin(packageRoot: string, candidate: string): boolean {
  const normalizedCandidate = path.posix.normalize(toRepoPath(candidate).replace(/^\.\//, ''));
  return normalizedCandidate === packageRoot || normalizedCandidate.startsWith(`${packageRoot}/`);
}

function parseManifest(
  manifestText: string,
  manifestPath: string,
): {
  readonly dependencies: WorkspaceDependencyGroups;
  readonly exports: readonly Pick<WorkspaceExport, 'subpath' | 'target'>[];
  readonly name: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Invalid JSON in workspace manifest ${manifestPath}.`, { cause: error });
  }

  if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || parsed['name'].length === 0) {
    throw new Error(`Workspace manifest ${manifestPath} must define a non-empty string name.`);
  }

  return {
    dependencies: {
      development: parseStringRecord(parsed['devDependencies'], manifestPath, 'devDependencies'),
      optional: parseStringRecord(parsed['optionalDependencies'], manifestPath, 'optionalDependencies'),
      peer: parseStringRecord(parsed['peerDependencies'], manifestPath, 'peerDependencies'),
      production: parseStringRecord(parsed['dependencies'], manifestPath, 'dependencies'),
    },
    exports: parseExports(parsed['exports'], manifestPath),
    name: parsed['name'],
  };
}

function parseStringRecord(value: unknown, manifestPath: string, field: string): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`Workspace manifest ${manifestPath} field "${field}" must be an object.`);
  }

  const entries = Object.entries(value);
  for (const [name, specifier] of entries) {
    if (typeof specifier !== 'string') {
      throw new Error(`Workspace manifest ${manifestPath} dependency "${name}" must use a string specifier.`);
    }
  }

  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function parseExports(value: unknown, manifestPath: string): readonly Pick<WorkspaceExport, 'subpath' | 'target'>[] {
  if (typeof value === 'string') {
    return [{ subpath: '.', target: value }];
  }
  if (!isRecord(value)) {
    throw new Error(`Workspace manifest ${manifestPath} must define string export targets.`);
  }

  const exports = Object.entries(value).map(([subpath, target]) => {
    if (typeof target !== 'string') {
      throw new Error(`Workspace manifest ${manifestPath} export "${subpath}" must use a string target.`);
    }
    return { subpath, target };
  });

  return exports.sort((left, right) => compareStrings(left.subpath, right.subpath));
}

function exportSpecifier(packageName: string, subpath: string): string {
  if (subpath === '.') {
    return packageName;
  }
  if (!subpath.startsWith('./')) {
    throw new Error(`Workspace export subpath "${subpath}" must be "." or start with "./".`);
  }
  return `${packageName}/${subpath.slice(2)}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRepoPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
