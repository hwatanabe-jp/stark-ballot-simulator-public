import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface PublicImageIdMappingEntry {
  methodVersion: number;
  expectedImageID?: string;
  expectedImageID_x86_64?: string;
  description: string;
  compiledAt: string;
  rustVersion: string;
  risc0Version: string;
  features: string[];
}

export interface PublicImageIdMapping {
  mappings: Record<string, PublicImageIdMappingEntry>;
  current: string;
  deprecated: string[];
  metadata?: {
    lastUpdated: string;
    format: string;
    purpose: string;
    notes: string;
  };
}

let cachedMapping: PublicImageIdMapping | null = null;

function normalizePublicSourcePath(source: string): string {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const withoutLeadingSlash = trimmed.replace(/^[\\/]+/, '');
  const withoutLeadingDot = withoutLeadingSlash.replace(/^\.[\\/]+/, '');
  return withoutLeadingDot.replace(/^public[\\/]+/, '');
}

export function resolvePublicImageIdMappingPath(
  source = 'imageId-mapping.json',
  publicDir = path.resolve('public'),
): string {
  const relativePath = normalizePublicSourcePath(source);
  if (!relativePath) {
    throw new Error('Source path is empty');
  }

  const resolvedPath = path.resolve(publicDir, relativePath);
  const relativeFromPublic = path.relative(publicDir, resolvedPath);

  if (relativeFromPublic.startsWith('..') || path.isAbsolute(relativeFromPublic)) {
    throw new Error('Source path must be within public/');
  }

  return resolvedPath;
}

export function resetPublicImageIdMappingCache(): void {
  cachedMapping = null;
}

export async function loadPublicImageIdMapping(source = 'imageId-mapping.json'): Promise<PublicImageIdMapping> {
  if (source === 'imageId-mapping.json' && cachedMapping) {
    return cachedMapping;
  }

  try {
    const filePath = resolvePublicImageIdMappingPath(source);
    const content = await fs.readFile(filePath, 'utf-8');
    const mapping = JSON.parse(content) as PublicImageIdMapping;

    if (source === 'imageId-mapping.json') {
      cachedMapping = mapping;
    }

    return mapping;
  } catch (error) {
    throw new Error(`Failed to load ImageID mapping: ${error instanceof Error ? error.message : String(error)}`);
  }
}
