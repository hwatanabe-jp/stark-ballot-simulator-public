export const PUBLIC_CONTRACT_USAGE =
  'Usage: public-contract-baseline.ts <capture|compare> [--source-ref <ref>] [--out <path>]';

export interface PublicContractCliOptions {
  command: 'capture' | 'compare';
  out?: string;
  baseline?: string;
  current?: string;
  sourceRef?: string;
  requireCleanCurrent?: boolean;
  classification?: string;
}

export type PublicContractCliPlan =
  | {
      readonly command: 'capture';
      readonly outPath: string;
      readonly requireCleanCurrent: boolean;
      readonly sourceRef?: string;
    }
  | {
      readonly baselinePath: string;
      readonly captureCurrent: boolean;
      readonly classificationPath?: string;
      readonly command: 'compare';
      readonly currentPath: string;
    };

interface PublicContractDriftLike {
  readonly path: string;
}

const DEFAULT_BASELINE_PATH = 'scripts/api-contract/baselines/reviewed-public-contract.json';
const DEFAULT_CURRENT_PATH = '.tmp/api-contract/current-public-contract.json';

export function parsePublicContractCli(argv: readonly string[]): PublicContractCliOptions {
  const [command] = argv;
  if (command !== 'capture' && command !== 'compare') {
    throw new Error(PUBLIC_CONTRACT_USAGE);
  }
  const options: PublicContractCliOptions = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) {
      throw new Error('Missing option name');
    }
    if (flag === '--') {
      continue;
    }
    if (flag === '--require-clean-current') {
      options.requireCleanCurrent = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${flag}`);
    }
    index += 1;
    if (flag === '--out') {
      options.out = value;
    } else if (flag === '--baseline') {
      options.baseline = value;
    } else if (flag === '--current') {
      options.current = value;
    } else if (flag === '--source-ref') {
      options.sourceRef = value;
    } else if (flag === '--classification') {
      options.classification = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

export function resolveCaptureOutputPath(options: { out?: string; sourceRef?: string }): string {
  if (options.sourceRef && !options.out) {
    throw new Error(
      'Source-ref capture requires an explicit --out path; reviewed baselines are never overwritten implicitly',
    );
  }
  return options.out ?? DEFAULT_CURRENT_PATH;
}

export function buildPublicContractCliPlan(
  options: PublicContractCliOptions,
  currentPathExists: boolean,
): PublicContractCliPlan {
  if (options.command === 'capture') {
    return {
      command: 'capture',
      outPath: resolveCaptureOutputPath(options),
      requireCleanCurrent: options.requireCleanCurrent === true,
      ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
    };
  }

  const currentPath = options.current ?? DEFAULT_CURRENT_PATH;
  return {
    baselinePath: options.baseline ?? DEFAULT_BASELINE_PATH,
    captureCurrent: !options.current || !currentPathExists,
    command: 'compare',
    currentPath,
    ...(options.classification === undefined ? {} : { classificationPath: options.classification }),
  };
}

export function renderPublicContractCaptureSuccess(
  routeCount: number,
  outPath: string,
  contractHash: string,
): string[] {
  return [`Captured ${String(routeCount)} public route contracts to ${outPath}`, `contractHash=${contractHash}`];
}

export function renderPublicContractComparisonSuccess(baselineSourceSha: string, currentSourceSha: string): string {
  return `Public contract comparison passed (${baselineSourceSha} -> ${currentSourceSha})`;
}

export function renderPublicContractDriftFailure(drift: readonly PublicContractDriftLike[]): string[] {
  return [
    `Public contract drift is not classified (${String(drift.length)} paths):`,
    ...drift.slice(0, 25).map((item) => `- ${item.path}`),
  ];
}
