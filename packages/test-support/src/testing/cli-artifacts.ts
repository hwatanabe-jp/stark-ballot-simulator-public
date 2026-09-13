import { promises as fs } from 'fs';
import path from 'path';
import type { FinalizationStatusSample, TestResult, VerificationBundleDelivery } from './cli-test-helpers';
import { extractZipFromFile } from '@stark-ballot/node-adapters/zip';

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), '.tmp', 'cli-bundles');

export interface CliRunEvidence {
  capturedAt: string;
  source: {
    commit: string | null;
    dirty: boolean | null;
    trackedDiffSha256: string | null;
    untrackedSources: Array<{ path: string; sha256: string }> | null;
    untrackedScope: 'manifest-workspaces';
    complete: boolean;
  };
  runtime: {
    node: string;
    pnpmDeclared: string | null;
    pnpmObserved: string | null;
    platform: string;
    architecture: string;
    profile: string;
    server: 'cli-owned' | 'external';
    scenarios: string[];
    imageId: string | null;
    finalizeTimeoutMs: { requested: number | null; effective: number | null };
    rayonThreads: { configured: number | null; observed: null };
    host: { sha256: string | null; unavailableReason: 'not_used' | 'external_server' | 'unavailable' | null };
    verifier: { sha256: string | null; unavailableReason: 'not_used' | 'unavailable' | null };
    rustc: string | null;
    r0vm: string | null;
  };
  issues: string[];
}

export type CliRunFailure = 'setup_failed' | 'run_interrupted';

export interface PersistCliReportOptions {
  sessionId: string;
  outputFormat: 'json' | 'table' | 'markdown';
  reportContent: string;
  results: TestResult[];
  outputDir?: string;
  startedAt?: string;
  finishedAt?: string;
  evidence?: CliRunEvidence;
  runFailure?: CliRunFailure;
}

export interface PersistCliReportResult {
  jsonPath: string;
  formattedPath?: string;
  content: string;
}

interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  duration: number;
}

function computeSummary(results: TestResult[]): ReportSummary {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = total - passed;
  const duration = results.reduce((sum, result) => sum + result.duration, 0);

  return { total, passed, failed, duration };
}

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function persistCliReport(options: PersistCliReportOptions): Promise<PersistCliReportResult> {
  const {
    sessionId,
    outputFormat,
    reportContent,
    results,
    outputDir = DEFAULT_OUTPUT_ROOT,
    startedAt,
    finishedAt,
    evidence,
    runFailure,
  } = options;

  const sessionDir = path.join(outputDir, sessionId);
  await ensureDirectory(sessionDir);

  const summary = computeSummary(results);
  const scenarioExecution = evidence?.runtime.scenarios.map((scenario) => {
    const result = results.find((entry) => entry.name === scenario || entry.name.startsWith(`${scenario}:`));
    return result
      ? { scenario, status: result.passed ? 'passed' : 'failed', reason: null }
      : { scenario, status: 'not_run', reason: runFailure ?? 'run_interrupted' };
  });
  const reportPayload = {
    sessionId,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    summary,
    results,
    ...(evidence ? { evidence, scenarioExecution, runFailure: runFailure ?? null } : {}),
  };

  const jsonPath = path.join(sessionDir, 'report.json');
  const jsonContent = JSON.stringify(reportPayload, null, 2);
  await fs.writeFile(jsonPath, jsonContent, 'utf-8');

  const evidenceContent = evidence
    ? JSON.stringify({ evidence, scenarioExecution, runFailure: runFailure ?? null }, null, 2)
    : null;
  const content =
    outputFormat === 'json'
      ? jsonContent
      : reportContent +
        (evidenceContent
          ? outputFormat === 'markdown'
            ? `\n## Run evidence\n\n\`\`\`json\n${evidenceContent}\n\`\`\`\n`
            : `\nRun evidence:\n${evidenceContent}\n`
          : '');

  let formattedPath: string | undefined;
  if (outputFormat !== 'json') {
    const ext = outputFormat === 'markdown' ? 'md' : 'txt';
    formattedPath = path.join(sessionDir, `report.${ext}`);
    await fs.writeFile(formattedPath, content, 'utf-8');
  } else {
    formattedPath = jsonPath;
  }

  const historyByTest = results.reduce<Record<string, FinalizationStatusSample[]>>((acc, result) => {
    const history = result.details.finalizationHistory;
    if (history && history.length > 0) {
      acc[result.name] = history;
    }
    return acc;
  }, {});

  if (Object.keys(historyByTest).length > 0) {
    const historyPath = path.join(sessionDir, 'finalization-polling-history.json');
    await fs.writeFile(historyPath, JSON.stringify(historyByTest, null, 2), 'utf-8');
  }

  return { jsonPath, formattedPath, content };
}

export interface ExtractBundleOptions {
  sessionId: string;
  bundlePath: string;
  delivery: VerificationBundleDelivery;
  finalizationId?: string;
  outputDir?: string;
}

export async function extractBundleArchive(options: ExtractBundleOptions): Promise<string> {
  const { sessionId, bundlePath, delivery, finalizationId, outputDir = DEFAULT_OUTPUT_ROOT } = options;

  const sessionBase = path.join(outputDir, sessionId, 'extracted');
  await ensureDirectory(sessionBase);

  const identifier = finalizationId ?? path.basename(bundlePath, path.extname(bundlePath));
  const extractionDir = path.join(sessionBase, `${identifier}-${delivery}`);

  await fs.rm(extractionDir, { recursive: true, force: true });
  await ensureDirectory(extractionDir);

  await extractZipFromFile(bundlePath, { destination: extractionDir });

  return extractionDir;
}
