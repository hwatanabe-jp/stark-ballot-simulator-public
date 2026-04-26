import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'os';
import path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import * as yazl from 'yazl';
import { persistCliReport, extractBundleArchive } from '../cli-artifacts';
import type { TestResult } from '../cli-test-helpers';
import {
  getArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
});

describe('persistCliReport', () => {
  it('writes report.json and formatted report to disk', async () => {
    const baseDir = await fs.mkdtemp(path.join(tmpdir(), 'cli-artifacts-'));
    cleanupPaths.push(baseDir);

    const results: TestResult[] = [
      {
        name: 'S0',
        passed: true,
        duration: 1200,
        details: {
          verificationStatus: 'success',
          verificationExecutionId: 'exec-1',
          verificationBundleDelivery: 'authenticated-endpoint',
        },
      },
      {
        name: 'S1',
        passed: false,
        duration: 2400,
        details: {
          errors: ['Failed to download bundle'],
        },
      },
    ];

    const reportContent = '# Mock Report\n';

    const { jsonPath, formattedPath } = await persistCliReport({
      sessionId: 'session-123',
      outputFormat: 'markdown',
      reportContent,
      results,
      outputDir: baseDir,
    });

    const jsonExists = await fs
      .stat(jsonPath)
      .then(() => true)
      .catch(() => false);
    const formattedExists = formattedPath
      ? await fs
          .stat(formattedPath)
          .then(() => true)
          .catch(() => false)
      : false;

    expect(jsonExists).toBe(true);
    expect(formattedExists).toBe(true);

    const raw = await fs.readFile(jsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const record = isRecord(parsed) ? parsed : null;
    expect(record).not.toBeNull();
    const summary = getRecordProperty(record, 'summary');
    expect(getNumberProperty(summary, 'total')).toBe(2);
    expect(getNumberProperty(summary, 'failed')).toBe(1);
    const resultEntries = getArrayProperty(record, 'results') ?? [];
    const firstResult = resultEntries[0];
    expect(getStringProperty(firstResult, 'name')).toBe('S0');
    if (!formattedPath) {
      throw new Error('Expected formatted report path to be generated');
    }
    expect(await fs.readFile(formattedPath, 'utf-8')).toBe(reportContent);
  });
});

describe('extractBundleArchive', () => {
  it('extracts bundle zip contents to a deterministic directory', async () => {
    const baseDir = await fs.mkdtemp(path.join(tmpdir(), 'cli-bundle-'));
    cleanupPaths.push(baseDir);

    const zipPath = path.join(baseDir, 'bundle.zip');
    await new Promise((resolve, reject) => {
      const zipfile = new yazl.ZipFile();
      zipfile.addBuffer(Buffer.from('{"ok":true}', 'utf-8'), 'input.json', { mtime: new Date(0), compress: false });
      zipfile.addBuffer(Buffer.from('{"entries":[]}', 'utf-8'), 'journal.json', {
        mtime: new Date(0),
        compress: false,
      });
      const output = createWriteStream(zipPath);
      output.on('close', resolve);
      output.on('error', reject);
      zipfile.outputStream.on('error', reject);
      zipfile.outputStream.pipe(output);
      zipfile.end();
    });

    const extractionPath = await extractBundleArchive({
      sessionId: 'session-456',
      bundlePath: zipPath,
      delivery: 'authenticated-endpoint',
      executionId: 'exec-1',
      outputDir: baseDir,
    });

    const files = await fs.readdir(extractionPath);
    expect(files.sort()).toEqual(['input.json', 'journal.json']);
    expect(extractionPath.startsWith(path.join(baseDir, 'session-456'))).toBe(true);
  });
});
