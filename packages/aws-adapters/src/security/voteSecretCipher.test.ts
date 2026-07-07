import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import {
  decryptVoteSecret,
  encryptVoteSecret,
  isEncryptedVoteSecret,
  parseVoteSecretKey,
} from '@stark-ballot/aws-adapters/security/voteSecretCipher';

const originalEnv = { ...process.env };
const VOTE_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key';
const VOTE_SECRET_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

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
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    clearRuntimeConfigReferenceResolver();
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
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

  it('encrypts and decrypts using a target vote secret reference resolver', () => {
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] = VOTE_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[VOTE_SECRET_REF, VOTE_SECRET_ENCRYPTION_KEY]]));

    const encrypted = encryptVoteSecret('0x' + '2'.repeat(64));

    expect(decryptVoteSecret(encrypted)).toBe('0x' + '2'.repeat(64));
  });

  it('rejects raw vote secret keys in target non-mock runtime', () => {
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = VOTE_SECRET_ENCRYPTION_KEY;
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] = VOTE_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[VOTE_SECRET_REF, VOTE_SECRET_ENCRYPTION_KEY]]));

    expect(() => encryptVoteSecret('0x' + '5'.repeat(64))).toThrow(
      'VOTE_SECRET_ENCRYPTION_KEY must not be set directly when USE_MOCK_STORE=false; use VOTE_SECRET_ENCRYPTION_KEY_REF',
    );
  });

  it('fails closed when the vote secret reference is unresolved', () => {
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] = VOTE_SECRET_REF;

    expect(() => encryptVoteSecret('0x' + '3'.repeat(64))).toThrow(
      'VOTE_SECRET_ENCRYPTION_KEY_REF is configured but no target runtime resolver returned a value',
    );
  });

  it('fails closed when the vote secret reference resolves to invalid key material', () => {
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] = VOTE_SECRET_REF;
    installStaticRuntimeConfigReferenceResolver(new Map([[VOTE_SECRET_REF, 'not-a-32-byte-key']]));

    expect(() => encryptVoteSecret('0x' + '4'.repeat(64))).toThrow(
      'VOTE_SECRET_ENCRYPTION_KEY must resolve to a valid 32-byte key',
    );
  });
});
