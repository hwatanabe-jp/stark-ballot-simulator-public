type FrontendFinding = { readonly file: string; readonly reason: string };

export function assertNoFrontendFindings(
  findings: readonly FrontendFinding[],
  prefix: string,
  failureLabel: string,
): void {
  if (findings.length === 0) return;
  for (const finding of findings) console.error(`[${prefix}] ${finding.file}: ${finding.reason}`);
  throw new Error(`${failureLabel} failed with ${findings.length} finding(s).`);
}

export function runFrontendCheck(moduleUrl: string, main: () => Promise<void>): void {
  if (moduleUrl === `file://${process.argv[1]}`) {
    void main().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}
