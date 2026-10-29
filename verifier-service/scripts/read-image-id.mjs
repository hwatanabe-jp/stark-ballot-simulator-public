#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
} from '../../packages/validation/src/image-id-policy.js';

function usage() {
  console.error('usage: node verifier-service/scripts/read-image-id.mjs <json-path> [--variant default|x86_64]');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {Record<string,unknown>} payload */
function readSnakeCaseImageId(payload) {
  if (typeof payload['image_id'] === 'string' && payload['image_id'].length > 0) {
    return payload['image_id'];
  }

  return null;
}

/** @param {Record<string,unknown>} payload */
function readDirectImageId(payload) {
  if (typeof payload['imageId'] === 'string' && payload['imageId'].length > 0) {
    return payload['imageId'];
  }

  return readSnakeCaseImageId(payload);
}

/**
 * @param {unknown} payload
 * @param {import('../../packages/validation/src/image-id-policy.js').ImageIdVariant} variant
 * @returns {string | null}
 */
function resolveImageId(payload, variant) {
  if (!isRecord(payload)) {
    return null;
  }

  const directImageId = readDirectImageId(payload);
  if (directImageId !== null) return directImageId;
  return readMappedImageId(payload, variant);
}

/** @param {Record<string,unknown>} payload @param {import('../../packages/validation/src/image-id-policy.js').ImageIdVariant} variant */
function readMappedImageId(payload, variant) {
  if (typeof payload['current'] === 'string' && isRecord(payload['mappings'])) {
    return resolveExpectedImageIdFromMapping(
      /** @type {import('../../packages/validation/src/image-id-policy.js').ImageIdMapping} */ (
        /** @type {unknown} */ (payload)
      ),
      undefined,
      variant,
    );
  }

  return null;
}

/** @param {string|undefined} token */
function exitForImageIdHelp(token) {
  if (token === '--help' || token === '-h') {
    usage();
    process.exit(0);
  }
}

/** @param {string|undefined} value */
function readVariantArgument(value) {
  if (!value) {
    throw new Error('--variant requires a value');
  }
  return resolveConfiguredImageIdVariant(value);
}

/** @param {string} filePath @param {string|undefined} token */
function readImageIdFileArgument(filePath, token) {
  if (filePath) throw new Error(`unexpected argument: ${token}`);
  if (!token) throw new Error('unexpected empty argument');
  return token;
}

/**
 * @param {string[]} argv
 * @returns {{ filePath: string; variant: import('../../packages/validation/src/image-id-policy.js').ImageIdVariant }}
 */
function parseArgs(argv) {
  let filePath = '';
  let variant = resolveConfiguredImageIdVariant(process.env['EXPECTED_IMAGE_ID_VARIANT']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    exitForImageIdHelp(token);

    if (token === '--variant') {
      variant = readVariantArgument(argv[index + 1]);
      index += 1;
      continue;
    }

    filePath = readImageIdFileArgument(filePath, token);
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
