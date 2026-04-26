import { promises as fs } from 'fs';
import path from 'path';
import type { FinalizationStatusSample, TestResult, VerificationBundleDelivery } from './cli-test-helpers';
import { extractZipFromFile } from '@/lib/utils/zip';

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), '.tmp', 'cli-bundles');

export interface PersistCliReportOptions {
  sessionId: string;
  outputFormat: 'json' | 'table' | 'markdown';
  reportContent: string;
  results: TestResult[];
  outputDir?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PersistCliReportResult {
  jsonPath: string;
  formattedPath?: string;
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
  } = options;

  const sessionDir = path.join(outputDir, sessionId);
  await ensureDirectory(sessionDir);

  const summary = computeSummary(results);
  const reportPayload = {
    sessionId,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    summary,
    results,
  };

  const jsonPath = path.join(sessionDir, 'report.json');
  await fs.writeFile(jsonPath, JSON.stringify(reportPayload, null, 2), 'utf-8');

  let formattedPath: string | undefined;
  if (outputFormat !== 'json') {
    const ext = outputFormat === 'markdown' ? 'md' : 'txt';
    formattedPath = path.join(sessionDir, `report.${ext}`);
    await fs.writeFile(formattedPath, reportContent, 'utf-8');
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

  return { jsonPath, formattedPath };
}

export interface ExtractBundleOptions {
  sessionId: string;
  bundlePath: string;
  delivery: VerificationBundleDelivery;
  executionId?: string;
  outputDir?: string;
}

export async function extractBundleArchive(options: ExtractBundleOptions): Promise<string> {
  const { sessionId, bundlePath, delivery, executionId, outputDir = DEFAULT_OUTPUT_ROOT } = options;

  const sessionBase = path.join(outputDir, sessionId, 'extracted');
  await ensureDirectory(sessionBase);

  const identifier = executionId ?? path.basename(bundlePath, path.extname(bundlePath));
  const extractionDir = path.join(sessionBase, `${identifier}-${delivery}`);

  await fs.rm(extractionDir, { recursive: true, force: true });
  await ensureDirectory(extractionDir);

  await extractZipFromFile(bundlePath, { destination: extractionDir });

  return extractionDir;
}
