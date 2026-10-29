import { writeZipArchive } from './zip';
import { openZipFromBuffer, openEntryStream, type ZipOpenOptions } from './zip-streams';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import type { VerificationBundleArtifactMap } from '@stark-ballot/verification/bundle';

const MAX_PUBLIC_BUNDLE_ENTRY_BYTES = 64 * 1024 * 1024;
const CANONICAL_ARCHIVE_MEMBER_PATTERN = /^[a-z0-9][a-z0-9-]*\.json$/;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

export interface PersistVerificationBundleArtifactsInput {
  sessionId: string;
  verifierWorkDir?: string;
  finalizationId: string;
  artifacts: VerificationBundleArtifactMap;
}

export interface PersistedVerificationBundleArtifacts {
  bundlePath: string;
  sessionId: string;
  finalizationId: string;
}

export interface VerificationBundleArchivePolicy {
  mode: 'sync' | 'async';
  requiredMembers: readonly string[];
  optionalMembers: readonly string[];
  knownPublicMembers: readonly string[];
  neverPublicMembers: readonly string[];
}

export interface VerificationBundleArchiveOptions {
  policy: VerificationBundleArchivePolicy;
}

export interface VerificationBundleArchiveInspection {
  mode: VerificationBundleArchivePolicy['mode'];
  members: readonly string[];
}

function resolveVerifierWorkDir(configuredWorkDir?: string): string {
  const workDir = configuredWorkDir?.trim();
  if (workDir) {
    return path.resolve(workDir);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function resolveBundlePath(baseDir: string, sessionId: string, finalizationId: string): string {
  if (!isSafeVerifierSegment(sessionId)) {
    throw new Error('Invalid sessionId for bundle path');
  }
  if (!isSafeVerifierSegment(finalizationId)) {
    throw new Error('Invalid finalizationId for bundle path');
  }

  const resolvedBaseDir = path.resolve(baseDir);
  const bundlePath = path.resolve(resolvedBaseDir, sessionId, finalizationId);
  const relative = path.relative(resolvedBaseDir, bundlePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Bundle path escapes base directory');
  }

  return bundlePath;
}

export async function persistVerificationBundleArtifacts(
  input: PersistVerificationBundleArtifactsInput,
): Promise<PersistedVerificationBundleArtifacts> {
  const baseDir = resolveVerifierWorkDir(input.verifierWorkDir);
  const bundlePath = resolveBundlePath(baseDir, input.sessionId, input.finalizationId);

  await fs.mkdir(bundlePath, { recursive: true });
  await Promise.all(
    Object.entries(input.artifacts).map(([fileName, payload]) =>
      fs.writeFile(path.join(bundlePath, fileName), JSON.stringify(payload, null, 2), 'utf-8'),
    ),
  );

  return {
    bundlePath,
    sessionId: input.sessionId,
    finalizationId: input.finalizationId,
  };
}

export async function createVerificationBundleArchive(
  bundlePath: string,
  options: VerificationBundleArchiveOptions,
): Promise<string> {
  const archivePath = path.join(bundlePath, 'bundle.zip');
  assertValidArchivePolicy(options.policy);

  try {
    await fs.rm(archivePath, { force: true });
  } catch {
    // noop
  }

  const publicBundleAllowlist = new Set<string>([...options.policy.requiredMembers, ...options.policy.optionalMembers]);
  const entries = await fs.readdir(bundlePath, { withFileTypes: true });
  const filesToInclude = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .filter((entry) => publicBundleAllowlist.has(entry))
    .sort();

  const missingRequiredArtifacts = options.policy.requiredMembers.filter(
    (fileName) => !filesToInclude.includes(fileName),
  );
  if (missingRequiredArtifacts.length > 0) {
    throw new Error(`Missing required public bundle member(s): ${missingRequiredArtifacts.join(', ')}`);
  }

  if (filesToInclude.length === 0) {
    throw new Error('No public JSON artifacts found to archive');
  }

  const zipfile = new yazl.ZipFile();
  for (const fileName of filesToInclude) {
    zipfile.addFile(path.join(bundlePath, fileName), fileName, {
      mtime: new Date(0),
      compress: false,
    });
  }
  await writeZipArchive(zipfile, archivePath);

  try {
    await inspectVerificationBundleArchiveFile(archivePath, options.policy);
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    throw error;
  }

  return archivePath;
}

class PublicBundleArchiveAdmissionError extends Error {
  constructor(reason: string) {
    super(`Invalid public bundle archive: ${reason}`);
    this.name = 'PublicBundleArchiveAdmissionError';
  }
}

const ZIP_OPEN_OPTIONS: ZipOpenOptions = {
  lazyEntries: true,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true,
};

function isCanonicalArchiveMember(member: string): boolean {
  return (
    CANONICAL_ARCHIVE_MEMBER_PATTERN.test(member) &&
    !member.includes('/') &&
    !member.includes('\\') &&
    !member.includes('\0') &&
    path.posix.basename(member) === member &&
    path.posix.normalize(member) === member
  );
}

function assertValidArchivePolicy(policy: VerificationBundleArchivePolicy): void {
  if (!policy.mode.trim()) {
    throw new Error('Invalid public bundle archive policy: mode is required');
  }

  const allowedMembers = [...policy.requiredMembers, ...policy.optionalMembers];
  const knownPublicMembers = new Set(policy.knownPublicMembers);
  const neverPublicMembers = new Set(policy.neverPublicMembers);
  const memberships = [
    ...allowedMembers.map((member) => ({ member, classification: 'allowed' })),
    ...policy.knownPublicMembers.map((member) => ({ member, classification: 'known-public' })),
    ...policy.neverPublicMembers.map((member) => ({ member, classification: 'never-public' })),
  ];

  for (const { member } of memberships) {
    if (!isCanonicalArchiveMember(member)) {
      throw new Error(`Invalid public bundle archive policy: noncanonical member ${member}`);
    }
  }
  for (const member of allowedMembers) {
    if (!knownPublicMembers.has(member)) {
      throw new Error(`Invalid public bundle archive policy: allowed member is not known-public: ${member}`);
    }
    if (neverPublicMembers.has(member)) {
      throw new Error(`Invalid public bundle archive policy: member is both allowed and never-public: ${member}`);
    }
  }

  assertNoDuplicateMembers(policy.requiredMembers, 'required');
  assertNoDuplicateMembers(policy.optionalMembers, 'optional');
  assertNoDuplicateMembers(policy.knownPublicMembers, 'known-public');
  assertNoDuplicateMembers(policy.neverPublicMembers, 'never-public');
  assertNoMembershipOverlap(policy.requiredMembers, policy.optionalMembers, 'required and optional');
  assertNoMembershipOverlap(policy.knownPublicMembers, policy.neverPublicMembers, 'public and never-public');
}

function assertNoDuplicateMembers(members: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const member of members) {
    const caseKey = member.toLowerCase();
    if (seen.has(caseKey)) {
      throw new Error(`Invalid public bundle archive policy: duplicate ${label} member ${member}`);
    }
    seen.add(caseKey);
  }
}

function assertNoMembershipOverlap(first: readonly string[], second: readonly string[], label: string): void {
  const firstMembers = new Set(first.map((member) => member.toLowerCase()));
  const overlap = second.find((member) => firstMembers.has(member.toLowerCase()));
  if (overlap) {
    throw new Error(`Invalid public bundle archive policy: ${label} overlap ${overlap}`);
  }
}

async function consumeEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<void> {
  if (entry.uncompressedSize > MAX_PUBLIC_BUNDLE_ENTRY_BYTES) {
    throw new PublicBundleArchiveAdmissionError(`member exceeds size limit: ${entry.fileName}`);
  }
  const stream = await openEntryStream(zipfile, entry);
  let bytesRead = 0;
  let crc32 = 0xffffffff;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytesRead += buffer.byteLength;
      for (const byte of buffer) {
        const tableIndex = (crc32 ^ byte) & 0xff;
        crc32 = (crc32 >>> 8) ^ (CRC32_TABLE[tableIndex] ?? 0);
      }
      if (bytesRead > MAX_PUBLIC_BUNDLE_ENTRY_BYTES) {
        stream.destroy(new Error('public bundle member exceeds size limit'));
      }
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  if (bytesRead !== entry.uncompressedSize) {
    throw new PublicBundleArchiveAdmissionError(`member is unreadable: ${entry.fileName}`);
  }
  const computedCrc32 = (crc32 ^ 0xffffffff) >>> 0;
  if (computedCrc32 !== entry.crc32 >>> 0) {
    throw new PublicBundleArchiveAdmissionError(`member CRC does not match: ${entry.fileName}`);
  }
}

async function inspectOpenedArchive(
  zipfile: yauzl.ZipFile,
  policy: VerificationBundleArchivePolicy,
): Promise<VerificationBundleArchiveInspection> {
  const allowedMembers = new Set([...policy.requiredMembers, ...policy.optionalMembers]);
  const knownPublicMembers = new Set(policy.knownPublicMembers);
  const neverPublicMembers = new Set(policy.neverPublicMembers);
  const exactMembers = new Set<string>();
  const caseFoldedMembers = new Map<string, string>();
  const admittedMembers: string[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        zipfile.close();
      } catch {
        // Ignore close errors after the admission result is determined.
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    zipfile.on('error', () => finish(new PublicBundleArchiveAdmissionError('archive is malformed or unreadable')));
    zipfile.on('end', () => finish());
    zipfile.on('entry', (entry: yauzl.Entry) => {
      const member = entry.fileName;
      const caseKey = member.toLowerCase();
      if (exactMembers.has(member)) {
        finish(new PublicBundleArchiveAdmissionError(`duplicate public bundle member: ${member}`));
        return;
      }
      const caseConflict = caseFoldedMembers.get(caseKey);
      if (caseConflict) {
        finish(
          new PublicBundleArchiveAdmissionError(
            `case-conflicting public bundle member: ${member} conflicts with ${caseConflict}`,
          ),
        );
        return;
      }
      if (!isCanonicalArchiveMember(member)) {
        finish(new PublicBundleArchiveAdmissionError(`noncanonical public bundle member: ${member}`));
        return;
      }
      exactMembers.add(member);
      caseFoldedMembers.set(caseKey, member);

      if (neverPublicMembers.has(member)) {
        finish(new PublicBundleArchiveAdmissionError(`never-public member is forbidden: ${member}`));
        return;
      }
      if (!allowedMembers.has(member)) {
        finish(
          knownPublicMembers.has(member)
            ? new PublicBundleArchiveAdmissionError(`member is not admitted in ${policy.mode} mode: ${member}`)
            : new PublicBundleArchiveAdmissionError(`unknown public bundle member: ${member}`),
        );
        return;
      }

      admittedMembers.push(member);
      consumeEntry(zipfile, entry)
        .then(() => {
          if (!settled) {
            zipfile.readEntry();
          }
        })
        .catch(() => finish(new PublicBundleArchiveAdmissionError(`member is malformed or unreadable: ${member}`)));
    });
    zipfile.readEntry();
  });

  const missingMembers = policy.requiredMembers.filter((member) => !exactMembers.has(member));
  if (missingMembers.length > 0) {
    throw new PublicBundleArchiveAdmissionError(
      `missing required public bundle member(s): ${missingMembers.join(', ')}`,
    );
  }

  return Object.freeze({
    mode: policy.mode,
    members: Object.freeze(admittedMembers.sort()),
  });
}

export async function inspectVerificationBundleArchiveBuffer(
  buffer: Buffer,
  policy: VerificationBundleArchivePolicy,
): Promise<VerificationBundleArchiveInspection> {
  assertValidArchivePolicy(policy);
  let zipfile: yauzl.ZipFile;
  try {
    zipfile = await openZipFromBuffer(buffer, ZIP_OPEN_OPTIONS);
  } catch {
    throw new PublicBundleArchiveAdmissionError('archive is malformed or unreadable');
  }
  return await inspectOpenedArchive(zipfile, policy);
}

export async function inspectVerificationBundleArchiveFile(
  archivePath: string,
  policy: VerificationBundleArchivePolicy,
): Promise<VerificationBundleArchiveInspection> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(archivePath);
  } catch {
    throw new PublicBundleArchiveAdmissionError('archive is unavailable or unreadable');
  }
  return await inspectVerificationBundleArchiveBuffer(buffer, policy);
}
