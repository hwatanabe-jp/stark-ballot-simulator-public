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

function scanImportSpecifier(filePath: string, specifier: string): Finding[] {
  const findings: Finding[] = [];
  if (specifier === 'storybook' || specifier.startsWith('storybook/') || specifier.startsWith('@storybook/')) {
    findings.push({ file: filePath, reason: 'Storybook dependency import' });
  }
  if (/\.stories(?:\.[cm]?[jt]sx?)?$/u.test(specifier) || /(?:^|\/)\.storybook(?:\/|$)/u.test(specifier)) {
    findings.push({ file: filePath, reason: 'Storybook source import' });
  }
  if (/^next\/(?:navigation|link|dynamic|font|headers|server)$/.test(specifier)) {
    findings.push({ file: filePath, reason: 'Next runtime import' });
  }
  if (isServerAliasSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'server import' });
  }
  if (isNextApiAliasSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'Next API route import' });
  }
  if (isStoreAliasSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'store implementation import' });
  }
  if (isAwsAdapterSpecifier(specifier) && !isStoreAliasSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'AWS adapter package import' });
  }
  if (isNodeAdapterSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'Node adapter package import' });
  }
  if (isPrivateZkvmSemanticDescriptorSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'private zkVM semantic descriptor import' });
  }
  if (specifier.startsWith('@aws-sdk/')) {
    findings.push({ file: filePath, reason: 'AWS SDK import' });
  }
  if (specifier === '@stark-ballot/domain' || specifier.startsWith('@stark-ballot/domain/')) {
    findings.push({ file: filePath, reason: 'domain package import' });
  }
  if (
    (specifier === '@stark-ballot/application' || specifier.startsWith('@stark-ballot/application/')) &&
    !BROWSER_SAFE_APPLICATION_SPECIFIERS.has(specifier)
  ) {
    findings.push({ file: filePath, reason: 'application package import' });
  }
  if (isNodeBuiltinSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'Node builtin import' });
  }
  return findings;
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
    for (const { specifier, typeOnly } of extractImportReferences(content)) {
      const specifierFindings = scanImportSpecifier(filePath, specifier);
      findings.push(...specifierFindings);
      if (specifierFindings.length > 0 || typeOnly || !isLocalSpecifier(specifier)) {
        continue;
      }

      const resolved = await resolveLocalImport(filePath, specifier, cwd);
      if (resolved) {
        if (!isStoreAliasSpecifier(specifier) && isResolvedStoreImport(cwd, resolved)) {
          findings.push({ file: filePath, reason: 'store implementation import' });
        }
        if (
          !isAwsAdapterSpecifier(specifier) &&
          !isResolvedStoreImport(cwd, resolved) &&
          isResolvedAwsAdapterImport(cwd, resolved)
        ) {
          findings.push({ file: filePath, reason: 'AWS adapter package import' });
        }
        if (!isNodeAdapterSpecifier(specifier) && isResolvedNodeAdapterImport(cwd, resolved)) {
          findings.push({ file: filePath, reason: 'Node adapter package import' });
        }
        if (!isServerAliasSpecifier(specifier) && isResolvedServerImport(cwd, resolved)) {
          findings.push({ file: filePath, reason: 'server import' });
        }
        if (!isNextApiAliasSpecifier(specifier) && isResolvedNextApiImport(cwd, resolved)) {
          findings.push({ file: filePath, reason: 'Next API route import' });
        }
        pending.push(resolved);
      } else if (!(await resolvesIntentionalAssetImport(filePath, specifier, cwd))) {
        findings.push({ file: filePath, reason: `unresolved local import: ${specifier}` });
      }
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await checkBrowserImportBoundary();
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`[browser-import-boundary] ${path.relative(process.cwd(), finding.file)}: ${finding.reason}`);
    }
    throw new Error(`Browser import-boundary check failed with ${findings.length} finding(s).`);
  }
  console.log('[browser-import-boundary] resolved transitive frontend graph from apps/web/src/main.tsx');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
