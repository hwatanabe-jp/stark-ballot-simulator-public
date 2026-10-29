#!/usr/bin/env tsx

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGoldenVectorFile } from './lib/write-golden-vectors';
import { buildBitmapGoldenVectors } from './bitmap-golden-vectors';

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json',
);

generateGoldenVectorFile(OUTPUT_PATH, buildBitmapGoldenVectors);
