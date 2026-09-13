import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CliRunEvidence } from '@stark-ballot/test-support/testing/cli-artifacts';
import { loadRepositoryWorkspaceMetadata } from '../../../tooling/workspace/workspace-metadata';

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_UNTRACKED_SOURCES = 256;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|rs|lean|sh|json|toml|ya?ml)$/;
const SAFE_SOURCE_PATH = /^(?:[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_@.-]+$/;

export interface CollectCliRunEvidenceOptions {
  projectRoot: string;
  profile: string;
  scenarios: string[];
  useRealZkVM: boolean;
  externalServer: boolean;
  finalizeTimeoutMs: number | null;
  environment?: NodeJS.ProcessEnv;
  ownedSourceRoots?: readonly string[];
}

/** Safe initial conditions retained even when asynchronous metadata collection fails. */
export function initialCliRunEvidence(options: CollectCliRunEvidenceOptions): CliRunEvidence {
  const environment = options.environment ?? process.env;
  const imageId = environment['EXPECTED_IMAGE_ID'];
  return {
    capturedAt: new Date().toISOString(),
    source: {
      commit: null,
      dirty: null,
      trackedDiffSha256: null,
      untrackedSources: null,
      untrackedScope: 'manifest-workspaces',
      complete: false,
    },
    runtime: {
      node: process.versions.node,
      pnpmDeclared: null,
      pnpmObserved: null,
      platform: process.platform,
      architecture: process.arch,
      profile: options.profile,
      server: options.externalServer ? 'external' : 'cli-owned',
      scenarios: [...options.scenarios],
      imageId: imageId && /^0x[0-9a-f]{64}$/i.test(imageId) ? imageId : null,
      finalizeTimeoutMs: {
        requested: positiveNumber(environment['CLI_FINALIZE_TIMEOUT_MS']),
        effective: options.finalizeTimeoutMs,
      },
      rayonThreads: { configured: positiveNumber(environment['RAYON_NUM_THREADS']), observed: null },
      host: {
        sha256: null,
        unavailableReason: !options.useRealZkVM
          ? 'not_used'
          : options.externalServer
            ? 'external_server'
            : 'unavailable',
      },
      verifier: { sha256: null, unavailableReason: options.useRealZkVM ? 'unavailable' : 'not_used' },
      rustc: null,
      r0vm: null,
    },
    issues: ['run_metadata_unavailable'],
  };
}

function positiveNumber(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function command(commandName: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(commandName, args, {
    cwd,
    timeout: 2000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

async function fileHash(filePath: string, maxBytes: number): Promise<string> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('Unsupported evidence file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(maxBytes, 1024 * 1024));
    const deadline = Date.now() + 5000;
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes || Date.now() > deadline) throw new Error('Evidence file limit exceeded');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Evidence file changed during collection');
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function sourceHash(projectRoot: string, sourcePath: string): Promise<string> {
  // Do not follow an untracked directory symlink to read a file outside the source tree.
  const parts = sourcePath.split('/');
  for (let length = 1; length < parts.length; length++) {
    if (!(await lstat(path.join(projectRoot, ...parts.slice(0, length)))).isDirectory()) {
      throw new Error('Unsupported evidence directory');
    }
  }
  return fileHash(path.join(projectRoot, sourcePath), MAX_SOURCE_BYTES);
}

async function collectSource(
  options: CollectCliRunEvidenceOptions,
  issues: string[],
): Promise<CliRunEvidence['source']> {
  const source = initialCliRunEvidence(options).source;
  try {
    const commit = (await command('git', ['rev-parse', '--verify', 'HEAD'], options.projectRoot)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit');
    source.commit = commit;
    source.dirty =
      (await command('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options.projectRoot))
        .length > 0;
    const diff = await command(
      'git',
      ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--'],
      options.projectRoot,
    );
    source.trackedDiffSha256 = createHash('sha256').update(diff).digest('hex');
    const roots =
      options.ownedSourceRoots ?? loadRepositoryWorkspaceMetadata(options.projectRoot).map(({ root }) => root);
    const untracked = (await command('git', ['ls-files', '--others', '--exclude-standard', '-z'], options.projectRoot))
      .split('\0')
      .filter(Boolean)
      .sort();
    const sources = untracked.filter((entry) => SOURCE_EXTENSION.test(entry));
    source.untrackedSources = [];
    source.complete = true;
    if (sources.length > MAX_UNTRACKED_SOURCES) {
      source.complete = false;
      issues.push('source_untracked_limit');
    }
    for (const entry of sources.slice(0, MAX_UNTRACKED_SOURCES)) {
      if (
        !roots.some((root) => entry.startsWith(`${root}/`)) ||
        !SAFE_SOURCE_PATH.test(entry) ||
        entry.split('/').some((part) => part.startsWith('.') || /(?:secret|credential|private|\.local\.)/i.test(part))
      ) {
        source.complete = false;
        issues.push('source_untracked_excluded');
        continue;
      }
      try {
        source.untrackedSources.push({ path: entry, sha256: await sourceHash(options.projectRoot, entry) });
      } catch {
        source.complete = false;
        issues.push('source_untracked_unavailable');
      }
    }
  } catch {
    issues.push('source_metadata_unavailable');
  }
  return source;
}

async function observedVersion(name: string, root: string, issues: string[]): Promise<string | null> {
  try {
    const output = (await command(name, ['--version'], root)).trim();
    const version = /^(?:pnpm |rustc |risc0-r0vm )?(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)(?:\s|$)/i.exec(output)?.[1];
    if (!version) throw new Error('Invalid version');
    return version;
  } catch {
    issues.push(`${name}_version_unavailable`);
    return null;
  }
}

async function binaryHash(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    // Match the first executable selected by the adapter; never hash a later fallback instead.
    try {
      return await fileHash(candidate, MAX_BINARY_BYTES);
    } catch {
      return null;
    }
  }
  return null;
}

/** Collect only bounded, allowlisted conditions; raw process errors, environment and diff never leave here. */
export async function collectCliRunEvidence(options: CollectCliRunEvidenceOptions): Promise<CliRunEvidence> {
  const initial = initialCliRunEvidence(options);
  const environment = options.environment ?? process.env;
  const issues: string[] = [];
  const source = await collectSource(options, issues);
  let pnpmDeclared: string | null = null;
  try {
    const manifest: unknown = JSON.parse(await readFile(path.join(options.projectRoot, 'package.json'), 'utf8'));
    if (typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest) {
      const value = manifest.packageManager;
      if (typeof value === 'string') pnpmDeclared = /^pnpm@(\d+\.\d+\.\d+)(?:\+|$)/.exec(value)?.[1] ?? null;
    }
    if (!pnpmDeclared) issues.push('pnpm_declaration_unavailable');
  } catch {
    issues.push('pnpm_declaration_unavailable');
  }
  const pnpmObserved = await observedVersion('pnpm', options.projectRoot, issues);
  const hostHash =
    options.useRealZkVM && !options.externalServer
      ? await binaryHash([path.join(options.projectRoot, 'zkvm/target/release/host')])
      : null;
  const verifierHash = options.useRealZkVM
    ? await binaryHash([
        ...(environment['VERIFIER_SERVICE_BIN'] ? [environment['VERIFIER_SERVICE_BIN']] : []),
        path.join(options.projectRoot, 'verifier-service/target/release/verifier-service'),
        path.join(options.projectRoot, 'verifier-service/target/debug/verifier-service'),
      ])
    : null;
  if (environment['RAYON_NUM_THREADS'] && initial.runtime.rayonThreads.configured === null) {
    issues.push('rayon_setting_invalid');
  }
  if (environment['CLI_FINALIZE_TIMEOUT_MS'] && initial.runtime.finalizeTimeoutMs.requested === null) {
    issues.push('finalize_timeout_invalid');
  }
  if (options.useRealZkVM && !options.externalServer && !hostHash) issues.push('host_binary_unavailable');
  if (options.useRealZkVM && !verifierHash) issues.push('verifier_binary_unavailable');
  return {
    ...initial,
    source,
    runtime: {
      ...initial.runtime,
      pnpmDeclared,
      pnpmObserved,
      host: {
        sha256: hostHash,
        unavailableReason: !options.useRealZkVM
          ? 'not_used'
          : options.externalServer
            ? 'external_server'
            : hostHash
              ? null
              : 'unavailable',
      },
      verifier: {
        sha256: verifierHash,
        unavailableReason: !options.useRealZkVM ? 'not_used' : verifierHash ? null : 'unavailable',
      },
      rustc: options.useRealZkVM ? await observedVersion('rustc', options.projectRoot, issues) : null,
      r0vm: options.useRealZkVM ? await observedVersion('r0vm', options.projectRoot, issues) : null,
    },
    issues: [...new Set(issues)],
  };
}
