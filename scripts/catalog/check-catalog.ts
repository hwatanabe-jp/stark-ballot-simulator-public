import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCatalogInputs } from './catalog-policy';

async function main(): Promise<void> {
  const result = await checkCatalogInputs(process.cwd());
  process.stdout.write(
    `Catalog and TechDocs inputs are valid (${String(result.entityRefs.length)} entities, ${String(result.techDocsPages.length)} pages).\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
