import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hexToBytesStrict } from '@stark-ballot/crypto-primitives';

const COMMIT_DOMAIN_TAG = utf8ToBytes('stark-ballot:commit|v1.0');

function toUuidBytes(uuid: string): Uint8Array {
  return hexToBytesStrict(uuid.replace(/-/g, ''));
}

export function computeDomainVoteCommitment(electionId: string, choice: number, random: string): string {
  const hash = sha256.create();
  hash.update(COMMIT_DOMAIN_TAG);
  hash.update(toUuidBytes(electionId));
  hash.update(Uint8Array.of(choice));
  hash.update(hexToBytesStrict(random));

  return `0x${bytesToHex(hash.digest())}`;
}
