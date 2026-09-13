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
  isRecord,
} from '@stark-ballot/validation/unknown-value-guards';

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseVote(value: unknown): InputCommitmentVote {
  if (!isRecord(value)) {
    throw new Error('public-input vote must be an object');
  }

  const index = getNumberProperty(value, 'index');
  const commitment = getStringProperty(value, 'commitment');
  const merklePath = getArrayProperty(value, 'merklePath');
  if (
    index === undefined ||
    commitment === undefined ||
    merklePath === undefined ||
    !merklePath.every((node): node is string => typeof node === 'string')
  ) {
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

function main(): void {
  const [sourceJournalPath, sourcePublicInputPath, outputJournalPath, outputPublicInputPath] = process.argv.slice(2);
  if (!sourceJournalPath || !sourcePublicInputPath || !outputJournalPath || !outputPublicInputPath) {
    throw new Error(
      'Usage: entrypoint-duplicate-index-fixture <journal> <public-input> <output-journal> <output-public-input>',
    );
  }

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
