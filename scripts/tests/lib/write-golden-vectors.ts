import { writeFileSync } from 'node:fs';
import { formatSource } from '../../formatting/format-source';

async function writeGoldenVectors(outputPath: string, build: () => unknown): Promise<void> {
  const formatted = await formatSource(outputPath, JSON.stringify(build()));
  writeFileSync(outputPath, formatted);
  console.log(`Wrote ${outputPath}`);
}

export function generateGoldenVectorFile(outputPath: string, build: () => unknown): void {
  void writeGoldenVectors(outputPath, build).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
