import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import * as yauzl from 'yauzl';

export type ZipOpenOptions = yauzl.Options & { strictFileNames?: boolean; validateEntrySizes?: boolean };
type ZipCallback = (error: Error | null, zipfile: yauzl.ZipFile) => void;

function openedZip(open: (callback: ZipCallback) => void): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    open((error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
  });
}

export function openZipFromBuffer(buffer: Buffer, options: ZipOpenOptions): Promise<yauzl.ZipFile> {
  return openedZip((callback) => yauzl.fromBuffer(buffer, options, callback));
}

export function openZipFromFile(zipPath: string, options: ZipOpenOptions): Promise<yauzl.ZipFile> {
  return openedZip((callback) => yauzl.open(zipPath, options, callback));
}

export async function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return await promisify(zipfile.openReadStream).call(zipfile, entry);
}
