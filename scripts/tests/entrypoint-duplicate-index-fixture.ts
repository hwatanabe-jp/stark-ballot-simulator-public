import { readFileSync, writeFileSync } from 'node:fs';
import {
  canonicalizeInputCommitmentVotesForEncoding,
  computeInputCommitmentFromPublicInput,
  type InputCommitmentVote,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  getArrayProperty,
  getNumberProperty,
  getStringProperty,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isNonNullObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function requireVoteRecord(value: unknown): Record<string, unknown> {
  if (!isNonNullObject(value)) {
    throw new Error('public-input vote must be an object');
  }

  return value;
}

function isStringMerklePath(value: unknown[] | undefined): value is string[] {
  return value !== undefined && value.every((node): node is string => typeof node === 'string');
}

function parseVote(value: unknown): InputCommitmentVote {
  const record = requireVoteRecord(value);

  const index = getNumberProperty(record, 'index');
  const commitment = getStringProperty(record, 'commitment');
  const merklePath = getArrayProperty(record, 'merklePath');
  if (index === undefined || commitment === undefined || !isStringMerklePath(merklePath)) {
    throw new Error('public-input vote has an invalid input-commitment projection');
  }

  return { index, commitment, merklePath };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = getStringProperty(record, key);
  if (value === undefined) {
    throw new Error(`public-input.${key} must be a string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = getNumberProperty(record, key);
  if (value === undefined) {
    throw new Error(`public-input.${key} must be a number`);
  }
  return value;
}

function requireFixturePathPair(first: string | undefined, second: string | undefined): [string, string] {
  if (!first || !second) {
    throw new Error(
      'Usage: entrypoint-duplicate-index-fixture <journal> <public-input> <output-journal> <output-public-input>',
    );
  }
  return [first, second];
}

function main(): void {
  const [sourceJournalPath, sourcePublicInputPath] = requireFixturePathPair(process.argv[2], process.argv[3]);
  const [outputJournalPath, outputPublicInputPath] = requireFixturePathPair(process.argv[4], process.argv[5]);

  const journal = readJsonRecord(sourceJournalPath, 'journal');
  const publicInput = readJsonRecord(sourcePublicInputPath, 'public-input');
  const sourceVotes = getArrayProperty(publicInput, 'votes');
  if (!sourceVotes || sourceVotes.length !== 1) {
    throw new Error('source public-input must contain exactly one vote');
  }

  const firstVote = parseVote(sourceVotes[0]);
  const duplicateIndexVote: InputCommitmentVote = {
    index: firstVote.index,
    commitment: `0x${'11'.repeat(32)}`,
    merklePath: [`0x${'22'.repeat(32)}`],
  };
  const votes = canonicalizeInputCommitmentVotesForEncoding([duplicateIndexVote, firstVote]);
  const inputCommitment = computeInputCommitmentFromPublicInput({
    electionId: requireString(publicInput, 'electionId'),
    bulletinRoot: requireString(publicInput, 'bulletinRoot'),
    treeSize: requireNumber(publicInput, 'treeSize'),
    totalExpected: requireNumber(publicInput, 'totalExpected'),
    votes,
  });

  writeFileSync(outputPublicInputPath, JSON.stringify({ ...publicInput, votes }));
  writeFileSync(outputJournalPath, JSON.stringify({ ...journal, inputCommitment }));
}

main();
