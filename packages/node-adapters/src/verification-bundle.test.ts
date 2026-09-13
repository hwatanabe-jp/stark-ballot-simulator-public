import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as yazl from 'yazl';
import type { VerificationBundleArtifactMap } from '@stark-ballot/verification/bundle';
import {
  createVerificationBundleArchive,
  inspectVerificationBundleArchiveBuffer,
  inspectVerificationBundleArchiveFile,
  persistVerificationBundleArtifacts,
  type VerificationBundleArchivePolicy,
} from './verification-bundle';

const COMMON_MEMBERS = [
  'public-input.json',
  'election-manifest.json',
  'close-statement.json',
  'receipt.json',
  'journal.json',
] as const;

const KNOWN_PUBLIC_MEMBERS = [...COMMON_MEMBERS, 'metadata.json', 'sth.json', 'consistency-proof.json'] as const;

const NEVER_PUBLIC_MEMBERS = ['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json'] as const;

const syncPolicy: VerificationBundleArchivePolicy = {
  mode: 'sync',
  requiredMembers: [...COMMON_MEMBERS, 'metadata.json'],
  optionalMembers: ['sth.json', 'consistency-proof.json'],
  knownPublicMembers: KNOWN_PUBLIC_MEMBERS,
  neverPublicMembers: NEVER_PUBLIC_MEMBERS,
};

const asyncPolicy: VerificationBundleArchivePolicy = {
  mode: 'async',
  requiredMembers: COMMON_MEMBERS,
  optionalMembers: [],
  knownPublicMembers: KNOWN_PUBLIC_MEMBERS,
  neverPublicMembers: NEVER_PUBLIC_MEMBERS,
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('Unexpected ZIP output chunk');
}

async function buildZipBuffer(entries: readonly string[], directories: readonly string[] = []): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      zipfile.addBuffer(Buffer.from(`{"member":"${entry}"}`, 'utf8'), entry, {
        mtime: new Date(0),
        compress: false,
      });
    }
    for (const directory of directories) {
      zipfile.addEmptyDirectory(directory, { mtime: new Date(0) });
    }
    zipfile.outputStream.on('data', (chunk: unknown) => chunks.push(toBuffer(chunk)));
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.on('error', reject);
    zipfile.end();
  });
}

function replaceEverySameLength(buffer: Buffer, original: string, replacement: string): Buffer {
  if (original.length !== replacement.length) {
    throw new Error('ZIP test replacement must preserve byte length');
  }
  const result = Buffer.from(buffer);
  const originalBytes = Buffer.from(original, 'utf8');
  const replacementBytes = Buffer.from(replacement, 'utf8');
  let offset = 0;
  while ((offset = result.indexOf(originalBytes, offset)) >= 0) {
    replacementBytes.copy(result, offset);
    offset += replacementBytes.length;
  }
  return result;
}

describe('persistVerificationBundleArtifacts path admission', () => {
  it('preserves the invalid session identifier error', async () => {
    await expect(
      persistVerificationBundleArtifacts({
        sessionId: '../session',
        finalizationId: 'finalization-1',
        artifacts: {} as VerificationBundleArtifactMap,
      }),
    ).rejects.toThrow(new Error('Invalid sessionId for bundle path'));
  });

  it('preserves the invalid finalization identifier error', async () => {
    await expect(
      persistVerificationBundleArtifacts({
        sessionId: 'session-1',
        finalizationId: '../finalization',
        artifacts: {} as VerificationBundleArtifactMap,
      }),
    ).rejects.toThrow(new Error('Invalid finalizationId for bundle path'));
  });
});

describe('public verification bundle archive admission', () => {
  it('creates and admits the exact sync archive while leaving private siblings outside it', async () => {
    const bundlePath = await createTempDir('verification-bundle-sync-');
    for (const member of [...COMMON_MEMBERS, 'metadata.json', 'sth.json']) {
      await fs.writeFile(path.join(bundlePath, member), JSON.stringify({ member }), 'utf8');
    }
    await fs.writeFile(path.join(bundlePath, 'input.json'), '{"private":true}', 'utf8');
    await fs.writeFile(path.join(bundlePath, 'verification.json'), '{"protected":true}', 'utf8');
    await fs.writeFile(path.join(bundlePath, 'unknown.json'), '{"unknown":true}', 'utf8');

    const archivePath = await createVerificationBundleArchive(bundlePath, { policy: syncPolicy });
    const inspection = await inspectVerificationBundleArchiveFile(archivePath, syncPolicy);

    expect(inspection).toEqual({
      mode: 'sync',
      members: [...COMMON_MEMBERS, 'metadata.json', 'sth.json'].sort(),
    });
    await expect(fs.access(path.join(bundlePath, 'input.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(bundlePath, 'verification.json'))).resolves.toBeUndefined();
  });

  it('admits the exact async member set', async () => {
    const archive = await buildZipBuffer(COMMON_MEMBERS);

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).resolves.toEqual({
      mode: 'async',
      members: [...COMMON_MEMBERS].sort(),
    });
  });

  it('requires metadata in sync mode', async () => {
    const archive = await buildZipBuffer(COMMON_MEMBERS);

    await expect(inspectVerificationBundleArchiveBuffer(archive, syncPolicy)).rejects.toThrow(
      /missing required public bundle member.*metadata\.json/i,
    );
  });

  it.each(NEVER_PUBLIC_MEMBERS)('rejects never-public member %s', async (member) => {
    const archive = await buildZipBuffer([...COMMON_MEMBERS, member]);

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(/never-public.*member/i);
  });

  it('rejects unknown members by default', async () => {
    const archive = await buildZipBuffer([...COMMON_MEMBERS, 'failure-marker.json']);

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
      /unknown public bundle member/i,
    );
  });

  it.each(['metadata.json', 'sth.json', 'consistency-proof.json'])(
    'rejects sync-only member %s in async mode',
    async (member) => {
      const archive = await buildZipBuffer([...COMMON_MEMBERS, member]);

      await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
        /not admitted in async mode/i,
      );
    },
  );

  it('rejects duplicate and case-conflicting paths', async () => {
    const duplicate = await buildZipBuffer([...COMMON_MEMBERS, 'journal.json']);
    const caseConflict = await buildZipBuffer([...COMMON_MEMBERS, 'JOURNAL.JSON']);

    await expect(inspectVerificationBundleArchiveBuffer(duplicate, asyncPolicy)).rejects.toThrow(
      /duplicate.*journal\.json/i,
    );
    await expect(inspectVerificationBundleArchiveBuffer(caseConflict, asyncPolicy)).rejects.toThrow(
      /case-conflicting.*journal\.json/i,
    );
  });

  it('rejects a nested member path', async () => {
    const archive = await buildZipBuffer([
      ...COMMON_MEMBERS.filter((candidate) => candidate !== 'journal.json'),
      'nested/journal.json',
    ]);

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
      /noncanonical public bundle member/i,
    );
  });

  it.each(['nested', 'journal.json'])('rejects directory entry %s/', async (directory) => {
    const archive = await buildZipBuffer(COMMON_MEMBERS, [directory]);

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
      /noncanonical public bundle member/i,
    );
  });

  it('rejects malformed archives', async () => {
    await expect(inspectVerificationBundleArchiveBuffer(Buffer.from('not-a-zip', 'utf8'), asyncPolicy)).rejects.toThrow(
      /invalid public bundle archive/i,
    );
  });

  it('rejects an archive with unreadable member bytes even when its directory is intact', async () => {
    const archive = await buildZipBuffer(COMMON_MEMBERS);
    const content = Buffer.from('{"member":"journal.json"}', 'utf8');
    const contentOffset = archive.indexOf(content);
    expect(contentOffset).toBeGreaterThanOrEqual(0);
    const originalByte = archive[contentOffset + 1];
    if (originalByte === undefined) {
      throw new Error('Expected stored journal member content');
    }
    archive[contentOffset + 1] = originalByte ^ 0xff;

    await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
      /member is malformed or unreadable/i,
    );
  });

  it.each(['../evil.json', '/evilxx.json', 'dir\\foo.json'])(
    'rejects unsafe raw member name %s',
    async (unsafeMember) => {
      const archive = replaceEverySameLength(await buildZipBuffer(COMMON_MEMBERS), 'journal.json', unsafeMember);

      await expect(inspectVerificationBundleArchiveBuffer(archive, asyncPolicy)).rejects.toThrow(
        /invalid public bundle archive/i,
      );
    },
  );
});
