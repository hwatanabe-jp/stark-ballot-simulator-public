import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function sha256Hex(...chunks: Uint8Array[]): string {
  const hash = sha256.create();
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return bytesToHex(hash.digest());
}
