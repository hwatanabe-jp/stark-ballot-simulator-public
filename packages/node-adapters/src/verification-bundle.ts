import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as yazl from 'yazl';

export interface PersistVerificationBundleArtifactsInput {
  sessionId: string;
  verifierWorkDir?: string;
  executionId?: string;
  artifacts: Record<string, unknown>;
}

export interface PersistedVerificationBundleArtifacts {
  bundlePath: string;
  sessionId: string;
  executionId: string;
}

export interface VerificationBundleArchiveOptions {
  publicBundleAllowlist: readonly string[];
  requiredPublicBundleArtifacts: readonly string[];
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for bundle path`);
  }
}

function resolveVerifierWorkDir(configuredWorkDir?: string): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.resolve(workDir);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function resolveBundlePath(baseDir: string, sessionId: string, executionId: string): string {
  assertSafePathSegment(sessionId, 'sessionId');
  assertSafePathSegment(executionId, 'executionId');

  const resolvedBaseDir = path.resolve(baseDir);
  const bundlePath = path.resolve(resolvedBaseDir, sessionId, executionId);
  const relative = path.relative(resolvedBaseDir, bundlePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Bundle path escapes base directory');
  }

  return bundlePath;
}

export async function persistVerificationBundleArtifacts(
  input: PersistVerificationBundleArtifactsInput,
): Promise<PersistedVerificationBundleArtifacts> {
  const executionId = input.executionId ?? crypto.randomUUID();
  const baseDir = resolveVerifierWorkDir(input.verifierWorkDir);
  const bundlePath = resolveBundlePath(baseDir, input.sessionId, executionId);

  await fs.mkdir(bundlePath, { recursive: true });
  await Promise.all(
    Object.entries(input.artifacts).map(([fileName, payload]) =>
      fs.writeFile(path.join(bundlePath, fileName), JSON.stringify(payload, null, 2), 'utf-8'),
    ),
  );

  return {
    bundlePath,
    sessionId: input.sessionId,
    executionId,
  };
}

export async function createVerificationBundleArchive(
  bundlePath: string,
  options: VerificationBundleArchiveOptions,
): Promise<string> {
  const archivePath = path.join(bundlePath, 'bundle.zip');

  try {
    await fs.rm(archivePath, { force: true });
  } catch {
    // noop
  }

  const publicBundleAllowlist = new Set<string>(options.publicBundleAllowlist);
  const entries = await fs.readdir(bundlePath, { withFileTypes: true });
  const filesToInclude = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .filter((entry) => publicBundleAllowlist.has(entry))
    .sort();

  const missingRequiredArtifacts = options.requiredPublicBundleArtifacts.filter(
    (fileName) => !filesToInclude.includes(fileName),
  );
  if (missingRequiredArtifacts.length > 0) {
    throw new Error(`Missing required public bundle artifact(s): ${missingRequiredArtifacts.join(', ')}`);
  }

  if (filesToInclude.length === 0) {
    throw new Error('No public JSON artifacts found to archive');
  }

  await new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const fileName of filesToInclude) {
      zipfile.addFile(path.join(bundlePath, fileName), fileName, {
        mtime: new Date(0),
        compress: false,
      });
    }

    const output = createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.on('error', reject);

    zipfile.outputStream.pipe(output);
    zipfile.end();
  });

  return archivePath;
}
