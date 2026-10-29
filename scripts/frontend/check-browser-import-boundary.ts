import { assertNoFrontendFindings, runFrontendCheck } from './findings';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  deriveViteAliases,
  findRepositoryRoot,
  loadRepositoryWorkspaceMetadata,
} from '../../tooling/workspace/workspace-metadata';

const DEFAULT_ENTRYPOINT = 'apps/web/src/main.tsx';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INTENTIONAL_ASSET_EXTENSIONS = ['.css', '.json'];
const WORKSPACE_METADATA_ROOT = findRepositoryRoot(import.meta.dirname);
const WORKSPACE_ALIAS_SHAPES = deriveViteAliases(
  loadRepositoryWorkspaceMetadata(WORKSPACE_METADATA_ROOT),
  WORKSPACE_METADATA_ROOT,
).map(({ find, replacement }) => ({
  find,
  repositoryRelativeReplacement: path.relative(WORKSPACE_METADATA_ROOT, replacement),
}));
const DENIED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Next runtime import', pattern: /from ['"]next\/(?:navigation|link|dynamic|font|headers|server)['"]/ },
  { label: 'server import', pattern: /from ['"]@\/server\// },
  { label: 'Next API route import', pattern: /from ['"]@\/app\/api\// },
  { label: 'AWS SDK import', pattern: /from ['"]@aws-sdk\// },
  { label: 'Node ambient timeout', pattern: /\bNodeJS\.Timeout\b/ },
  { label: 'browser process.env read', pattern: /\bprocess\.env\b/ },
  { label: 'browser global process shim read', pattern: /\bglobalThis(?:\.process|\[\s*['"]process['"]\s*\])/ },
];
const NODE_BUILTIN_MODULES = new Set(
  builtinModules.flatMap((moduleName) => {
    const normalized = moduleName.replace(/^node:/, '');
    return [moduleName, normalized, `node:${normalized}`];
  }),
);
const BROWSER_SAFE_APPLICATION_SPECIFIERS = new Set(['@stark-ballot/application/finalize/finalization-progress']);

type Finding = {
  file: string;
  reason: string;
};

type CheckOptions = {
  cwd?: string;
  entrypoint?: string;
};

type ImportReference = {
  specifier: string;
  index: number;
  typeOnly: boolean;
};

const IMPORT_PATTERNS = [
  { pattern: /\bimport\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, specifierIndex: 2 },
  { pattern: /\bexport\s+(type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g, specifierIndex: 2 },
  { pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, specifierIndex: 1 },
];

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function shouldCheck(filePath: string): boolean {
  return (
    SOURCE_EXTENSIONS.includes(path.extname(filePath)) &&
    !filePath.endsWith('.test.tsx') &&
    !filePath.endsWith('.test.ts')
  );
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@stark-ballot/');
}

function resolveAliasCandidates(specifier: string, cwd: string): string[] {
  if (!specifier.startsWith('@stark-ballot/')) {
    return [specifier];
  }

  return WORKSPACE_ALIAS_SHAPES.flatMap(({ find, repositoryRelativeReplacement }) => {
    const match = find.exec(specifier);
    if (match === null) {
      return [];
    }

    const wildcard = match[1];
    const fixtureRelativeReplacement =
      wildcard === undefined ? repositoryRelativeReplacement : repositoryRelativeReplacement.replace('$1', wildcard);
    return [path.resolve(cwd, fixtureRelativeReplacement)];
  });
}

function extractImportReferences(content: string): ImportReference[] {
  const references: ImportReference[] = [];
  for (const { pattern, specifierIndex } of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      references.push({
        specifier: match[specifierIndex] ?? '',
        index: match.index,
        typeOnly: Boolean(match[1] && specifierIndex === 2),
      });
    }
  }
  return references.sort((a, b) => a.index - b.index);
}

async function resolveSourceFile(basePath: string): Promise<string | null> {
  const candidates = [
    basePath,
    ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    if ((await pathExists(candidate)) && shouldCheck(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolvesIntentionalAssetImport(fromFile: string, specifier: string, cwd: string): Promise<boolean> {
  if (!INTENTIONAL_ASSET_EXTENSIONS.includes(path.extname(specifier))) {
    return false;
  }

  for (const resolvedSpecifier of resolveAliasCandidates(specifier, cwd)) {
    const absolutePath = path.resolve(path.dirname(fromFile), resolvedSpecifier);
    if (await pathExists(absolutePath)) {
      return true;
    }
  }

  return false;
}

async function resolveLocalImport(fromFile: string, specifier: string, cwd: string): Promise<string | null> {
  for (const resolvedSpecifier of resolveAliasCandidates(specifier, cwd)) {
    const basePath = path.resolve(path.dirname(fromFile), resolvedSpecifier);
    const sourceFile = await resolveSourceFile(basePath);
    if (sourceFile) {
      return sourceFile;
    }
  }
  return null;
}

function scanContent(filePath: string, content: string): Finding[] {
  return DENIED_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(({ label }) => ({
    file: filePath,
    reason: label,
  }));
}

const IMPORT_SPECIFIER_RULES: ReadonlyArray<{ reason: string; matches: (specifier: string) => boolean }> = [
  {
    reason: 'Storybook dependency import',
    matches: (specifier) =>
      specifier === 'storybook' || specifier.startsWith('storybook/') || specifier.startsWith('@storybook/'),
  },
  {
    reason: 'Storybook source import',
    matches: (specifier) =>
      /\.stories(?:\.[cm]?[jt]sx?)?$/u.test(specifier) || /(?:^|\/)\.storybook(?:\/|$)/u.test(specifier),
  },
  {
    reason: 'Next runtime import',
    matches: (specifier) => /^next\/(?:navigation|link|dynamic|font|headers|server)$/.test(specifier),
  },
  { reason: 'server import', matches: (specifier) => isServerAliasSpecifier(specifier) },
  { reason: 'Next API route import', matches: (specifier) => isNextApiAliasSpecifier(specifier) },
  { reason: 'store implementation import', matches: (specifier) => isStoreAliasSpecifier(specifier) },
  {
    reason: 'AWS adapter package import',
    matches: (specifier) => isAwsAdapterSpecifier(specifier) && !isStoreAliasSpecifier(specifier),
  },
  { reason: 'Node adapter package import', matches: (specifier) => isNodeAdapterSpecifier(specifier) },
  {
    reason: 'private zkVM semantic descriptor import',
    matches: (specifier) => isPrivateZkvmSemanticDescriptorSpecifier(specifier),
  },
  { reason: 'AWS SDK import', matches: (specifier) => specifier.startsWith('@aws-sdk/') },
  {
    reason: 'domain package import',
    matches: (specifier) => specifier === '@stark-ballot/domain' || specifier.startsWith('@stark-ballot/domain/'),
  },
  {
    reason: 'application package import',
    matches: (specifier) =>
      (specifier === '@stark-ballot/application' || specifier.startsWith('@stark-ballot/application/')) &&
      !BROWSER_SAFE_APPLICATION_SPECIFIERS.has(specifier),
  },
  { reason: 'Node builtin import', matches: (specifier) => isNodeBuiltinSpecifier(specifier) },
];

function scanImportSpecifier(filePath: string, specifier: string): Finding[] {
  return IMPORT_SPECIFIER_RULES.filter(({ matches }) => matches(specifier)).map(({ reason }) => ({
    file: filePath,
    reason,
  }));
}

function isPrivateZkvmSemanticDescriptorSpecifier(specifier: string): boolean {
  const withoutSourceExtension = specifier.replace(/\.(?:js|ts)$/u, '');
  return (
    withoutSourceExtension === '@stark-ballot/zkvm-contract/zkvm/semantic-contract' ||
    ((withoutSourceExtension.startsWith('./') || withoutSourceExtension.startsWith('../')) &&
      withoutSourceExtension.endsWith('/semantic-contract'))
  );
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return (
    NODE_BUILTIN_MODULES.has(specifier) ||
    NODE_BUILTIN_MODULES.has(normalized) ||
    NODE_BUILTIN_MODULES.has(`node:${normalized}`)
  );
}

function isStoreAliasSpecifier(specifier: string): boolean {
  return specifier.startsWith('@stark-ballot/aws-adapters/store/');
}

function isAwsAdapterSpecifier(specifier: string): boolean {
  return specifier === '@stark-ballot/aws-adapters' || specifier.startsWith('@stark-ballot/aws-adapters/');
}

function isNodeAdapterSpecifier(specifier: string): boolean {
  return specifier === '@stark-ballot/node-adapters' || specifier.startsWith('@stark-ballot/node-adapters/');
}

function isServerAliasSpecifier(specifier: string): boolean {
  return specifier === '@stark-ballot/api/server' || specifier.startsWith('@stark-ballot/api/server/');
}

function isNextApiAliasSpecifier(specifier: string): boolean {
  return specifier === '@stark-ballot/api/server/api' || specifier.startsWith('@stark-ballot/api/server/api/');
}

function isResolvedImportUnder(cwd: string, resolved: string, root: string): boolean {
  const relativePath = path.relative(cwd, resolved).split(path.sep).join('/');
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function isResolvedStoreImport(cwd: string, resolved: string): boolean {
  return isResolvedImportUnder(cwd, resolved, 'packages/aws-adapters/src/store');
}

function isResolvedAwsAdapterImport(cwd: string, resolved: string): boolean {
  return isResolvedImportUnder(cwd, resolved, 'packages/aws-adapters/src');
}

function isResolvedNodeAdapterImport(cwd: string, resolved: string): boolean {
  return isResolvedImportUnder(cwd, resolved, 'packages/node-adapters/src');
}

function isResolvedServerImport(cwd: string, resolved: string): boolean {
  return isResolvedImportUnder(cwd, resolved, 'apps/api/src/server');
}

function isResolvedNextApiImport(cwd: string, resolved: string): boolean {
  return isResolvedImportUnder(cwd, resolved, 'apps/api/src/server/api');
}

const RESOLVED_IMPORT_RULES: ReadonlyArray<{
  reason: string;
  matches: (specifier: string, cwd: string, resolved: string) => boolean;
}> = [
  {
    reason: 'store implementation import',
    matches: (specifier, cwd, resolved) => !isStoreAliasSpecifier(specifier) && isResolvedStoreImport(cwd, resolved),
  },
  {
    reason: 'AWS adapter package import',
    matches: (specifier, cwd, resolved) =>
      !isAwsAdapterSpecifier(specifier) &&
      !isResolvedStoreImport(cwd, resolved) &&
      isResolvedAwsAdapterImport(cwd, resolved),
  },
  {
    reason: 'Node adapter package import',
    matches: (specifier, cwd, resolved) =>
      !isNodeAdapterSpecifier(specifier) && isResolvedNodeAdapterImport(cwd, resolved),
  },
  {
    reason: 'server import',
    matches: (specifier, cwd, resolved) => !isServerAliasSpecifier(specifier) && isResolvedServerImport(cwd, resolved),
  },
  {
    reason: 'Next API route import',
    matches: (specifier, cwd, resolved) =>
      !isNextApiAliasSpecifier(specifier) && isResolvedNextApiImport(cwd, resolved),
  },
];

async function collectImportDependencies(
  filePath: string,
  content: string,
  context: { cwd: string; findings: Finding[]; pending: string[] },
): Promise<void> {
  const { cwd, findings, pending } = context;
  for (const { specifier, typeOnly } of extractImportReferences(content)) {
    const specifierFindings = scanImportSpecifier(filePath, specifier);
    findings.push(...specifierFindings);
    if (specifierFindings.length > 0 || typeOnly || !isLocalSpecifier(specifier)) {
      continue;
    }

    const resolved = await resolveLocalImport(filePath, specifier, cwd);
    if (resolved) {
      findings.push(
        ...RESOLVED_IMPORT_RULES.filter(({ matches }) => matches(specifier, cwd, resolved)).map(({ reason }) => ({
          file: filePath,
          reason,
        })),
      );
      pending.push(resolved);
    } else if (!(await resolvesIntentionalAssetImport(filePath, specifier, cwd))) {
      findings.push({ file: filePath, reason: `unresolved local import: ${specifier}` });
    }
  }
}

export async function checkBrowserImportBoundary(options: CheckOptions = {}): Promise<Finding[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const defaultEntrypoint = path.resolve(cwd, DEFAULT_ENTRYPOINT);
  const entrypoint = options.entrypoint !== undefined ? path.resolve(cwd, options.entrypoint) : defaultEntrypoint;
  const visited = new Set<string>();
  const pending = [entrypoint];
  const findings: Finding[] = [];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);

    if (!(await pathExists(filePath))) {
      findings.push({ file: filePath, reason: 'entrypoint or imported source file does not exist' });
      continue;
    }
    if (!shouldCheck(filePath)) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf-8');
    findings.push(...scanContent(filePath, content));
    await collectImportDependencies(filePath, content, { cwd, findings, pending });
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await checkBrowserImportBoundary();
  assertNoFrontendFindings(
    findings.map((finding) => ({ ...finding, file: path.relative(process.cwd(), finding.file) })),
    'browser-import-boundary',
    'Browser import-boundary check',
  );
  console.log('[browser-import-boundary] resolved transitive frontend graph from apps/web/src/main.tsx');
}

runFrontendCheck(import.meta.url, main);
