#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { format, resolveConfig, type Options } from 'prettier';

interface FormalReport {
  theorems: Array<{ name: string; source: string; claim: string }>;
  generatedVectorArtifacts: string[];
}

interface TheoremAuditEntry {
  name: string;
  source: string;
  statementSha256: string;
}

interface TheoremDependencyAuditEntry {
  name: string;
  source: string;
  qualifiedName: string;
  coreAxiomDependencies: string[];
  nativeDecideAxiomCount: number;
  nativeDecideAxiomSha256: string | null;
  dependencySetSha256: string;
}

interface VectorAuditEntry {
  path: string;
  sha256: string;
}

interface FormalAudit {
  schema: 'stark-ballot:formal-audit|v1';
  reportPath: string;
  proofHygiene: {
    scannedLeanFiles: number;
    forbiddenTokens: string[];
    allowedCoreAxioms: string[];
    allowedNativeDecideSources: string[];
    allowedNativeDecideDependencyPrefixes: string[];
  };
  theoremStatements: TheoremAuditEntry[];
  theoremDependencies: TheoremDependencyAuditEntry[];
  generatedVectorArtifacts: VectorAuditEntry[];
}

const repoRoot = process.cwd();
const reportPath = 'docs/current/formal/formal-report.json';
const auditPath = 'docs/current/formal/formal-audit.json';
const formalDir = path.join(repoRoot, 'formal');
const allowedCoreAxioms = ['propext', 'Quot.sound', 'Classical.choice'];
const allowedNativeDecideSources = ['formal/StarkBallotFormal/Bitmap.lean'];
const allowedNativeDecideDependencyPrefixes = ['StarkBallotFormal.byteValueAt_get_bit._native.native_decide.'];
const forbiddenLeanTokens = ['sorry', 'axiom', 'admit', 'unsafe'];
let prettierOptions: Options | null = null;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function listLeanFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolutePath = path.join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listLeanFiles(absolutePath));
    } else if (entry.endsWith('.lean')) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function stripLeanComments(source: string): string {
  return source.replace(/\/-[\s\S]*?-\//g, '').replace(/--.*$/gm, '');
}

function leanModuleForSource(source: string): string {
  if (!source.startsWith('formal/') || !source.endsWith('.lean')) {
    throw new Error(`cannot derive Lean module name from theorem source: ${source}`);
  }
  return source
    .replace(/^formal\//, '')
    .replace(/\.lean$/, '')
    .replace(/\//g, '.');
}

function assertProofHygiene(leanFiles: string[]): void {
  const nativeDecideSources = new Set<string>();
  for (const file of leanFiles) {
    const repoPath = normalizeRepoPath(file);
    const source = readFileSync(file, 'utf8');
    const sourceWithoutComments = stripLeanComments(source);

    for (const token of forbiddenLeanTokens) {
      const pattern = new RegExp(`\\b${token}\\b`);
      if (pattern.test(sourceWithoutComments)) {
        throw new Error(`${repoPath} contains forbidden Lean token: ${token}`);
      }
    }

    if (/\bnative_decide\b/.test(sourceWithoutComments)) {
      nativeDecideSources.add(repoPath);
    }
  }

  for (const source of nativeDecideSources) {
    if (!allowedNativeDecideSources.includes(source)) {
      throw new Error(`${source} uses native_decide but is not in the audit allowlist`);
    }
  }
}

function extractTheoremStatement(theorem: { name: string; source: string }): string {
  const sourcePath = path.join(repoRoot, theorem.source);
  const source = readFileSync(sourcePath, 'utf8');
  const start = source.search(new RegExp(`\\btheorem\\s+${theorem.name}\\b`));
  if (start < 0) {
    throw new Error(`${theorem.source} does not declare theorem ${theorem.name}`);
  }

  const proofStart = source.indexOf(':= by', start);
  if (proofStart < 0) {
    throw new Error(`${theorem.source} theorem ${theorem.name} does not use an inspectable ":= by" proof boundary`);
  }

  return source.slice(start, proofStart).trim().replace(/\s+/g, ' ');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function assertUniqueTheoremNames(theorems: Array<{ name: string }>): void {
  const seen = new Set<string>();
  for (const theorem of theorems) {
    if (seen.has(theorem.name)) {
      throw new Error(`formal report contains duplicate theorem name: ${theorem.name}`);
    }
    seen.add(theorem.name);
  }
}

function assertAuditEntriesMatchReport(
  label: string,
  reportTheorems: Array<{ name: string }>,
  entries: Array<{ name: string }>,
): void {
  const expectedNames = new Set(reportTheorems.map((theorem) => theorem.name));
  const actualNames = new Set<string>();

  for (const entry of entries) {
    if (actualNames.has(entry.name)) {
      throw new Error(`formal audit ${label} contains duplicate theorem name: ${entry.name}`);
    }
    if (!expectedNames.has(entry.name)) {
      throw new Error(`formal audit ${label} contains theorem not present in report: ${entry.name}`);
    }
    actualNames.add(entry.name);
  }

  for (const theorem of reportTheorems) {
    if (!actualNames.has(theorem.name)) {
      throw new Error(`formal audit ${label} is missing theorem from report: ${theorem.name}`);
    }
  }
}

function parseAxiomList(rawAxioms: string): string[] {
  const trimmed = rawAxioms.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed
    .split(',')
    .map((axiom) => axiom.trim())
    .filter((axiom) => axiom.length > 0);
}

function parsePrintAxiomsOutput(output: string): Map<string, string[]> {
  const dependenciesByName = new Map<string, string[]>();
  const dependencyPattern = /'StarkBallotFormal\.([^']+)' depends on axioms: \[([\s\S]*?)\]/g;
  const noDependencyPattern = /'StarkBallotFormal\.([^']+)' does not depend on any axioms/g;

  for (const match of output.matchAll(dependencyPattern)) {
    dependenciesByName.set(match[1], parseAxiomList(match[2]));
  }
  for (const match of output.matchAll(noDependencyPattern)) {
    dependenciesByName.set(match[1], []);
  }

  return dependenciesByName;
}

function collectTheoremDependencies(theorems: Array<{ name: string; source: string }>): TheoremDependencyAuditEntry[] {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'stark-ballot-formal-axioms-'));
  const tempLeanPath = path.join(tempDir, 'PrintAxioms.lean');

  try {
    const imports = Array.from(new Set(theorems.map((theorem) => leanModuleForSource(theorem.source)))).sort();
    const source = [
      ...imports.map((moduleName) => `import ${moduleName}`),
      '',
      ...theorems.map((theorem) => `#print axioms StarkBallotFormal.${theorem.name}`),
      '',
    ].join('\n');
    writeFileSync(tempLeanPath, source, 'utf8');

    const output = execFileSync('lake', ['env', 'lean', tempLeanPath], {
      cwd: formalDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const dependenciesByName = parsePrintAxiomsOutput(output);

    return theorems.map((theorem) => {
      const dependencies = dependenciesByName.get(theorem.name);
      if (!dependencies) {
        throw new Error(`missing #print axioms output for theorem ${theorem.name}`);
      }

      const coreAxioms = new Set<string>();
      const nativeDecideAxioms: string[] = [];
      for (const dependency of dependencies) {
        if (allowedCoreAxioms.includes(dependency)) {
          coreAxioms.add(dependency);
        } else if (
          allowedNativeDecideDependencyPrefixes.some((prefix) => dependency.startsWith(prefix)) &&
          allowedNativeDecideSources.includes(theorem.source)
        ) {
          nativeDecideAxioms.push(dependency);
        } else {
          throw new Error(`${theorem.name} depends on non-allowlisted axiom: ${dependency}`);
        }
      }

      const sortedDependencies = [...dependencies].sort();
      const sortedNativeDecideAxioms = nativeDecideAxioms.sort();
      return {
        name: theorem.name,
        source: theorem.source,
        qualifiedName: `StarkBallotFormal.${theorem.name}`,
        coreAxiomDependencies: [...coreAxioms].sort(),
        nativeDecideAxiomCount: sortedNativeDecideAxioms.length,
        nativeDecideAxiomSha256:
          sortedNativeDecideAxioms.length > 0 ? sha256(sortedNativeDecideAxioms.join('\n')) : null,
        dependencySetSha256: sha256(sortedDependencies.join('\n')),
      };
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildAudit(): FormalAudit {
  const report = readJson<FormalReport>(reportPath);
  assertUniqueTheoremNames(report.theorems);
  const leanFiles = listLeanFiles(formalDir);
  assertProofHygiene(leanFiles);

  const formalReadme = readFileSync(path.join(repoRoot, 'docs/current/formal/README.md'), 'utf8');
  for (const axiom of allowedCoreAxioms) {
    if (!formalReadme.includes(axiom)) {
      throw new Error(`docs/current/formal/README.md must document allowed core axiom ${axiom}`);
    }
  }
  if (!formalReadme.includes('native_decide')) {
    throw new Error('docs/current/formal/README.md must document the native_decide allowlist');
  }

  const theoremStatements = report.theorems.map((theorem) => ({
    name: theorem.name,
    source: theorem.source,
    statementSha256: sha256(extractTheoremStatement(theorem)),
  }));
  const theoremDependencies = collectTheoremDependencies(report.theorems);

  assertAuditEntriesMatchReport('theoremStatements', report.theorems, theoremStatements);
  assertAuditEntriesMatchReport('theoremDependencies', report.theorems, theoremDependencies);

  return {
    schema: 'stark-ballot:formal-audit|v1',
    reportPath,
    proofHygiene: {
      scannedLeanFiles: leanFiles.length,
      forbiddenTokens: forbiddenLeanTokens,
      allowedCoreAxioms,
      allowedNativeDecideSources,
      allowedNativeDecideDependencyPrefixes,
    },
    theoremStatements,
    theoremDependencies,
    generatedVectorArtifacts: report.generatedVectorArtifacts.map((artifactPath) => {
      const absolutePath = path.join(repoRoot, artifactPath);
      if (!existsSync(absolutePath)) {
        throw new Error(`formal report references missing vector artifact: ${artifactPath}`);
      }
      return {
        path: artifactPath,
        sha256: sha256(readFileSync(absolutePath, 'utf8')),
      };
    }),
  };
}

async function stableJson(value: unknown): Promise<string> {
  prettierOptions ??= (await resolveConfig(path.join(repoRoot, 'package.json'))) ?? {};
  return await format(JSON.stringify(value), {
    ...prettierOptions,
    filepath: path.join(repoRoot, auditPath),
    parser: 'json',
  });
}

async function main(): Promise<void> {
  const auditJson = await stableJson(buildAudit());

  if (process.argv.includes('--check')) {
    const current = readFileSync(path.join(repoRoot, auditPath), 'utf8');
    if (current !== auditJson) {
      throw new Error('formal audit artifact is stale; run pnpm formal:audit');
    }
    console.log(`formal audit is fresh: ${auditPath}`);
  } else {
    writeFileSync(path.join(repoRoot, auditPath), auditJson, 'utf8');
    console.log(`wrote ${auditPath}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
