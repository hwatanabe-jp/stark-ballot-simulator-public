import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { resolveExpectedImageId } from '@/lib/verification/expected-image-id';

describe('ImageID Configuration', () => {
  const mappingPath = path.join(process.cwd(), 'public', 'imageId-mapping.json');
  const mapping = JSON.parse(readFileSync(mappingPath, 'utf-8')) as {
    current: string;
    mappings: Record<string, { expectedImageID?: string; expectedImageID_x86_64?: string }>;
  };
  const currentVersion = mapping.current;
  const mappedImageId =
    mapping.mappings[currentVersion].expectedImageID ?? mapping.mappings[currentVersion].expectedImageID_x86_64;

  it('should load expected ImageID from environment when set', () => {
    const expectedImageId = process.env.EXPECTED_IMAGE_ID;

    if (!expectedImageId) {
      return;
    }
    expect(expectedImageId).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('should validate the ImageID declared in the public mapping', () => {
    expect(mappedImageId).toBeDefined();
    expect(mappedImageId).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('should resolve a valid ImageID when no override is set', async () => {
    const original = process.env.EXPECTED_IMAGE_ID;
    const originalVariant = process.env.EXPECTED_IMAGE_ID_VARIANT;
    try {
      delete process.env.EXPECTED_IMAGE_ID;
      delete process.env.EXPECTED_IMAGE_ID_VARIANT;
      const resolved = await resolveExpectedImageId().catch((error: unknown) => error);
      if (resolved instanceof Error) {
        expect(resolved.message).toMatch(/Expected ImageID variant|Failed to load ImageID mapping/);
      } else {
        expect(resolved).toMatch(/^0x[0-9a-f]{64}$/i);
      }
    } finally {
      if (original) {
        process.env.EXPECTED_IMAGE_ID = original;
      } else {
        delete process.env.EXPECTED_IMAGE_ID;
      }
      if (originalVariant) {
        process.env.EXPECTED_IMAGE_ID_VARIANT = originalVariant;
      } else {
        delete process.env.EXPECTED_IMAGE_ID_VARIANT;
      }
    }
  });
});
