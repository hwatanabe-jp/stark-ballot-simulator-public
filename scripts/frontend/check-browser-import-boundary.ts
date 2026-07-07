import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const DEFAULT_ENTRYPOINT = 'apps/web/src/main.tsx';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INTENTIONAL_ASSET_EXTENSIONS = ['.css', '.json'];
const ALIAS_ROOTS: Array<{ prefix: string; root: string }> = [
  { prefix: '@stark-ballot/api-contract/api-contract', root: 'packages/api-contract/src/api-contract' },
  { prefix: '@stark-ballot/api-contract/errors', root: 'packages/api-contract/src/errors' },
  { prefix: '@stark-ballot/api-contract/types/api', root: 'packages/api-contract/src/types/api' },
  { prefix: '@stark-ballot/api-contract/validation', root: 'packages/api-contract/src/validation' },
  { prefix: '@stark-ballot/merkle', root: 'packages/merkle/src' },
  { prefix: '@stark-ballot/runtime-config/env', root: 'packages/runtime-config/src/env' },
  { prefix: '@stark-ballot/validation', root: 'packages/validation/src' },
  {
    prefix: '@stark-ballot/verification/bitmap-proof-types',
    root: 'packages/verification/src/verification/bitmap-proof-types.ts',
  },
  { prefix: '@stark-ballot/verification/bitmap-root', root: 'packages/verification/src/verification/bitmap-root.ts' },
  {
    prefix: '@stark-ballot/verification/bitmap-verifier',
    root: 'packages/verification/src/verification/bitmap-verifier.ts',
  },
  {
    prefix: '@stark-ballot/verification/bundle',
    root: 'packages/verification/src/verification/verification-bundle.ts',
  },
  {
    prefix: '@stark-ballot/verification/check-evaluator',
    root: 'packages/verification/src/verification/engine/evaluate-checks.ts',
  },
  {
    prefix: '@stark-ballot/verification/check-results',
    root: 'packages/verification/src/verification/build-verification-checks.ts',
  },
  {
    prefix: '@stark-ballot/verification/checks',
    root: 'packages/verification/src/verification/verification-checks.ts',
  },
  { prefix: '@stark-ballot/verification/engine-types', root: 'packages/verification/src/verification/engine/types.ts' },
  {
    prefix: '@stark-ballot/verification/excluded-count',
    root: 'packages/verification/src/verification/excluded-count.ts',
  },
  {
    prefix: '@stark-ballot/verification/fail-closed-status',
    root: 'packages/verification/src/verification/fail-closed-status.ts',
  },
  {
    prefix: '@stark-ballot/verification/image-id',
    root: 'packages/verification/src/verification/expected-image-id.ts',
  },
  {
    prefix: '@stark-ballot/verification/image-id-policy',
    root: 'packages/verification/src/verification/image-id-policy.js',
  },
  {
    prefix: '@stark-ballot/verification/image-id-types',
    root: 'packages/verification/src/verification/image-id-types.ts',
  },
  {
    prefix: '@stark-ballot/verification/included-bitmap-artifact',
    root: 'packages/verification/src/verification/included-bitmap-artifact.ts',
  },
  { prefix: '@stark-ballot/verification/merkle', root: 'packages/verification/src/verification/merkle.ts' },
  { prefix: '@stark-ballot/verification/merkle', root: 'packages/verification/src/merkle' },
  {
    prefix: '@stark-ballot/verification/public-audit-artifacts',
    root: 'packages/verification/src/verification/public-audit-artifacts.ts',
  },
  {
    prefix: '@stark-ballot/verification/public-input',
    root: 'packages/verification/src/verification/public-input-contract.ts',
  },
  {
    prefix: '@stark-ballot/verification/public-result',
    root: 'packages/verification/src/verification/public-verification-result.ts',
  },
  {
    prefix: '@stark-ballot/verification/receipt-normalizer',
    root: 'packages/verification/src/verification/receipt-normalizer.ts',
  },
  {
    prefix: '@stark-ballot/verification/seen-bitmap-artifact',
    root: 'packages/verification/src/verification/seen-bitmap-artifact.ts',
  },
  { prefix: '@stark-ballot/verification/shared', root: 'packages/verification/src/shared' },
  {
    prefix: '@stark-ballot/verification/stage-evaluators',
    root: 'packages/verification/src/verification/engine/stage-evaluators.ts',
  },
  {
    prefix: '@stark-ballot/verification/stage-status',
    root: 'packages/verification/src/verification/engine/derive-stages.ts',
  },
  {
    prefix: '@stark-ballot/verification/steps',
    root: 'packages/verification/src/verification/build-verification-steps.ts',
  },
  { prefix: '@stark-ballot/verification/sth-verifier', root: 'packages/verification/src/verification/sth-verifier.ts' },
  {
    prefix: '@stark-ballot/verification/summary',
    root: 'packages/verification/src/verification/verification-summary.ts',
  },
  {
    prefix: '@stark-ballot/verification/tamper-detection',
    root: 'packages/verification/src/verification/tamperDetection.ts',
  },
  { prefix: '@stark-ballot/verification/three-stage', root: 'packages/verification/src/verification/three-stage.ts' },
  { prefix: '@stark-ballot/verification/types', root: 'packages/verification/src/verification/types.ts' },
  { prefix: '@stark-ballot/zkvm-contract/zkvm', root: 'packages/zkvm-contract/src/zkvm' },
  { prefix: '@stark-ballot/web/api', root: 'apps/web/src/api' },
  { prefix: '@stark-ballot/web/components', root: 'apps/web/src/components' },
  { prefix: '@stark-ballot/web/finalize', root: 'apps/web/src/finalize' },
  { prefix: '@stark-ballot/web/hooks', root: 'apps/web/src/hooks' },
  { prefix: '@stark-ballot/web/i18n', root: 'apps/web/src/i18n' },
  { prefix: '@stark-ballot/web/knowledge', root: 'apps/web/src/knowledge' },
  { prefix: '@stark-ballot/web/mock-api', root: 'apps/web/src/mock-api' },
  { prefix: '@stark-ballot/web/navigation', root: 'apps/web/src/navigation' },
  { prefix: '@stark-ballot/web/routes', root: 'apps/web/src/routes' },
  { prefix: '@stark-ballot/web/session', root: 'apps/web/src/session' },
  { prefix: '@stark-ballot/web/shared', root: 'apps/web/src/shared' },
  { prefix: '@stark-ballot/web/styles', root: 'apps/web/src/styles' },
  { prefix: '@stark-ballot/web/verification', root: 'apps/web/src/verification' },
  { prefix: '@stark-ballot/web/vote', root: 'apps/web/src/vote' },
];
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
  if (specifier.startsWith('@stark-ballot/')) {
    const candidates = ALIAS_ROOTS.flatMap(({ prefix, root }) => {
      if (specifier === prefix) {
        return candidateRootsForFixture(cwd, root);
      }
      if (specifier.startsWith(`${prefix}/`)) {
        return candidateRootsForFixture(cwd, root).map((candidateRoot) =>
          path.join(candidateRoot, specifier.slice(prefix.length + 1)),
        );
      }
      return [];
    });
    return candidates;
  }
  return [specifier];
}

function candidateRootsForFixture(cwd: string, root: string): string[] {
  return [path.join(cwd, root)];
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
  if (specifier.startsWith('@aws-sdk/')) {
    findings.push({ file: filePath, reason: 'AWS SDK import' });
  }
  if (specifier === '@stark-ballot/domain' || specifier.startsWith('@stark-ballot/domain/')) {
    findings.push({ file: filePath, reason: 'domain package import' });
  }
  if (isNodeBuiltinSpecifier(specifier)) {
    findings.push({ file: filePath, reason: 'Node builtin import' });
  }
  return findings;
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
      findings.push(...scanImportSpecifier(filePath, specifier));
      if (typeOnly || !isLocalSpecifier(specifier)) {
        continue;
      }

      const resolved = await resolveLocalImport(filePath, specifier, cwd);
      if (resolved) {
        if (!isStoreAliasSpecifier(specifier) && isResolvedStoreImport(cwd, resolved)) {
          findings.push({ file: filePath, reason: 'store implementation import' });
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
