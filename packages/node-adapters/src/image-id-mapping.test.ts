import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  loadPublicImageIdMapping,
  resetPublicImageIdMappingCache,
  resolvePublicImageIdMappingPath,
} from './image-id-mapping';

describe('public ImageID mapping Node adapter', () => {
  afterEach(() => {
    resetPublicImageIdMappingCache();
  });

  it('loads ImageID mapping from the public directory and caches the default file', async () => {
    const mapping1 = await loadPublicImageIdMapping();
    const mapping2 = await loadPublicImageIdMapping();

    expect(mapping1).toBe(mapping2);
    expect(mapping1.current).toBeTypeOf('string');
    expect(mapping1.mappings).toHaveProperty(mapping1.current);
    expect(mapping1.mappings).toHaveProperty(String(CURRENT_METHOD_VERSION));
  });

  it('rejects paths outside public/', () => {
    expect(() => resolvePublicImageIdMappingPath('../private.json')).toThrow('Source path must be within public/');
  });

  it('reports missing mapping files with a stable loader error', async () => {
    await expect(loadPublicImageIdMapping('missing-imageId-mapping.json')).rejects.toThrow(
      'Failed to load ImageID mapping',
    );
  });
});
