#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSource } from '../formatting/format-source';
import { buildBitmapGoldenVectors } from './bitmap-golden-vectors';

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json',
);

async function main(): Promise<void> {
  const formatted = await formatSource(OUTPUT_PATH, JSON.stringify(buildBitmapGoldenVectors()));
  writeFileSync(OUTPUT_PATH, formatted);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
