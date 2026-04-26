import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptVoteSecret,
  encryptVoteSecret,
  isEncryptedVoteSecret,
  parseVoteSecretKey,
} from '@/lib/security/voteSecretCipher';

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

describe('voteSecretCipher', () => {
  beforeEach(() => {
    restoreEnv();
    process.env.VOTE_SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    restoreEnv();
  });

  it('parses 32-byte keys from hex and base64', () => {
    const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const base64 = Buffer.from(hex, 'hex').toString('base64');

    expect(parseVoteSecretKey(hex)?.length).toBe(32);
    expect(parseVoteSecretKey(base64)?.length).toBe(32);
    expect(parseVoteSecretKey('not-a-key')).toBeNull();
  });

  it('encrypts and decrypts vote secrets', () => {
    const encrypted = encryptVoteSecret('0x' + '1'.repeat(64));
    expect(isEncryptedVoteSecret(encrypted)).toBe(true);

    const decrypted = decryptVoteSecret(encrypted);
    expect(decrypted).toBe('0x' + '1'.repeat(64));
  });

  it('rejects plaintext values', () => {
    expect(() => decryptVoteSecret('A')).toThrow('Encrypted vote secret payload is required.');
  });

  it('throws on malformed encrypted payloads', () => {
    expect(() => decryptVoteSecret('enc:v1:broken')).toThrow('Invalid encrypted vote secret payload.');
  });
});
