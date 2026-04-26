#!/usr/bin/env tsx
/**
 * Test API Merkle operations directly
 */

import { randomBytes } from 'crypto';
import { computeCommitment } from '../src/lib/zkvm/types';
import { verifyCTMerkleInclusion } from '../src/lib/verification/merkle';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function ensureRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    throw new Error(`${label} response is empty`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

function buildSessionHeaders(sessionId: string, capabilityToken: string): Record<string, string> {
  return {
    'X-Session-ID': sessionId,
    'X-Session-Capability': capabilityToken,
  };
}

async function waitForFinalizationResult(
  baseUrl: string,
  sessionId: string,
  capabilityToken: string,
): Promise<JsonRecord> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/status`, {
      headers: buildSessionHeaders(sessionId, capabilityToken),
    });
    const statusPayload = await readJson(statusRes, 'Session status');
    const statusData = ensureRecord(statusPayload, 'Session status response');
    const finalizationState = statusData.finalizationState;
    const finalizationResult = statusData.finalizationResult;

    if (isRecord(finalizationState) && typeof finalizationState.status === 'string') {
      console.log(`   Finalization status: ${finalizationState.status}`);
      if (finalizationState.status === 'failed' || finalizationState.status === 'timeout') {
        throw new Error(`Finalization failed with status ${finalizationState.status}`);
      }
    }

    if (isRecord(finalizationResult)) {
      return finalizationResult;
    }
  }

  throw new Error('Timed out waiting for finalization result');
}

async function testAPIMerkle() {
  const baseUrl = 'http://localhost:3000';

  // Set environment to use mock store
  process.env.USE_MOCK_STORE = 'true';
  process.env.USE_MOCK_ZKVM = 'true';

  console.log('=== API Merkle Test ===\n');

  // Step 1: Create session
  console.log('1. Creating session...');
  const sessionRes = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const sessionPayload = await readJson(sessionRes, 'Session');
  const sessionData = ensureRecord(sessionPayload, 'Session response');
  const sessionBody = ensureRecord(sessionData.data, 'Session response data');
  const sessionId = ensureString(sessionBody.sessionId, 'sessionId');
  const capabilityToken = ensureString(sessionBody.capabilityToken, 'capabilityToken');
  const electionId = ensureString(sessionBody.electionId, 'electionId');
  console.log('   Session ID:', sessionId);

  // Step 2: Submit user vote
  console.log('\n2. Submitting user vote...');
  const userRandom = `0x${randomBytes(32).toString('hex')}`;
  const userCommitment = computeCommitment(electionId, 0, userRandom);

  const voteRes = await fetch(`${baseUrl}/api/vote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildSessionHeaders(sessionId, capabilityToken),
    },
    body: JSON.stringify({
      commitment: userCommitment,
      vote: 'A',
      rand: userRandom,
    }),
  });

  const votePayload = await readJson(voteRes, 'Vote');
  const voteData = ensureRecord(votePayload, 'Vote response');
  const voteBody = ensureRecord(voteData.data, 'Vote response data');
  const voteId = ensureString(voteBody.voteId, 'voteId');
  const bulletinIndex = ensureNumber(voteBody.bulletinIndex, 'bulletinIndex');
  console.log('   Commitment:', userCommitment.slice(0, 8) + '...');
  console.log('   Vote ID:', voteId);
  console.log('   Bulletin index:', bulletinIndex);

  // Step 3: Wait for bot votes
  console.log('\n3. Waiting for bot votes...');
  let count = 0;
  let total = 63;
  while (count < total) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const progressRes = await fetch(`${baseUrl}/api/progress`, {
      headers: buildSessionHeaders(sessionId, capabilityToken),
    });
    const progressPayload = await readJson(progressRes, 'Progress');
    const progressData = ensureRecord(progressPayload, 'Progress response');
    const progressBody = ensureRecord(progressData.data, 'Progress response data');
    count = ensureNumber(progressBody.count, 'count');
    total = ensureNumber(progressBody.total, 'total');

    if (count % 20 === 0 || count === total) {
      console.log(`   Bot count: ${count}/${total}`);
    }
  }

  // Step 4: Finalize
  console.log('\n4. Finalizing session...');
  const turnstileToken = process.env.TURNSTILE_TOKEN;
  const finalizeRes = await fetch(`${baseUrl}/api/finalize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildSessionHeaders(sessionId, capabilityToken),
    },
    body: JSON.stringify({
      scenarioId: 'S0',
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });

  const finalizePayload = await readJson(finalizeRes, 'Finalize');
  const finalizeData = ensureRecord(finalizePayload, 'Finalize response');
  let finalizeResult: JsonRecord;

  if (finalizeRes.status === 202) {
    console.log('   Finalize accepted asynchronously; polling status endpoint...');
    finalizeResult = await waitForFinalizationResult(baseUrl, sessionId, capabilityToken);
  } else {
    const finalizeBody = ensureRecord(finalizeData.data, 'Finalize response data');
    finalizeResult = finalizeBody;
  }

  const bulletinRoot = ensureString(finalizeResult.bulletinRoot, 'bulletinRoot');
  const tally = ensureRecord(finalizeResult.tally, 'tally');
  console.log('   Bulletin root:', bulletinRoot);
  console.log('   Tally:', tally.counts);

  // Step 5: Verify Merkle inclusion
  console.log('\n5. Verifying Merkle inclusion...');
  const proofRes = await fetch(`${baseUrl}/api/bulletin/${voteId}/proof`, {
    headers: buildSessionHeaders(sessionId, capabilityToken),
  });
  const proofPayload = await readJson(proofRes, 'Bulletin proof');
  const proofData = ensureRecord(proofPayload, 'Bulletin proof response');
  const merklePath = ensureStringArray(proofData.merklePath, 'Bulletin proof merklePath');
  const proofIndex = ensureNumber(proofData.bulletinIndex, 'Bulletin proof bulletinIndex');
  const treeSize = ensureNumber(proofData.treeSize, 'Bulletin proof treeSize');
  const proofRoot = ensureString(proofData.bulletinRootAtCast, 'Bulletin proof bulletinRootAtCast');

  const isValid = verifyCTMerkleInclusion(userCommitment, merklePath, proofIndex, proofRoot, treeSize);

  console.log('   Result:', isValid ? '✅ VALID' : '❌ INVALID');

  return isValid;
}

// Run if executed directly
if (require.main === module) {
  testAPIMerkle()
    .then((valid) => {
      console.log('\nTest', valid ? 'PASSED' : 'FAILED');
      process.exit(valid ? 0 : 1);
    })
    .catch((error) => {
      console.error('Error:', error);
      process.exit(1);
    });
}
