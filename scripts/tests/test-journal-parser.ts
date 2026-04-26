#!/usr/bin/env npx tsx
import { parseJournalBytes, formatVoteCounts } from '../../src/lib/verification/journal-parser';
import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function testScenario(scenario: string) {
  console.log(`\n=== Testing ${scenario} ===`);

  const receiptPath = path.join(process.cwd(), 'zkvm', 'test-data', `test-${scenario}-receipt.json`);
  const receiptText = await fs.readFile(receiptPath, 'utf-8');
  const receiptData = parseJson(receiptText);

  if (!isRecord(receiptData)) {
    console.error('Invalid receipt data');
    return;
  }

  const journal = receiptData.journal;
  if (!isRecord(journal) || !isNumberArray(journal.bytes)) {
    console.error('No journal bytes found');
    return;
  }

  try {
    const journalData = parseJournalBytes(journal.bytes);

    console.log('Vote counts:', formatVoteCounts(journalData.verifiedTally));
    console.log('Total votes:', journalData.totalVotes);
    console.log('Merkle root:', journalData.bulletinRoot);
    console.log('Tamper detected:', journalData.tamperDetected);
  } catch (error) {
    console.error('Parse error:', error);
  }
}

async function main() {
  const scenarios = [
    's0-notamper',
    's1-ignore-user',
    's2-recount-user',
    's3-ignore-bot',
    's4-recount-bot',
    's5-random',
  ];

  for (const scenario of scenarios) {
    await testScenario(scenario);
  }
}

main().catch(console.error);
