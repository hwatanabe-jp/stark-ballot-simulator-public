import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const CIPHER_PREFIX = 'enc:v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const TEST_FALLBACK_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function parseVoteSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim();
  if (normalized.length === 0) {
    return null;
  }

  if (isHex64(normalized)) {
    return Buffer.from(normalized, 'hex');
  }

  if (!isBase64(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== 32) {
    return null;
  }

  return decoded;
}

function resolveVoteSecretKey(): Buffer {
  const parsed = parseVoteSecretKey(process.env.VOTE_SECRET_ENCRYPTION_KEY);
  if (parsed) {
    return parsed;
  }

  if (process.env.NODE_ENV === 'test') {
    return Buffer.from(TEST_FALLBACK_KEY_HEX, 'hex');
  }

  throw new Error('VOTE_SECRET_ENCRYPTION_KEY must be set to a valid 32-byte key (hex or base64).');
}

function parseCipherPayload(value: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } | null {
  const parts = value.split(':');
  if (parts.length !== 5) {
    return null;
  }

  if (parts[0] !== 'enc' || parts[1] !== 'v1') {
    return null;
  }

  const iv = parts[2];
  const tag = parts[3];
  const ciphertext = parts[4];

  if (!/^[0-9a-fA-F]+$/.test(iv) || !/^[0-9a-fA-F]+$/.test(tag) || !/^[0-9a-fA-F]*$/.test(ciphertext)) {
    return null;
  }

  const ivBuffer = Buffer.from(iv, 'hex');
  const tagBuffer = Buffer.from(tag, 'hex');
  const ciphertextBuffer = Buffer.from(ciphertext, 'hex');

  if (ivBuffer.length !== IV_BYTES || tagBuffer.length !== AUTH_TAG_BYTES) {
    return null;
  }

  return { iv: ivBuffer, tag: tagBuffer, ciphertext: ciphertextBuffer };
}

export function isEncryptedVoteSecret(value: string): boolean {
  return value.startsWith(`${CIPHER_PREFIX}:`);
}

export function encryptVoteSecret(plaintext: string): string {
  const key = resolveVoteSecretKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${CIPHER_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptVoteSecret(value: string): string {
  if (!isEncryptedVoteSecret(value)) {
    throw new Error('Encrypted vote secret payload is required.');
  }

  const parsed = parseCipherPayload(value);
  if (!parsed) {
    throw new Error('Invalid encrypted vote secret payload.');
  }

  const key = resolveVoteSecretKey();
  const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv);
  decipher.setAuthTag(parsed.tag);

  const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
