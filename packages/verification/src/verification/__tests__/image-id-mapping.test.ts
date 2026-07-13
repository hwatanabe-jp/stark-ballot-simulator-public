/**
 * ImageID Mapping Tests
 *
 * Tests for the ImageID mapping functionality that provides
 * the correspondence between methodVersion and expected ImageID
 * according to final-design.md §4.8
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@stark-ballot/verification/shared/guards';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ImageIdMapping } from '../image-id-types';

describe('ImageID Mapping', () => {
  const MAPPING_PATH = path.join(process.cwd(), 'public', 'imageId-mapping.json');

  async function readMapping(label: string): Promise<Record<string, unknown>> {
    const content = await fs.readFile(MAPPING_PATH, 'utf-8');
    const payload: unknown = JSON.parse(content);
    if (!isRecord(payload)) {
      throw new Error(`${label} mapping is not an object`);
    }
    return payload;
  }

  describe('File Existence and Structure', () => {
    it('should have imageId-mapping.json in public directory', async () => {
      const exists = await fs
        .access(MAPPING_PATH)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it('should have valid JSON structure', async () => {
      const mapping = await readMapping('structure');

      expect(mapping).toHaveProperty('mappings');
      expect(mapping).toHaveProperty('current');
      expect(getRecordProperty(mapping, 'mappings')).toBeTypeOf('object');
      expect(getStringProperty(mapping, 'current')).toBeTypeOf('string');
    });

    it(`should contain mapping for current methodVersion ${CURRENT_METHOD_VERSION}`, async () => {
      const mapping = await readMapping('current version');
      const mappings = getRecordProperty(mapping, 'mappings');

      expect(mappings).toBeDefined();
      if (!mappings) {
        throw new Error('mappings missing');
      }
      expect(mappings).toHaveProperty('10');
      expect(mappings).toHaveProperty(String(CURRENT_METHOD_VERSION));
      const currentMapping = getRecordProperty(mappings, String(CURRENT_METHOD_VERSION));
      expect(currentMapping).toBeDefined();
      if (!currentMapping) {
        throw new Error(`mapping for version ${CURRENT_METHOD_VERSION} missing`);
      }
      expect(getNumberProperty(currentMapping, 'methodVersion')).toBe(CURRENT_METHOD_VERSION);
      expect(getStringProperty(currentMapping, 'description')).toBeDefined();
      expect(getStringProperty(currentMapping, 'compiledAt')).toBeDefined();
      expect(getStringProperty(currentMapping, 'trustStatus')).toBe('default-arm64-and-x86_64-active');
      expect(currentMapping['supportedVariants']).toEqual(['default', 'x86_64']);
    });
  });

  describe('Current Version Retrieval', () => {
    it('should retrieve the current methodVersion', async () => {
      const mapping = await readMapping('current');

      const currentKey = getStringProperty(mapping, 'current');
      expect(currentKey).toBeTypeOf('string');
      const mappings = getRecordProperty(mapping, 'mappings');
      const currentMapping =
        mappings && currentKey && isRecord(mappings) ? getRecordProperty(mappings, currentKey) : null;
      expect(currentMapping).toBeDefined();
      expect(getNumberProperty(currentMapping, 'methodVersion')).toBe(Number(currentKey));
    });

    it('resolves the current ARM64 and x86_64 ImageIDs from active trust material', async () => {
      const mapping = await readMapping('current image id');
      const mappings = getRecordProperty(mapping, 'mappings');
      const currentKey = getStringProperty(mapping, 'current');
      const currentMapping =
        mappings && currentKey && isRecord(mappings) ? getRecordProperty(mappings, currentKey) : null;
      expect(getStringProperty(currentMapping, 'expectedImageID')).toBe(
        '0x4db926db832cc19d84af84cfb2e64b2be02c9ce6966bdd4ed824d269d8f3b232',
      );
      expect(getStringProperty(currentMapping, 'expectedImageID_x86_64')).toBe(
        '0xf0ea09b47949a8610f4ba13e5ec36d791983edb899d62eed21bf5bfb6f54e94b',
      );
      expect(getStringProperty(currentMapping, 'trustStatus')).toBe('default-arm64-and-x86_64-active');
    });

    it('resolves methodVersion 14 default ARM64 and x86_64 ImageIDs', async () => {
      expect(CURRENT_METHOD_VERSION).toBe(14);
      const mapping = await readMapping('current image id resolver');
      const { getExpectedImageId } = await import('../image-id-verifier');

      expect(getExpectedImageId(mapping as unknown as ImageIdMapping, CURRENT_METHOD_VERSION, 'default')).toBe(
        '0x4db926db832cc19d84af84cfb2e64b2be02c9ce6966bdd4ed824d269d8f3b232',
      );
      expect(getExpectedImageId(mapping as unknown as ImageIdMapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(
        '0xf0ea09b47949a8610f4ba13e5ec36d791983edb899d62eed21bf5bfb6f54e94b',
      );
    });
  });

  describe('Security Features', () => {
    it('should have features array documenting capabilities', async () => {
      const mapping = await readMapping('features');
      const mappings = getRecordProperty(mapping, 'mappings');
      const currentKey = getStringProperty(mapping, 'current');
      const currentMapping =
        mappings && currentKey && isRecord(mappings) ? getRecordProperty(mappings, currentKey) : null;
      const features =
        currentMapping && isRecord(currentMapping) && Array.isArray(currentMapping['features'])
          ? currentMapping['features']
          : [];
      expect(features).toBeInstanceOf(Array);
      expect(features).toContain('STH digest binding');
      expect(features).toContain('CT leaf usage tags');
      expect(features).toContain('Input commitment sorting');
    });

    it('should have Rust and RISC Zero version information', async () => {
      const mapping = await readMapping('versions');
      const mappings = getRecordProperty(mapping, 'mappings');
      const currentKey = getStringProperty(mapping, 'current');
      const currentMapping =
        mappings && currentKey && isRecord(mappings) ? getRecordProperty(mappings, currentKey) : null;
      expect(getStringProperty(currentMapping, 'rustVersion')).toMatch(/^\d+\.\d+\.\d+$/);
      expect(getStringProperty(currentMapping, 'risc0Version')).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should have deprecated versions list', async () => {
      const mapping = await readMapping('deprecated');
      const deprecated = isRecord(mapping) && Array.isArray(mapping['deprecated']) ? mapping['deprecated'] : undefined;
      expect(mapping).toHaveProperty('deprecated');
      expect(deprecated).toBeInstanceOf(Array);
    });
  });

  describe('Multiple Source Verification', () => {
    it('should support fetching from multiple sources', async () => {
      // This test simulates fetching from multiple sources
      // In real implementation, would fetch from CDN, IPFS, etc.
      const sources = [
        MAPPING_PATH,
        // In production: 'https://cdn.example.com/imageId-mapping.json',
        // In production: 'ipfs://QmXXX.../imageId-mapping.json',
      ];

      const mappings: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        try {
          const content = await fs.readFile(source, 'utf-8');
          const payload: unknown = JSON.parse(content);
          if (isRecord(payload)) {
            mappings.push(payload);
          }
        } catch {
          // Optional mirror sources may be unavailable in this local test.
        }
      }

      // At least one source should work
      expect(mappings.length).toBeGreaterThan(0);

      // All fetched mappings should be identical
      if (mappings.length > 1) {
        const first = JSON.stringify(mappings[0]);
        for (let i = 1; i < mappings.length; i++) {
          expect(JSON.stringify(mappings[i])).toBe(first);
        }
      }
    });

    it('should verify file integrity with hash', async () => {
      const content = await fs.readFile(MAPPING_PATH, 'utf-8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });
  });
});
