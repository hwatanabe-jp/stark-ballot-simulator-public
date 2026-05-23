#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_AGE_HOURS = 14 * 24;
const MS_PER_HOUR = 60 * 60 * 1000;

const WORKFLOW_CHECKS = [
  { label: 'Public Core Checks', workflowFile: 'public-core-checks.yml' },
  { label: 'Public CLI Tests', workflowFile: 'public-cli-tests.yml' },
  { label: 'Public Docs Checks', workflowFile: 'public-docs-checks.yml' },
  { label: 'Public Security Scan', workflowFile: 'public-security-scan.yml' },
  { label: 'Public UI Mock E2E', workflowFile: 'public-ui-mock-e2e.yml' },
  { label: 'Public Rust Checks', workflowFile: 'public-rust-checks.yml' },
] as const;

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type OverallStatus = 'green' | 'attention';

export interface CliOptions {
  outputPath?: string;
  repository?: string;
  maxAgeHours: number;
  now: Date;
}

export interface MonitorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  url?: string;
}

interface PublicMarker {
  sourceSha?: string;
  generatedAt?: string;
}

interface PublicManifestSummary {
  copiedFileCount?: number;
  generatedFileCount?: number;
}

export interface GhWorkflowRun {
  conclusion: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  headSha?: string;
  event?: string;
}

interface MonitorReport {
  title: string;
  week: string;
  overall: OverallStatus;
  marker: PublicMarker;
  manifest: PublicManifestSummary;
  directChecks: MonitorCheck[];
  workflowChecks: MonitorCheck[];
  repository?: string;
  currentRunUrl?: string;
  liveDemoUrl?: string;
  specsUrl?: string;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    now: new Date(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      options.outputPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === '--repo') {
      options.repository = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === '--max-age-hours') {
      const rawValue = readOptionValue(argv, index, arg);
      const parsed = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--max-age-hours must be a positive integer: ${rawValue}`);
      }
      options.maxAgeHours = parsed;
      index += 1;
    } else if (arg === '--now') {
      const rawValue = readOptionValue(argv, index, arg);
      const parsed = new Date(rawValue);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--now must be an ISO-8601 timestamp: ${rawValue}`);
      }
      options.now = parsed;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readOptionValue(argv: readonly string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm tsx scripts/showcase/public-weekly-monitor.ts [options]

Options:
  --output <path>          Write the Markdown issue body to a file instead of stdout.
  --repo <owner/repo>      GitHub repository to query. Defaults to GH_REPO or GITHUB_REPOSITORY.
  --max-age-hours <hours>  Mark workflow checks stale after this age. Default: ${DEFAULT_MAX_AGE_HOURS}.
  --now <iso-timestamp>    Override the current time for deterministic local checks.
`);
}

function readPublicMarker(): PublicMarker {
  if (!existsSync('.public-repository')) {
    return {};
  }

  const entries = readFileSync('.public-repository', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 0) {
        return undefined;
      }
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined);

  const values = new Map(entries);
  return {
    sourceSha: values.get('SOURCE_SHA'),
    generatedAt: values.get('GENERATED_AT'),
  };
}

function readPublicManifestSummary(): PublicManifestSummary {
  if (!existsSync('.public-export-manifest.json')) {
    return {};
  }

  const parsed: unknown = JSON.parse(readFileSync('.public-export-manifest.json', 'utf8'));
  if (!isRecord(parsed)) {
    return {};
  }

  return {
    copiedFileCount: readNumber(parsed, 'copiedFileCount'),
    generatedFileCount: Array.isArray(parsed.generatedFiles) ? parsed.generatedFiles.length : undefined,
  };
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRepository(options: CliOptions): string | undefined {
  return options.repository ?? process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
}

function resolveCurrentRunUrl(repository: string | undefined): string | undefined {
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) {
    return undefined;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function buildReport(options: CliOptions): MonitorReport {
  const repository = resolveRepository(options);
  const directChecks = buildDirectChecks();
  const workflowChecks = WORKFLOW_CHECKS.map((check) => queryWorkflowCheck(check, repository, options));
  const allChecks = [...directChecks, ...workflowChecks];
  const overall = deriveOverallStatus(allChecks);
  const week = formatIsoWeek(options.now);

  return {
    title: `Weekly public monitor: ${week}`,
    week,
    overall,
    marker: readPublicMarker(),
    manifest: readPublicManifestSummary(),
    directChecks,
    workflowChecks,
    repository,
    currentRunUrl: resolveCurrentRunUrl(repository),
    liveDemoUrl: process.env.PUBLIC_LIVE_DEMO_URL,
    specsUrl: process.env.PUBLIC_SPECS_URL,
  };
}

export function deriveOverallStatus(checks: readonly Pick<MonitorCheck, 'status'>[]): OverallStatus {
  return checks.some((check) => check.status === 'fail') ? 'attention' : 'green';
}

export function buildDirectChecks(): MonitorCheck[] {
  const publicSafetyOutcome = process.env.WEEKLY_PUBLIC_SAFETY_SCAN_OUTCOME;
  if (!publicSafetyOutcome) {
    return [];
  }

  return [
    {
      label: 'Weekly public safety scan',
      status: publicSafetyOutcome === 'success' ? 'pass' : 'fail',
      detail:
        publicSafetyOutcome === 'success' ? 'passed in this monitor run' : `completed with ${publicSafetyOutcome}`,
    },
  ];
}

function queryWorkflowCheck(
  check: (typeof WORKFLOW_CHECKS)[number],
  repository: string | undefined,
  options: CliOptions,
): MonitorCheck {
  if (!repository) {
    return {
      label: check.label,
      status: 'fail',
      detail: 'GH_REPO or GITHUB_REPOSITORY was not set',
    };
  }

  const args = [
    'run',
    'list',
    '--repo',
    repository,
    '--workflow',
    check.workflowFile,
    '--limit',
    '1',
    '--json',
    'conclusion,status,createdAt,updatedAt,url,headSha,event',
  ];

  try {
    const runs = parseWorkflowRuns(execGhJson(args));
    if (runs.length === 0) {
      return {
        label: check.label,
        status: 'fail',
        detail: 'no workflow runs found',
      };
    }
    return summarizeWorkflowRun(check.label, runs[0], options);
  } catch (error) {
    return {
      label: check.label,
      status: 'fail',
      detail: `could not query workflow runs: ${formatError(error)}`,
    };
  }
}

function execGhJson(args: readonly string[]): unknown {
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function parseWorkflowRuns(value: unknown): GhWorkflowRun[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub CLI returned a non-array workflow response');
  }
  return value.filter(isGhWorkflowRun);
}

function isGhWorkflowRun(value: unknown): value is GhWorkflowRun {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.conclusion === 'string' || value.conclusion === null) &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.url === 'string' &&
    (typeof value.headSha === 'string' || value.headSha === undefined) &&
    (typeof value.event === 'string' || value.event === undefined)
  );
}

export function summarizeWorkflowRun(label: string, run: GhWorkflowRun, options: CliOptions): MonitorCheck {
  const updatedAtMs = Date.parse(run.updatedAt || run.createdAt);
  if (Number.isNaN(updatedAtMs)) {
    return {
      label,
      status: 'fail',
      detail: 'GitHub CLI returned an invalid workflow timestamp',
      url: run.url,
    };
  }

  const ageHours = Math.max(0, (options.now.getTime() - updatedAtMs) / MS_PER_HOUR);
  const age = formatAge(ageHours);
  const suffix = run.headSha ? `, ${run.headSha.slice(0, 7)}` : '';

  if (run.status !== 'completed') {
    return {
      label,
      status: 'fail',
      detail: `${run.status}, updated ${age} ago${suffix}`,
      url: run.url,
    };
  }

  if (run.conclusion !== 'success') {
    return {
      label,
      status: 'fail',
      detail: `${run.conclusion ?? 'unknown conclusion'}, updated ${age} ago${suffix}`,
      url: run.url,
    };
  }

  if (ageHours > options.maxAgeHours) {
    return {
      label,
      status: 'warn',
      detail: `success but stale, updated ${age} ago${suffix}`,
      url: run.url,
    };
  }

  return {
    label,
    status: 'pass',
    detail: `success, updated ${age} ago${suffix}`,
    url: run.url,
  };
}

function formatAge(ageHours: number): string {
  if (ageHours < 1) {
    return '<1 hour';
  }
  if (ageHours < 48) {
    return `${Math.round(ageHours)} hours`;
  }
  return `${Math.round(ageHours / 24)} days`;
}

export function formatIsoWeek(date: Date): string {
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((normalized.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${normalized.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function renderMarkdown(report: MonitorReport): string {
  const statusLabel = report.overall === 'green' ? 'Green' : 'Attention';
  const lines = [
    `# ${report.title}`,
    '',
    `Status: ${statusLabel}`,
    '',
    '## Public Snapshot',
    `- Source commit: ${formatCode(report.marker.sourceSha ?? 'unknown')}`,
    `- Generated at: ${formatCode(report.marker.generatedAt ?? 'unknown')}`,
    '- Public repository profile: `showcase-safe`',
  ];

  if (report.manifest.copiedFileCount !== undefined) {
    lines.push(`- Copied source files: \`${report.manifest.copiedFileCount}\``);
  }
  if (report.manifest.generatedFileCount !== undefined) {
    lines.push(`- Generated public files: \`${report.manifest.generatedFileCount}\``);
  }

  if (report.directChecks.length > 0) {
    lines.push('', '## Weekly Direct Checks', renderChecksTable(report.directChecks));
  }

  lines.push('', '## Public CI Health', renderChecksTable(report.workflowChecks));
  lines.push('', '_Stale workflow runs are shown for review context, but they do not fail this public-safe monitor._');

  lines.push(
    '',
    '## Public Boundary',
    'This monitor does not access AWS credentials, Terraform state, private artifacts, private monitoring queries, or credentialed runbooks.',
  );

  const reviewLinks = buildReviewLinks(report);
  if (reviewLinks.length > 0) {
    lines.push('', '## Review Links', ...reviewLinks);
  }

  lines.push('');
  return lines.join('\n');
}

function renderChecksTable(checks: readonly MonitorCheck[]): string {
  const rows = ['| Check | Status | Detail |', '| --- | --- | --- |'];
  for (const check of checks) {
    const detail = check.url ? `${escapeTableCell(check.detail)} ([run](${check.url}))` : escapeTableCell(check.detail);
    rows.push(`| ${escapeTableCell(check.label)} | ${renderStatus(check.status)} | ${detail} |`);
  }
  return rows.join('\n');
}

function renderStatus(status: CheckStatus): string {
  if (status === 'pass') {
    return 'pass';
  }
  if (status === 'warn') {
    return 'stale';
  }
  return 'fail';
}

function buildReviewLinks(report: MonitorReport): string[] {
  const links: string[] = [];
  if (report.liveDemoUrl) {
    links.push(`- Live demo: ${report.liveDemoUrl}`);
  }
  if (report.specsUrl) {
    links.push(`- Public specs: ${report.specsUrl}`);
  }
  if (report.currentRunUrl) {
    links.push(`- Monitor workflow run: ${report.currentRunUrl}`);
  }
  return links;
}

function formatCode(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writeOutputFile(outputPath: string, markdown: string): void {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, 'utf8');
}

function writeGithubOutputs(report: MonitorReport): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(
    outputPath,
    [
      `title=${report.title}`,
      `status=${report.overall}`,
      `should_close=${report.overall === 'green' ? 'true' : 'false'}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = buildReport(options);
    const markdown = renderMarkdown(report);
    if (options.outputPath) {
      writeOutputFile(options.outputPath, markdown);
    } else {
      process.stdout.write(markdown);
    }
    writeGithubOutputs(report);
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}

function isDirectInvocation(): boolean {
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectInvocation()) {
  main();
}
