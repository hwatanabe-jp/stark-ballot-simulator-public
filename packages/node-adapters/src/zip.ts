import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

type ZipOpenOptions = yauzl.Options & {
  strictFileNames?: boolean;
  validateEntrySizes?: boolean;
};

const DEFAULT_YAUZL_OPTIONS: ZipOpenOptions = {
  lazyEntries: true,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true,
};

export interface ExtractZipOptions {
  destination: string;
  maxEntryBytes?: number;
}

export interface ReadZipEntriesOptions {
  maxEntryBytes?: number;
}

function resolveEntryTarget(
  destination: string,
  entryName: string,
): { targetPath: string; isDirectory: boolean; key: string } {
  const sanitized = entryName.replace(/\\/g, '/');
  if (sanitized.length === 0 || sanitized.includes('\0')) {
    throw new Error(`Invalid zip entry name: ${entryName}`);
  }
  const isDirectory = sanitized.endsWith('/');
  const trimmed = isDirectory ? sanitized.slice(0, -1) : sanitized;
  if (!trimmed) {
    throw new Error(`Invalid zip entry name: ${entryName}`);
  }
  if (trimmed.split('/').includes('..')) {
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

function openZipFromBuffer(buffer: Buffer, options: ZipOpenOptions = DEFAULT_YAUZL_OPTIONS): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, options, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
  });
}

function openZipFromFile(zipPath: string, options: ZipOpenOptions = DEFAULT_YAUZL_OPTIONS): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, options, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
  });
}

async function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return await new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
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

async function extractZip(zipfile: yauzl.ZipFile, options: ExtractZipOptions): Promise<void> {
  const { destination, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = options;
  if (!destination) {
    throw new Error('Zip extraction destination is required');
  }
  await fs.mkdir(destination, { recursive: true });

  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try {
          zipfile.close();
        } catch {
          // ignore close errors
        }
        reject(error);
        return;
      }
      resolve();
    };

    zipfile.on('error', (error: Error) => finish(error));
    zipfile.on('end', () => finish());

    zipfile.on('entry', (entry: yauzl.Entry) => {
      let target: { targetPath: string; isDirectory: boolean; key: string };
      try {
        target = resolveEntryTarget(destination, entry.fileName);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (seen.has(target.key)) {
        finish(new Error(`Duplicate zip entry: ${entry.fileName}`));
        return;
      }
      seen.add(target.key);

      if (target.isDirectory) {
        fs.mkdir(target.targetPath, { recursive: true })
          .then(() => zipfile.readEntry())
          .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
        return;
      }

      try {
        assertEntrySize(entry, maxEntryBytes);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      fs.mkdir(path.dirname(target.targetPath), { recursive: true })
        .then(async () => {
          const stream = await openEntryStream(zipfile, entry);
          await pipeline(stream, createWriteStream(target.targetPath));
        })
        .then(() => zipfile.readEntry())
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });

    zipfile.readEntry();
  });
}

/**
 * Extracts a zip archive from a file path into a destination directory.
 */
export async function extractZipFromFile(zipPath: string, options: ExtractZipOptions): Promise<void> {
  const zipfile = await openZipFromFile(zipPath);
  await extractZip(zipfile, options);
}

/**
 * Extracts a zip archive from a buffer into a destination directory.
 */
export async function extractZipFromBuffer(buffer: Buffer, options: ExtractZipOptions): Promise<void> {
  const zipfile = await openZipFromBuffer(buffer);
  await extractZip(zipfile, options);
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

  const zipfile = await openZipFromBuffer(buffer);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try {
          zipfile.close();
        } catch {
          // ignore close errors
        }
        reject(error);
        return;
      }
      try {
        zipfile.close();
      } catch {
        // ignore close errors
      }
      resolve();
    };

    zipfile.on('error', (error: Error) => finish(error));
    zipfile.on('end', () => finish());

    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/')) {
        zipfile.readEntry();
        return;
      }
      if (!wanted.has(entry.fileName)) {
        zipfile.readEntry();
        return;
      }
      if (results.has(entry.fileName)) {
        finish(new Error(`Duplicate zip entry: ${entry.fileName}`));
        return;
      }

      readEntryBuffer(zipfile, entry, maxEntryBytes)
        .then((buffer) => {
          results.set(entry.fileName, buffer);
          if (results.size >= wanted.size) {
            finish();
            return;
          }
          zipfile.readEntry();
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });

    zipfile.readEntry();
  });

  return results;
}
