#!/usr/bin/env tsx

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGoldenVectorFile } from './lib/write-golden-vectors';
import { buildRfc6962GoldenVectors } from './rfc6962-golden-vectors';

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json',
);

generateGoldenVectorFile(OUTPUT_PATH, buildRfc6962GoldenVectors);
