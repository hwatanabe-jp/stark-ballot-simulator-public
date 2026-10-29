import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSource } from '../formatting/format-source';
import { buildGatewayContract } from './lib/gateway-projection';
import { parseDriftClassification, parsePublicContractSnapshot } from './lib/public-contract-policy';

const GATEWAY_CONTRACT_PATH = 'infra/terraform/app/gateway-contract.json';

async function gatewayReviewHash(): Promise<string> {
  const paths = [
    GATEWAY_CONTRACT_PATH,
    'infra/terraform/app/api_gateway.tf',
    'infra/lambdas/public-api/handler.ts',
    'scripts/tests/lib/gateway-validation-smoke.ts',
  ];
  const inputs = await Promise.all(paths.map(async (file) => [file, await readFile(file, 'utf8')]));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export async function gatewayContract(command: string | undefined): Promise<void> {
  if (command !== 'generate' && command !== 'check') throw new Error('Usage: gateway-contract.ts <generate|check>');
  const bytes = await formatSource(GATEWAY_CONTRACT_PATH, `${JSON.stringify(buildGatewayContract(), null, 2)}\n`);
  if (command === 'generate') await writeFile(GATEWAY_CONTRACT_PATH, bytes);
  else {
    if ((await readFile(GATEWAY_CONTRACT_PATH, 'utf8')) !== bytes)
      throw new Error('Gateway contract is stale; run pnpm api-contract:gateway:generate');
    const baseline = parsePublicContractSnapshot(
      JSON.parse(await readFile('scripts/api-contract/baselines/reviewed-public-contract.json', 'utf8')),
      'Gateway review Hono baseline',
    );
    const review = parseDriftClassification(
      JSON.parse(await readFile('scripts/api-contract/baselines/reviewed-gateway-contract.json', 'utf8')),
    );
    if (
      review.baselineContractHash !== baseline.contractHash ||
      review.baselineSourceSha !== baseline.sourceSha ||
      review.currentContractHash !== (await gatewayReviewHash())
    ) {
      throw new Error('Gateway transport review is not bound to the baseline and exact deployment/probe inputs');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  gatewayContract(process.argv.length === 3 ? process.argv[2] : undefined).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
