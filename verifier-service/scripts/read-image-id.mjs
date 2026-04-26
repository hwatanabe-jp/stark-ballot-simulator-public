#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
} from '../../src/lib/verification/image-id-policy.js';

function usage() {
  console.error('usage: node verifier-service/scripts/read-image-id.mjs <json-path> [--variant default|x86_64]');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveImageId(payload, variant) {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.imageId === 'string' && payload.imageId.length > 0) {
    return payload.imageId;
  }

  if (typeof payload.image_id === 'string' && payload.image_id.length > 0) {
    return payload.image_id;
  }

  if (typeof payload.current === 'string' && isRecord(payload.mappings)) {
    return resolveExpectedImageIdFromMapping(payload, undefined, variant);
  }

  return null;
}

function parseArgs(argv) {
  let filePath = '';
  let variant = resolveConfiguredImageIdVariant(process.env.EXPECTED_IMAGE_ID_VARIANT);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      usage();
      process.exit(0);
    }

    if (token === '--variant') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--variant requires a value');
      }
      variant = resolveConfiguredImageIdVariant(value);
      index += 1;
      continue;
    }

    if (!filePath) {
      filePath = token;
      continue;
    }

    throw new Error(`unexpected argument: ${token}`);
  }

  if (!filePath) {
    throw new Error('missing json path');
  }

  return { filePath, variant };
}

try {
  const { filePath, variant } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const imageId = resolveImageId(raw, variant);

  if (!imageId) {
    console.error(`could not resolve image ID from ${filePath}`);
    process.exit(1);
  }

  process.stdout.write(imageId);
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
