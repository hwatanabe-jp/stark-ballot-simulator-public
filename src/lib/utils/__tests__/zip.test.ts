/**
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriteStream, promises as fs } from 'node:fs';
import * as yazl from 'yazl';
import { extractZipFromBuffer, extractZipFromFile, readZipEntriesFromBuffer } from '../zip';

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
});

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(chunk));
  }
  throw new Error('Unexpected zip chunk');
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

async function buildZipBuffer(entries: Array<{ name: string; content?: string | Buffer }>): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];

    for (const entry of entries) {
      const content = entry.content ?? '';
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      zipfile.addBuffer(buffer, entry.name, { mtime: new Date(0), compress: false });
    }

    zipfile.outputStream.on('data', (chunk: unknown) => {
      chunks.push(toBuffer(chunk));
    });
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.on('error', reject);

    zipfile.end();
  });
}

async function writeZipFile(
  entries: Array<{ name: string; content?: string | Buffer }>,
  outputDir: string,
): Promise<string> {
  const zipPath = path.join(outputDir, 'bundle.zip');
  await new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const entry of entries) {
      const content = entry.content ?? '';
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      zipfile.addBuffer(buffer, entry.name, { mtime: new Date(0), compress: false });
    }
    const output = createWriteStream(zipPath);
    output.on('close', resolve);
    output.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.pipe(output);
    zipfile.end();
  });
  return zipPath;
}

function computeCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    crc ^= byte;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildRawZipBuffer(fileName: string, content: Buffer): Buffer {
  const fileNameBuffer = Buffer.from(fileName, 'utf8');
  const crc32 = computeCrc32(content);

  const localHeader = Buffer.alloc(30 + fileNameBuffer.length);
  let cursor = 0;
  cursor = localHeader.writeUInt32LE(0x04034b50, cursor);
  cursor = localHeader.writeUInt16LE(20, cursor);
  cursor = localHeader.writeUInt16LE(0, cursor);
  cursor = localHeader.writeUInt16LE(0, cursor);
  cursor = localHeader.writeUInt16LE(0, cursor);
  cursor = localHeader.writeUInt16LE(0, cursor);
  cursor = localHeader.writeUInt32LE(crc32 >>> 0, cursor);
  cursor = localHeader.writeUInt32LE(content.length, cursor);
  cursor = localHeader.writeUInt32LE(content.length, cursor);
  cursor = localHeader.writeUInt16LE(fileNameBuffer.length, cursor);
  cursor = localHeader.writeUInt16LE(0, cursor);
  fileNameBuffer.copy(localHeader, cursor);

  const centralHeader = Buffer.alloc(46 + fileNameBuffer.length);
  let centralCursor = 0;
  centralCursor = centralHeader.writeUInt32LE(0x02014b50, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(20, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(20, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt32LE(crc32 >>> 0, centralCursor);
  centralCursor = centralHeader.writeUInt32LE(content.length, centralCursor);
  centralCursor = centralHeader.writeUInt32LE(content.length, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(fileNameBuffer.length, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt16LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt32LE(0, centralCursor);
  centralCursor = centralHeader.writeUInt32LE(0, centralCursor);
  fileNameBuffer.copy(centralHeader, centralCursor);

  const centralDirectoryOffset = localHeader.length + content.length;
  const centralDirectorySize = centralHeader.length;

  const endRecord = Buffer.alloc(22);
  let endCursor = 0;
  endCursor = endRecord.writeUInt32LE(0x06054b50, endCursor);
  endCursor = endRecord.writeUInt16LE(0, endCursor);
  endCursor = endRecord.writeUInt16LE(0, endCursor);
  endCursor = endRecord.writeUInt16LE(1, endCursor);
  endCursor = endRecord.writeUInt16LE(1, endCursor);
  endCursor = endRecord.writeUInt32LE(centralDirectorySize, endCursor);
  endCursor = endRecord.writeUInt32LE(centralDirectoryOffset, endCursor);
  endCursor = endRecord.writeUInt16LE(0, endCursor);

  if (endCursor !== endRecord.length) {
    throw new Error('End of central directory record size mismatch.');
  }

  return Buffer.concat([localHeader, content, centralHeader, endRecord]);
}

describe('zip utils', () => {
  it('extracts entries from a zip buffer', async () => {
    const zipBuffer = await buildZipBuffer([
      { name: 'input.json', content: '{"ok":true}' },
      { name: 'nested/journal.json', content: '{"entries":[]}' },
    ]);
    const destination = await createTempDir('zip-buffer-');

    await extractZipFromBuffer(zipBuffer, { destination });

    const input = await fs.readFile(path.join(destination, 'input.json'), 'utf-8');
    const journal = await fs.readFile(path.join(destination, 'nested', 'journal.json'), 'utf-8');
    expect(input).toBe('{"ok":true}');
    expect(journal).toBe('{"entries":[]}');
  });

  it('extracts entries from a zip file', async () => {
    const dir = await createTempDir('zip-file-');
    const zipPath = await writeZipFile(
      [
        { name: 'receipt.json', content: '{"receipt":true}' },
        { name: 'metadata.json', content: '{"version":1}' },
      ],
      dir,
    );
    const destination = await createTempDir('zip-file-extract-');

    await extractZipFromFile(zipPath, { destination });

    const receipt = await fs.readFile(path.join(destination, 'receipt.json'), 'utf-8');
    const metadata = await fs.readFile(path.join(destination, 'metadata.json'), 'utf-8');
    expect(receipt).toBe('{"receipt":true}');
    expect(metadata).toBe('{"version":1}');
  });

  it('reads selected entries from a zip buffer', async () => {
    const zipBuffer = await buildZipBuffer([
      { name: 'input.json', content: '{"ok":true}' },
      { name: 'journal.json', content: '{"entries":[]}' },
    ]);

    const entries = await readZipEntriesFromBuffer(zipBuffer, ['journal.json', 'input.json']);

    expect(entries.size).toBe(2);
    expect(entries.get('input.json')?.toString('utf-8')).toBe('{"ok":true}');
    expect(entries.get('journal.json')?.toString('utf-8')).toBe('{"entries":[]}');
  });

  it('returns empty map for missing entries', async () => {
    const zipBuffer = await buildZipBuffer([{ name: 'input.json', content: '{"ok":true}' }]);

    const entries = await readZipEntriesFromBuffer(zipBuffer, ['missing.json']);

    expect(entries.size).toBe(0);
  });

  it('rejects path traversal entries', async () => {
    const zipBuffer = buildRawZipBuffer('../evil.txt', Buffer.from('nope', 'utf8'));
    const destination = await createTempDir('zip-traversal-');

    await expect(extractZipFromBuffer(zipBuffer, { destination })).rejects.toThrow(/invalid|unsafe/i);
  });

  it('rejects duplicate entries', async () => {
    const zipBuffer = await buildZipBuffer([
      { name: 'input.json', content: '{"ok":true}' },
      { name: 'input.json', content: '{"ok":false}' },
    ]);
    const destination = await createTempDir('zip-dup-');

    await expect(extractZipFromBuffer(zipBuffer, { destination })).rejects.toThrow(/Duplicate zip entry/);
  });

  it('rejects entries over the max size', async () => {
    const zipBuffer = await buildZipBuffer([{ name: 'large.json', content: '0123456789' }]);
    const destination = await createTempDir('zip-size-');

    await expect(extractZipFromBuffer(zipBuffer, { destination, maxEntryBytes: 4 })).rejects.toThrow(
      /Zip entry too large/,
    );
  });

  it('reads empty zip without error', async () => {
    const zipBuffer = await buildZipBuffer([]);
    const destination = await createTempDir('zip-empty-');

    await extractZipFromBuffer(zipBuffer, { destination });

    const files = await fs.readdir(destination);
    expect(files).toEqual([]);
  });
});
