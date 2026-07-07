import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { normalizeHexString } from '@stark-ballot/verification/shared/hex';

export interface AdmittedSthRecord {
  source?: string;
  sthDigest: string;
  treeSize?: number;
  bulletinRoot?: string;
  timestamp?: number;
  logId?: string;
}

export type SthVerificationInput = Pick<ZkVMJournal, 'sthDigest' | 'bulletinRoot' | 'treeSize'>;

export interface SthVerificationResult {
  verified: boolean;
  consensus: boolean;
  sourcesChecked: number;
  matchingSources: number;
  errors: string[];
}

export interface SthConsensusOptions {
  minMatchingSources?: number;
  errors?: readonly string[];
  sourcesChecked?: number;
}

function resolveMinMatches(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 1 ? value : 2;
}

/**
 * Evaluate third-party STH consensus from records admitted by a runtime owner.
 */
export function verifySthConsensus(
  journal: SthVerificationInput,
  records: readonly AdmittedSthRecord[],
  options: SthConsensusOptions = {},
): SthVerificationResult {
  const errors = [...(options.errors ?? [])];

  if (!journal.sthDigest || normalizeHexString(journal.sthDigest) === '') {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: options.sourcesChecked ?? records.length,
      matchingSources: 0,
      errors: [...errors, 'Journal is missing sthDigest field'],
    };
  }

  const expectedDigest = normalizeHexString(journal.sthDigest);
  const expectedRoot = normalizeHexString(journal.bulletinRoot);
  const expectedTreeSize = journal.treeSize;
  let matchingSources = 0;
  let comparableSources = 0;

  for (const record of records) {
    comparableSources += 1;
    const normalizedDigest = normalizeHexString(record.sthDigest);
    const normalizedRoot = record.bulletinRoot ? normalizeHexString(record.bulletinRoot) : undefined;

    const digestMatches = normalizedDigest === expectedDigest;
    const rootMatches = normalizedRoot ? normalizedRoot === expectedRoot : true;
    const treeSizeMatches = typeof record.treeSize === 'number' ? record.treeSize === expectedTreeSize : true;

    if (digestMatches && rootMatches && treeSizeMatches) {
      matchingSources += 1;
      continue;
    }

    const mismatchReasons: string[] = [];
    if (!digestMatches) {
      mismatchReasons.push('digest mismatch');
    }
    if (!rootMatches) {
      mismatchReasons.push('root mismatch');
    }
    if (!treeSizeMatches) {
      mismatchReasons.push('tree size mismatch');
    }
    errors.push(`STH mismatch from ${record.source ?? 'unknown source'} (${mismatchReasons.join(', ')})`);
  }

  const minMatches = resolveMinMatches(options.minMatchingSources);
  const consensus = comparableSources > 0 && matchingSources === comparableSources;
  const verified = matchingSources >= minMatches && consensus;

  if (!verified && matchingSources < minMatches) {
    errors.push(`Insufficient matching STH sources (expected at least ${minMatches}, got ${matchingSources}).`);
  }

  return {
    verified,
    consensus,
    sourcesChecked: options.sourcesChecked ?? records.length,
    matchingSources,
    errors,
  };
}
