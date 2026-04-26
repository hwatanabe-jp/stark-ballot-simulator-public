#!/usr/bin/env tsx

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { buildRfc6962GoldenVectors } from './rfc6962-golden-vectors';

const OUTPUT_PATH = path.resolve(__dirname, '../../zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json');

async function main(): Promise<void> {
  const prettierOptions = (await resolveConfig(OUTPUT_PATH)) ?? {};
  const formatted = await format(JSON.stringify(buildRfc6962GoldenVectors()), {
    ...prettierOptions,
    filepath: OUTPUT_PATH,
  });
  writeFileSync(OUTPUT_PATH, formatted);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
