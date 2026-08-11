#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.lake',
  '.next',
  '.tmp',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'target',
  'test-results',
]);

const REVIEWED_HISTORICAL_REFERENCES_PATH = 'scripts/docs/reviewed-historical-markdown-references.json';

interface MarkdownReference {
  destination: string;
  line: number;
}

interface ReviewedHistoricalReference {
  sourcePath: string;
  line: number;
  destination: string;
}

interface ReviewedHistoricalReferenceManifest {
  historicalRoots: string[];
  references: ReviewedHistoricalReference[];
}

export interface MarkdownLinkProblem {
  sourcePath: string;
  line: number;
  destination: string;
  reason: 'outside-root' | 'missing-target' | 'missing-anchor' | 'missing-reference';
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  return Object.keys(value).sort(compareText).join('\0') === [...expectedKeys].sort(compareText).join('\0');
}

function reviewedHistoricalReferenceKey(reference: ReviewedHistoricalReference): string {
  return `${reference.sourcePath}\0${reference.line}\0${reference.destination}`;
}

function parseReviewedHistoricalReference(value: unknown, index: number): ReviewedHistoricalReference {
  const location = `${REVIEWED_HISTORICAL_REFERENCES_PATH}.references[${index}]`;
  if (!isRecord(value) || !hasExactKeys(value, ['destination', 'line', 'sourcePath'])) {
    throw new Error(`${location} must contain exactly sourcePath, line, and destination`);
  }

  const sourcePath = value['sourcePath'];
  const line = value['line'];
  const destination = value['destination'];
  if (typeof sourcePath !== 'string' || path.posix.normalize(sourcePath) !== sourcePath || /[*?[\]]/.test(sourcePath)) {
    throw new Error(`${location}.sourcePath must be an exact normalized repository path`);
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new Error(`${location}.line must be a positive integer`);
  }
  if (typeof destination !== 'string' || destination.length === 0 || /[*?[\]]/.test(destination)) {
    throw new Error(`${location}.destination must be an exact non-empty link destination`);
  }

  return { sourcePath, line, destination };
}

function parseHistoricalRoot(value: unknown, index: number): string {
  const location = `${REVIEWED_HISTORICAL_REFERENCES_PATH}.historicalRoots[${index}]`;
  if (
    typeof value !== 'string' ||
    !value.endsWith('/') ||
    path.posix.normalize(value) !== value ||
    /[*?[\]]/.test(value)
  ) {
    throw new Error(`${location} must be an exact normalized repository directory prefix`);
  }
  return value;
}

function loadReviewedHistoricalReferenceManifest(root: string): ReviewedHistoricalReferenceManifest {
  const manifestPath = path.join(root, REVIEWED_HISTORICAL_REFERENCES_PATH);
  if (!existsSync(manifestPath)) {
    return { historicalRoots: [], references: [] };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${REVIEWED_HISTORICAL_REFERENCES_PATH} is not valid JSON: ${message}`);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['historicalRoots', 'references']) ||
    !Array.isArray(value['historicalRoots']) ||
    !Array.isArray(value['references'])
  ) {
    throw new Error(
      `${REVIEWED_HISTORICAL_REFERENCES_PATH} must contain exactly historicalRoots and references arrays`,
    );
  }

  const historicalRoots = value['historicalRoots'].map(parseHistoricalRoot);
  const references = value['references'].map(parseReviewedHistoricalReference);
  for (const reference of references) {
    if (!historicalRoots.some((historicalRoot) => reference.sourcePath.startsWith(historicalRoot))) {
      throw new Error(
        `${REVIEWED_HISTORICAL_REFERENCES_PATH}: reviewed historical reference source must be under an approved historical root`,
      );
    }
  }
  const keys = new Set<string>();
  for (const reference of references) {
    const key = reviewedHistoricalReferenceKey(reference);
    if (keys.has(key)) {
      throw new Error(`${REVIEWED_HISTORICAL_REFERENCES_PATH} contains a duplicate reviewed reference`);
    }
    keys.add(key);
  }
  return { historicalRoots, references };
}

function toRepoPath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function shouldSkipDirectory(root: string, absolutePath: string): boolean {
  const relativePath = toRepoPath(root, absolutePath);
  if (relativePath === 'public-book/book') {
    return true;
  }
  return relativePath.split('/').some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(root, absolutePath)) {
          visit(absolutePath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(absolutePath);
      }
    }
  }

  visit(root);
  return files.sort(compareText);
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (text[offset] === '\n') {
      line += 1;
    }
  }
  return line;
}

function parseDestination(rawDestination: string): string {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith('<')) {
    const closingBracket = trimmed.indexOf('>');
    return closingBracket >= 0 ? trimmed.slice(1, closingBracket) : trimmed;
  }
  const titleStart = trimmed.search(/\s+["']/);
  return titleStart >= 0 ? trimmed.slice(0, titleStart) : trimmed;
}

function maskMarkdownRange(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

function maskIgnoredMarkdown(markdown: string): string {
  let insideFence: { marker: '`' | '~'; length: number } | undefined;
  const withoutFences = markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (insideFence === undefined && fence?.[1]) {
        insideFence = {
          marker: fence[1][0] as '`' | '~',
          length: fence[1].length,
        };
        return maskMarkdownRange(line);
      }
      if (insideFence !== undefined) {
        const closingFence = new RegExp(`^\\s*${insideFence.marker}{${insideFence.length},}\\s*$`);
        const masked = maskMarkdownRange(line);
        if (closingFence.test(line.trimEnd())) {
          insideFence = undefined;
        }
        return masked;
      }
      return line;
    })
    .join('');

  return withoutFences
    .replace(/<!--[\s\S]*?(?:-->|$)/g, maskMarkdownRange)
    .replace(/(`+)[^\r\n]*?\1/g, maskMarkdownRange);
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function collectMissingReferenceDefinitions(markdown: string): MarkdownReference[] {
  const definitions = new Set<string>();
  for (const match of markdown.matchAll(/^\s*\[([^\]]+)\]:\s*\S+/gm)) {
    const label = match[1];
    if (label !== undefined) {
      definitions.add(normalizeReferenceLabel(label));
    }
  }

  const missing: MarkdownReference[] = [];
  for (const match of markdown.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const linkText = match[1];
    const explicitLabel = match[2];
    if (linkText === undefined || explicitLabel === undefined) {
      continue;
    }
    const label = normalizeReferenceLabel(explicitLabel || linkText);
    if (!definitions.has(label)) {
      missing.push({
        destination: `[${explicitLabel || linkText}]`,
        line: lineNumberAt(markdown, match.index),
      });
    }
  }
  return missing;
}

function collectMarkdownReferences(markdown: string): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>\n]+>|(?:\\.|[^()\n]|\([^()\n]*\))+)\)/g,
    /^\s*\[[^\]]+\]:\s*(\S+)/gm,
    /\bhref=["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const rawDestination = match[1];
      if (rawDestination === undefined) {
        continue;
      }
      references.push({
        destination: parseDestination(rawDestination),
        line: lineNumberAt(markdown, match.index),
      });
    }
  }

  return references;
}

function decodeLinkComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHeadingAnchor(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function collectMarkdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const headingCounts = new Map<string, number>();
  let insideFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading !== undefined) {
      const baseAnchor = normalizeHeadingAnchor(heading);
      const duplicateCount = headingCounts.get(baseAnchor) ?? 0;
      headingCounts.set(baseAnchor, duplicateCount + 1);
      anchors.add(duplicateCount === 0 ? baseAnchor : `${baseAnchor}-${duplicateCount}`);
    }

    for (const match of line.matchAll(/\bid=["']([^"']+)["']/g)) {
      const explicitId = match[1];
      if (explicitId !== undefined) {
        anchors.add(explicitId);
      }
    }
  }

  return anchors;
}

function isExternalDestination(destination: string): boolean {
  return (
    destination.length === 0 ||
    destination.startsWith('/') ||
    destination.startsWith('//') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination)
  );
}

function isPathInsideRoot(root: string, targetPath: string): boolean {
  const relativePath = path.relative(root, targetPath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..');
}

export function findBrokenMarkdownLinks(rootPath: string): MarkdownLinkProblem[] {
  const root = path.resolve(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Markdown link root is not a directory: ${root}`);
  }

  const { references: reviewedHistoricalReferences } = loadReviewedHistoricalReferenceManifest(root);
  const problems: MarkdownLinkProblem[] = [];
  const anchorCache = new Map<string, Set<string>>();

  for (const sourceFile of collectMarkdownFiles(root)) {
    const markdown = readFileSync(sourceFile, 'utf8');
    const scannableMarkdown = maskIgnoredMarkdown(markdown);

    for (const missingReference of collectMissingReferenceDefinitions(scannableMarkdown)) {
      problems.push({
        sourcePath: toRepoPath(root, sourceFile),
        line: missingReference.line,
        destination: missingReference.destination,
        reason: 'missing-reference',
      });
    }

    for (const reference of collectMarkdownReferences(scannableMarkdown)) {
      const destination = reference.destination;
      if (isExternalDestination(destination) || destination.startsWith('#')) {
        if (!destination.startsWith('#')) {
          continue;
        }
      }

      const [rawTarget = '', rawAnchor] = destination.split('#', 2);
      const targetWithoutQuery = rawTarget.split('?', 1)[0] ?? '';
      const decodedTarget = decodeLinkComponent(targetWithoutQuery);
      const targetPath = decodedTarget ? path.resolve(path.dirname(sourceFile), decodedTarget) : sourceFile;

      if (!isPathInsideRoot(root, targetPath)) {
        problems.push({
          sourcePath: toRepoPath(root, sourceFile),
          line: reference.line,
          destination,
          reason: 'outside-root',
        });
        continue;
      }

      if (!existsSync(targetPath)) {
        problems.push({
          sourcePath: toRepoPath(root, sourceFile),
          line: reference.line,
          destination,
          reason: 'missing-target',
        });
        continue;
      }

      if (rawAnchor === undefined || path.extname(targetPath).toLocaleLowerCase('en') !== '.md') {
        continue;
      }

      const decodedAnchor = decodeLinkComponent(rawAnchor);
      const targetAnchors = anchorCache.get(targetPath) ?? collectMarkdownAnchors(readFileSync(targetPath, 'utf8'));
      anchorCache.set(targetPath, targetAnchors);
      if (!targetAnchors.has(decodedAnchor)) {
        problems.push({
          sourcePath: toRepoPath(root, sourceFile),
          line: reference.line,
          destination,
          reason: 'missing-anchor',
        });
      }
    }
  }

  const reviewableProblems = new Set(
    problems
      .filter((problem) => problem.reason === 'missing-target' || problem.reason === 'missing-anchor')
      .map(reviewedHistoricalReferenceKey),
  );
  for (const reference of reviewedHistoricalReferences) {
    if (!reviewableProblems.has(reviewedHistoricalReferenceKey(reference))) {
      throw new Error(
        `${REVIEWED_HISTORICAL_REFERENCES_PATH}: stale reviewed historical reference ${reference.sourcePath}:${reference.line} -> ${reference.destination}`,
      );
    }
  }

  const reviewedKeys = new Set(reviewedHistoricalReferences.map(reviewedHistoricalReferenceKey));
  return problems
    .filter((problem) => !reviewedKeys.has(reviewedHistoricalReferenceKey(problem)))
    .sort((left, right) => {
      const pathOrder = compareText(left.sourcePath, right.sourcePath);
      if (pathOrder !== 0) return pathOrder;
      if (left.line !== right.line) return left.line - right.line;
      return compareText(left.destination, right.destination);
    });
}

export function assertMarkdownLinksValid(rootPath: string): void {
  const problems = findBrokenMarkdownLinks(rootPath);
  if (problems.length === 0) {
    return;
  }

  throw new Error(
    [
      `Broken local Markdown references found under ${path.resolve(rootPath)}:`,
      ...problems.map(
        (problem) => `  - ${problem.sourcePath}:${problem.line} -> ${problem.destination} (${problem.reason})`,
      ),
    ].join('\n'),
  );
}

function parseRootArgument(args: readonly string[]): string {
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--root') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--root requires a directory path.');
      }
      root = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: pnpm docs:links:check -- --root <generated-public-tree>');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (root !== undefined) {
    return root;
  }
  if (existsSync(path.join(process.cwd(), '.public-repository'))) {
    return process.cwd();
  }
  throw new Error('--root is required outside a generated public repository.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const root = parseRootArgument(process.argv.slice(2));
    assertMarkdownLinksValid(root);
    console.log(`Markdown links are valid under ${path.resolve(root)}.`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
