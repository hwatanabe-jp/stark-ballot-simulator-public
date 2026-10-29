import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { TARGET_API_ROUTE_CONTRACTS } from '@stark-ballot/api-contract/routes';
import { formatSource } from '../formatting/format-source';
import { buildOpenApiDocument, serializeOpenApiDocument } from './lib/openapi-projection';

const OPENAPI_REFERENCE_PATH = 'openapi/stark-ballot-api.openapi.json';
const OPENAPI_REFERENCE_USAGE = 'Usage: openapi-reference.ts <generate|check>';

export function parseOpenApiReferenceCommand(argv: readonly string[]): 'check' | 'generate' {
  if (argv.length !== 1 || (argv[0] !== 'check' && argv[0] !== 'generate')) {
    throw new Error(OPENAPI_REFERENCE_USAGE);
  }
  return argv[0];
}

async function generatedOpenApiBytes(): Promise<string> {
  return formatSource(
    OPENAPI_REFERENCE_PATH,
    serializeOpenApiDocument(buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS)),
  );
}

async function validateOpenApiBytes(bytes: string): Promise<void> {
  const document: unknown = JSON.parse(bytes);
  await SwaggerParser.validate(document as Parameters<typeof SwaggerParser.validate>[0]);
}

export async function generateOpenApiReference(outputPath = OPENAPI_REFERENCE_PATH): Promise<void> {
  const bytes = await generatedOpenApiBytes();
  await validateOpenApiBytes(bytes);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, 'utf8');
}

export async function checkOpenApiReference(outputPath = OPENAPI_REFERENCE_PATH): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-openapi-'));
  const generatedPath = path.join(temporaryDirectory, 'stark-ballot-api.openapi.json');
  try {
    await generateOpenApiReference(generatedPath);
    const [expectedBytes, generatedBytes] = await Promise.all([
      readFile(outputPath, 'utf8'),
      readFile(generatedPath, 'utf8'),
    ]);
    if (expectedBytes !== generatedBytes) {
      throw new Error('Generated OpenAPI reference is stale; run pnpm api-contract:openapi:generate');
    }
    await validateOpenApiBytes(expectedBytes);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = parseOpenApiReferenceCommand(argv);
  if (command === 'generate') {
    await generateOpenApiReference();
    process.stdout.write(`Generated ${OPENAPI_REFERENCE_PATH}\n`);
    return;
  }
  await checkOpenApiReference();
  process.stdout.write(`OpenAPI reference is current and valid: ${OPENAPI_REFERENCE_PATH}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
