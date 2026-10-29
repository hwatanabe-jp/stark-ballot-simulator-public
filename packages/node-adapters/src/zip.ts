import type * as yazl from 'yazl';
import { openZipFromBuffer, openEntryStream, type ZipOpenOptions, openZipFromFile } from './zip-streams';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type * as yauzl from 'yauzl';

/** Close completion and every ZIP/output error share one write result. */
export function writeZipArchive(zipfile: yazl.ZipFile, archivePath: string, populate?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.on('error', reject);
    populate?.();
    zipfile.outputStream.pipe(output);
    zipfile.end();
  });
}

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_PATH_BYTES = 4_096;

const DEFAULT_YAUZL_OPTIONS: ZipOpenOptions = {
  lazyEntries: true,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true,
};

export interface ExtractZipOptions {
  destination: string;
  maxEntryBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

export interface ReadZipEntriesOptions {
  maxEntryBytes?: number;
}

export interface ListZipEntryNamesOptions {
  maxEntryBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

function resolveEntryTarget(
  destination: string,
  entryName: string,
): { targetPath: string; isDirectory: boolean; key: string } {
  const sanitized = entryName.replace(/\\/g, '/');
  if (
    sanitized.length === 0 ||
    sanitized.includes('\0') ||
    Buffer.byteLength(sanitized, 'utf8') > MAX_ENTRY_PATH_BYTES
  ) {
    throw new Error(`Invalid zip entry name: ${entryName}`);
  }
  const isDirectory = sanitized.endsWith('/');
  const trimmed = isDirectory ? sanitized.slice(0, -1) : sanitized;
  if (!trimmed) {
    throw new Error(`Invalid zip entry name: ${entryName}`);
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe zip entry name: ${entryName}`);
  }

  const destinationRoot = path.resolve(destination);
  const resolved = path.resolve(destinationRoot, trimmed);
  const withinDestination = resolved === destinationRoot || resolved.startsWith(destinationRoot + path.sep);
  if (!withinDestination) {
    throw new Error(`Unsafe zip entry name: ${entryName}`);
  }

  return { targetPath: resolved, isDirectory, key: trimmed };
}

function assertEntrySize(entry: yauzl.Entry, maxEntryBytes: number): void {
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new Error(`Zip entry too large: ${entry.fileName}`);
  }
}

function assertZipLimits(maxEntryBytes: number, maxEntries: number, maxTotalBytes: number): void {
  for (const [value, label] of [
    [maxEntryBytes, 'maxEntryBytes'],
    [maxEntries, 'maxEntries'],
    [maxTotalBytes, 'maxTotalBytes'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Zip ${label} must be a positive integer`);
    }
  }
}

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
  throw new Error('Unsupported zip stream chunk');
}

async function readEntryBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry, maxEntryBytes: number): Promise<Buffer> {
  assertEntrySize(entry, maxEntryBytes);
  const stream = await openEntryStream(zipfile, entry);
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk: unknown) => {
      chunks.push(toBuffer(chunk));
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Consume lazy entries sequentially, closing the archive on completion or failure. */
async function visitZipEntries(
  zipfile: yauzl.ZipFile,
  visit: (entry: yauzl.Entry) => Promise<void | false>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // Closing is best effort; preserve the original read failure.
      }
      if (error) reject(error);
      else resolve();
    };
    zipfile.on('error', finish);
    zipfile.on('end', () => finish());
    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      visit(entry)
        .then((continueReading) => {
          if (settled) return;
          if (continueReading === false) finish();
          else zipfile.readEntry();
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    zipfile.readEntry();
  });
}

/** Per-archive limits and canonical identities shared by inspection and extraction. */
function createZipInventory(destination: string, maxEntries: number, maxTotalBytes: number) {
  const seen = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;
  return {
    countEntry() {
      if (++entryCount > maxEntries) throw new Error(`Zip contains more than ${maxEntries} entries`);
    },
    countDeclaredBytes(entry: yauzl.Entry) {
      totalBytes += entry.uncompressedSize;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`Zip aggregate uncompressed size exceeds ${maxTotalBytes} bytes`);
      }
    },
    admitTarget(entry: yauzl.Entry) {
      const target = resolveEntryTarget(destination, entry.fileName);
      if (seen.has(target.key)) throw new Error(`Duplicate zip entry: ${entry.fileName}`);
      seen.add(target.key);
      return target;
    },
  };
}

function createExtractionMeter(maxEntryBytes: number, maxTotalBytes: number) {
  let actualTotalBytes = 0;
  return () => {
    let actualEntryBytes = 0;
    return new Transform({
      transform(chunk: unknown, _encoding, callback) {
        try {
          const buffer = toBuffer(chunk);
          actualEntryBytes += buffer.length;
          actualTotalBytes += buffer.length;
          if (actualEntryBytes > maxEntryBytes || actualTotalBytes > maxTotalBytes) {
            throw new Error('Zip actual extracted bytes exceed the configured entry or aggregate bound');
          }
          callback(null, buffer);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  };
}

async function extractZip(zipfile: yauzl.ZipFile, options: ExtractZipOptions): Promise<void> {
  const {
    destination,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;
  if (!destination) throw new Error('Zip extraction destination is required');
  assertZipLimits(maxEntryBytes, maxEntries, maxTotalBytes);
  await fs.mkdir(destination, { recursive: true });
  const inventory = createZipInventory(destination, maxEntries, maxTotalBytes);
  const createMeter = createExtractionMeter(maxEntryBytes, maxTotalBytes);
  await visitZipEntries(zipfile, async (entry) => {
    inventory.countEntry();
    inventory.countDeclaredBytes(entry);
    const target = inventory.admitTarget(entry);
    if (target.isDirectory) {
      await fs.mkdir(target.targetPath, { recursive: true });
      return;
    }
    assertEntrySize(entry, maxEntryBytes);
    await fs.mkdir(path.dirname(target.targetPath), { recursive: true });
    const stream = await openEntryStream(zipfile, entry);
    await pipeline(stream, createMeter(), createWriteStream(target.targetPath));
  });
}

/**
 * Extracts a zip archive from a file path into a destination directory.
 */
export async function extractZipFromFile(zipPath: string, options: ExtractZipOptions): Promise<void> {
  const zipfile = await openZipFromFile(zipPath, DEFAULT_YAUZL_OPTIONS);
  await extractZip(zipfile, options);
}

/**
 * Extracts a zip archive from a buffer into a destination directory.
 */
export async function extractZipFromBuffer(buffer: Buffer, options: ExtractZipOptions): Promise<void> {
  const zipfile = await openZipFromBuffer(buffer, DEFAULT_YAUZL_OPTIONS);
  await extractZip(zipfile, options);
}

/**
 * Lists every validated file entry name in a zip buffer without reading entry contents.
 */
export async function listZipEntryNamesFromBuffer(
  buffer: Buffer,
  options: ListZipEntryNamesOptions = {},
): Promise<string[]> {
  const {
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = options;
  assertZipLimits(maxEntryBytes, maxEntries, maxTotalBytes);

  const zipfile = await openZipFromBuffer(buffer, DEFAULT_YAUZL_OPTIONS);
  const entries: string[] = [];
  const inventory = createZipInventory(path.resolve('zip-inspection-root'), maxEntries, maxTotalBytes);
  await visitZipEntries(zipfile, async (entry) => {
    inventory.countEntry();
    assertEntrySize(entry, maxEntryBytes);
    inventory.countDeclaredBytes(entry);
    const target = inventory.admitTarget(entry);
    if (!target.isDirectory) entries.push(target.key);
  });

  return entries;
}

/**
 * Reads selected entries from a zip buffer and returns their raw contents.
 */
export async function readZipEntriesFromBuffer(
  buffer: Buffer,
  entryNames: readonly string[],
  options: ReadZipEntriesOptions = {},
): Promise<Map<string, Buffer>> {
  const { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = options;
  const wanted = new Set(entryNames);
  const results = new Map<string, Buffer>();

  if (wanted.size === 0) {
    return results;
  }

  const zipfile = await openZipFromBuffer(buffer, DEFAULT_YAUZL_OPTIONS);

  await visitZipEntries(zipfile, async (entry): Promise<void | false> => {
    if (entry.fileName.endsWith('/') || !wanted.has(entry.fileName)) return;
    if (results.has(entry.fileName)) throw new Error(`Duplicate zip entry: ${entry.fileName}`);
    results.set(entry.fileName, await readEntryBuffer(zipfile, entry, maxEntryBytes));
    if (results.size >= wanted.size) return false;
  });

  return results;
}
