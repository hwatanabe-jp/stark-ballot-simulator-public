import { describe, expect, it } from 'vitest';
import {
  PUBLIC_BUNDLE_MANIFEST,
  parsePublicBundleManifest,
  resolvePublicBundlePolicy,
} from '../public-bundle-manifest';

describe('public bundle manifest', () => {
  it('is the reviewed authority for sync, async, and never-public members', () => {
    expect(PUBLIC_BUNDLE_MANIFEST).toEqual({
      requiredInAllModes: [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
      ],
      modes: {
        sync: {
          required: ['metadata.json'],
          optional: ['sth.json', 'consistency-proof.json'],
        },
        async: {
          required: [],
          optional: [],
        },
      },
      neverPublic: ['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json'],
    });
  });

  it('resolves exact mode-specific policies from the reviewed manifest', () => {
    expect(resolvePublicBundlePolicy('sync')).toEqual({
      mode: 'sync',
      requiredMembers: [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
        'metadata.json',
      ],
      optionalMembers: ['sth.json', 'consistency-proof.json'],
      knownPublicMembers: [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
        'metadata.json',
        'sth.json',
        'consistency-proof.json',
      ],
      neverPublicMembers: ['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json'],
    });

    expect(resolvePublicBundlePolicy('async')).toEqual({
      mode: 'async',
      requiredMembers: [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
      ],
      optionalMembers: [],
      knownPublicMembers: [
        'public-input.json',
        'election-manifest.json',
        'close-statement.json',
        'receipt.json',
        'journal.json',
        'metadata.json',
        'sth.json',
        'consistency-proof.json',
      ],
      neverPublicMembers: ['input.json', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json'],
    });
  });

  it.each([
    [
      'an unknown top-level field',
      {
        requiredInAllModes: ['journal.json'],
        modes: {
          sync: { required: [], optional: [] },
          async: { required: [], optional: [] },
        },
        neverPublic: [],
        allowUnknown: true,
      },
    ],
    [
      'a noncanonical member',
      {
        requiredInAllModes: ['nested/journal.json'],
        modes: {
          sync: { required: [], optional: [] },
          async: { required: [], optional: [] },
        },
        neverPublic: [],
      },
    ],
    [
      'a case-conflicting member',
      {
        requiredInAllModes: ['journal.json'],
        modes: {
          sync: { required: ['JOURNAL.JSON'], optional: [] },
          async: { required: [], optional: [] },
        },
        neverPublic: [],
      },
    ],
    [
      'a public/private overlap',
      {
        requiredInAllModes: ['journal.json'],
        modes: {
          sync: { required: [], optional: [] },
          async: { required: [], optional: [] },
        },
        neverPublic: ['journal.json'],
      },
    ],
  ])('rejects %s', (_label, manifest) => {
    expect(() => parsePublicBundleManifest(manifest)).toThrow(/public bundle manifest/i);
  });
});
